// Upload ingestion pipeline:
//   validate -> dedupe -> persist temp -> extract -> normalize -> chunk ->
//   embed (batched, best-effort) -> commit file -> persist doc+chunks atomically.
//
// Failure handling: any error removes the temp/final file, records a `failed`
// document row (observability + a clean "nothing searchable was created"), and
// rethrows an HTTP-shaped error. A crash between file write and DB commit leaves
// at most an orphan temp file, which is swept on the next startup.

const crypto = require("crypto");
const { readConfig } = require("./config");
const fileStore = require("./storage");
const { extractDocument, httpError } = require("./extract");
const { chunkPages } = require("./chunk");
const { detectUploadType } = require("../validate");
const embeddings = require("../embeddings");
const { classifyContent, persistFacts } = require("../extract");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function embedChunks(texts, batchSize) {
  try {
    await embeddings.getImpl();
    if (!embeddings.isDense()) return null;
    const out = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const vecs = await embeddings.embedMany(batch);
      if (!vecs || vecs.length !== batch.length) throw new Error("embedding batch mismatch");
      out.push(...vecs);
    }
    return out;
  } catch (err) {
    // Non-fatal: chunks persist without vectors and are backfilled (or ranked
    // lexically) at search time.
    console.warn(`[documents] chunk embedding failed: ${err.message}`);
    return null;
  }
}

function findPreviousVersion(db, containerTag, filename, hash) {
  const prior = db
    .listDocuments(containerTag)
    .filter(
      (d) =>
        d.source === "upload" &&
        d.filename === filename &&
        d.status === "ready" &&
        d.contentHash !== hash
    )
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return prior ? prior.id : null;
}

function persistFailed(db, base, errorCode) {
  const doc = {
    ...base,
    content: "",
    embedding: null,
    status: "failed",
    errorCode,
    pageCount: null,
    storageKey: null,
    chunkCount: 0,
    updatedAt: base.createdAt,
    previousDocumentId: null,
  };
  try {
    // A failed document produced no vector, so it must not record an embedding
    // provider/model. Pass an explicit empty space rather than letting storage
    // stamp the configured provider (which may not have initialized yet on the
    // failure path, since extraction can fail before the first embedding call).
    db.addDocument(doc, { provider: null, model: null });
    return doc;
  } catch {
    return null;
  }
}

async function ingestUpload({ db, containerTag, filename, declaredMime, buffer, extractFacts = false }) {
  const cfg = readConfig();

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw httpError(400, "empty_upload", "file is empty");
  }
  if (buffer.length > cfg.maxUploadBytes) {
    throw httpError(413, "upload_too_large", "file too large");
  }

  const detected = detectUploadType({ filename, declaredMime, buffer });
  if (!detected.ok) throw httpError(detected.status, "invalid_upload", detected.error);

  const now = new Date();
  const hash = sha256(buffer);

  // Duplicate policy: identical bytes in the same container return the existing
  // ready document and create no new chunks.
  const existing = db.findDocumentByHash(containerTag, hash);
  if (existing) {
    return {
      document: existing,
      chunks: db.listChunksByDocument(existing.id, containerTag),
      duplicate: true,
      derivedMemories: [],
    };
  }

  const docId = crypto.randomUUID();
  const ext = detected.ext.replace(/^\./, "");
  const base = {
    id: docId,
    containerTag,
    createdAt: now.toISOString(),
    source: "upload",
    filename: detected.filename,
    mediaType: detected.mediaType,
    byteSize: buffer.length,
    contentHash: hash,
  };

  const tempPath = fileStore.writeTemp(buffer);
  let storageKey = null;

  try {
    const extracted = await extractDocument(buffer, detected.adapter);
    const text = extracted.pages
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n\n");

    if (!text) throw httpError(422, "no_text", "no extractable text found");
    if (text.length > cfg.maxExtractedChars) {
      throw httpError(413, "too_much_text", "extracted text is too large");
    }

    const pieces = chunkPages(extracted.pages, {
      size: cfg.chunkSize,
      overlap: cfg.chunkOverlap,
    });
    if (pieces.length === 0) throw httpError(422, "no_text", "no extractable text found");
    if (pieces.length > cfg.maxChunks) {
      throw httpError(413, "too_many_chunks", "document produced too many chunks");
    }

    const vectors = await embedChunks(pieces.map((p) => p.text), cfg.embedBatchSize);

    // Optional, explicit fact extraction. Off by default so a document is never
    // silently turned into personal memories.
    let facts = null;
    let provider = null;
    if (extractFacts) {
      try {
        const result = await classifyContent(text.slice(0, 200_000));
        facts = result.facts;
        provider = result.provider;
      } catch (err) {
        console.warn(`[documents] optional fact extraction failed: ${err.message}`);
        facts = null;
      }
    }

    storageKey = fileStore.commit(tempPath, docId, ext);

    const doc = {
      ...base,
      content: text,
      embedding: null,
      status: "ready",
      errorCode: null,
      pageCount: extracted.pageCount,
      storageKey,
      chunkCount: pieces.length,
      updatedAt: now.toISOString(),
      previousDocumentId: findPreviousVersion(db, containerTag, detected.filename, hash),
    };

    const chunks = pieces.map((p, i) => ({
      id: crypto.randomUUID(),
      documentId: docId,
      containerTag,
      chunkIndex: p.chunkIndex,
      page: p.page,
      charStart: p.charStart,
      charEnd: p.charEnd,
      text: p.text,
      createdAt: now.toISOString(),
      embedding: vectors ? vectors[i] || null : null,
    }));

    let derivedMemories = [];
    db.transaction(() => {
      db.addDocument(doc);
      for (const chunk of chunks) db.addChunk(chunk);
      if (facts && facts.length) {
        derivedMemories = persistFacts({
          documentId: docId,
          containerTag,
          facts,
          db,
          now,
          extractedBy: provider,
          embeddings: null,
        });
      }
    });

    return { document: doc, chunks, duplicate: false, derivedMemories };
  } catch (err) {
    // Cleanup must never mask the original failure, and must not claim success
    // when a filesystem delete fails. Only safe codes are logged — never a raw
    // error message (which can carry an absolute path) or file contents.
    const cleanupCodes = [];
    try {
      fileStore.removeTemp(tempPath);
    } catch (cleanupErr) {
      cleanupCodes.push((cleanupErr && cleanupErr.code) || "cleanup_failed");
    }
    if (storageKey) {
      try {
        fileStore.remove(storageKey);
      } catch (cleanupErr) {
        cleanupCodes.push((cleanupErr && cleanupErr.code) || "cleanup_failed");
      }
    }
    if (cleanupCodes.length) {
      console.warn(`[documents] cleanup incomplete (codes=${cleanupCodes.join(",")})`);
    }
    const code = err.code || "ingest_failed";
    const failed = persistFailed(db, base, code);
    if (failed) err.document = failed;
    throw err;
  }
}

module.exports = { ingestUpload, sha256 };

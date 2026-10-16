const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { mkTmp, rm } = require("./_support");
const { buildPdf } = require("./_pdf");

// Isolated, deterministic environment set BEFORE the app is required.
// Lexical embeddings + regex extraction keep everything offline and fast. Small
// limits let us exercise the size/page/chunk guards without giant fixtures.
const DIR = mkTmp();
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";
process.env.MAX_UPLOAD_BYTES = "65536";
process.env.MAX_PDF_PAGES = "10";
process.env.CHUNK_SIZE = "80";
process.env.CHUNK_OVERLAP = "10";

const { app } = require("../server");
const db = require("../lib/db");
const sqlite = require("../lib/storage/sqlite");
const { issueApiKey } = require("../lib/auth");

const UPLOAD_DIR = path.join(DIR, "uploads");

let server;
let base;
let KEY_A;
let KEY_B;

before(async () => {
  ({ key: KEY_A } = issueApiKey(db, { tenantId: "tenant_a", containerTag: "alpha" }));
  ({ key: KEY_B } = issueApiKey(db, { tenantId: "tenant_b", containerTag: "beta" }));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rm(DIR);
});

async function api(pathname, { key = KEY_A, headers = {}, ...opts } = {}) {
  const res = await fetch(base + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${key}`, ...headers },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function upload(filename, contentType, body, { key = KEY_A, query = "" } = {}) {
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": contentType };
  if (filename) headers["X-Recall-Filename"] = filename;
  const res = await fetch(`${base}/v1/documents/upload${query}`, {
    method: "POST",
    headers,
    body,
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

function storedFiles() {
  try {
    return fs.readdirSync(UPLOAD_DIR).filter((n) => n !== "tmp");
  } catch {
    return [];
  }
}

function chunkHits(body) {
  return (body.results || []).filter((r) => r.source === "chunk");
}

// ------------------------------------------------------------------ happy --

test("uploads a .txt file, chunks it, and results carry source attribution", async () => {
  const text =
    "The recall pipeline stores uploaded notes and chunks them for retrieval. " +
    "A zebra appears in this passage about document ingestion quality.";
  const { status, body } = await upload("notes.txt", "text/plain", text);

  assert.equal(status, 201);
  assert.equal(body.duplicate, false);
  assert.equal(body.document.status, "ready");
  assert.equal(body.document.source, "upload");
  assert.equal(body.document.filename, "notes.txt");
  assert.equal(body.document.mediaType, "text/plain");
  assert.equal(body.document.byteSize, Buffer.byteLength(text));
  assert.equal(body.document.pageCount, null);
  assert.ok(body.chunkCount >= 2, "small chunk size should yield several chunks");
  assert.equal(body.document.chunkCount, body.chunkCount);
  assert.ok(!("storageKey" in body.document), "internal path must not be exposed");

  const search = await api("/v1/search?q=zebra&containerTag=alpha&searchMode=documents");
  assert.equal(search.status, 200);
  const hit = chunkHits(search.body).find((r) => r.documentId === body.document.id);
  assert.ok(hit, "the uploaded content must be retrievable");
  assert.equal(hit.filename, "notes.txt");
  assert.equal(hit.page, null);
  assert.match(hit.text, /zebra/i);

  const detail = await api(`/v1/documents/${body.document.id}?containerTag=alpha`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.chunks.length, body.chunkCount);
  assert.deepEqual(
    detail.body.chunks.map((c) => c.chunkIndex),
    [...Array(body.chunkCount).keys()]
  );
  assert.ok(!("storageKey" in detail.body.document));
});

test("uploads a Markdown file", async () => {
  const { status, body } = await upload(
    "readme.md",
    "text/markdown",
    "# Title\n\nSome markdown content about falcons and retrieval."
  );
  assert.equal(status, 201);
  assert.equal(body.document.mediaType, "text/markdown");

  const search = await api("/v1/search?q=falcons&containerTag=alpha&searchMode=documents");
  assert.ok(chunkHits(search.body).some((r) => r.documentId === body.document.id));
});

test("uploads a PDF and preserves page numbers", async () => {
  const pdf = buildPdf(["Alpha page about cats", "Beta page about rockets"]);
  const { status, body } = await upload("report.pdf", "application/pdf", pdf);

  assert.equal(status, 201);
  assert.equal(body.document.mediaType, "application/pdf");
  assert.equal(body.document.pageCount, 2);

  const search = await api("/v1/search?q=rockets&containerTag=alpha&searchMode=documents");
  const hit = chunkHits(search.body).find((r) => r.documentId === body.document.id);
  assert.ok(hit, "PDF text must be retrievable");
  assert.equal(hit.page, 2, "the hit must be attributed to page 2");
  assert.match(hit.text, /rockets/i);
});

// -------------------------------------------------------------- rejection --

test("rejects a request with no filename", async () => {
  const { status, body } = await upload(null, "text/plain", "hello");
  assert.equal(status, 400);
  assert.match(body.error, /filename/i);
});

test("rejects an unsupported file type", async () => {
  const { status } = await upload("photo.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(status, 415);
});

test("rejects a content type that does not match the extension", async () => {
  const { status } = await upload("notes.txt", "application/pdf", "plain text here");
  assert.equal(status, 415);
});

test("rejects a fake extension via magic bytes (not really a PDF)", async () => {
  const { status, body } = await upload("fake.pdf", "application/pdf", "this is not a pdf");
  assert.equal(status, 415);
  assert.match(body.error, /valid PDF/i);
});

test("rejects binary bytes declared as text", async () => {
  const { status } = await upload("bin.txt", "text/plain", Buffer.from([0x00, 0x01, 0x02, 0x03]));
  assert.equal(status, 415);
});

test("rejects an empty file", async () => {
  const { status } = await upload("empty.txt", "text/plain", Buffer.alloc(0));
  assert.equal(status, 400);
});

test("rejects an oversized upload with 413", async () => {
  const { status, body } = await upload("big.txt", "text/plain", "a".repeat(70000));
  assert.equal(status, 413);
  assert.deepEqual(body, { error: "payload too large" });
});

test("a traversal filename is sanitized and cannot escape the upload directory", async () => {
  const { status, body } = await upload("../../etc/passwd.txt", "text/plain", "traversal probe");
  assert.equal(status, 201);
  assert.equal(body.document.filename, "passwd.txt");
  // The stored name is server-generated; the traversal string never became a path.
  if (body.document.status === "ready") {
    assert.ok(storedFiles().some((n) => n.startsWith(body.document.id)));
  }
});

// ---------------------------------------------------- parse failure + caps --

test("a malformed PDF fails cleanly: 422, a failed record, no chunks, no file", async () => {
  const before = storedFiles().length;
  const { status, body } = await upload(
    "broken.pdf",
    "application/pdf",
    Buffer.from("%PDF-1.4\nthis is not a valid pdf body")
  );
  assert.equal(status, 422);
  assert.equal(body.status, "failed");
  assert.ok(body.documentId, "the failed record id is reported");

  const detail = await api(`/v1/documents/${body.documentId}?containerTag=alpha`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.document.status, "failed");
  assert.equal(detail.body.document.errorCode, "pdf_unreadable");
  assert.equal(detail.body.chunks.length, 0);

  const search = await api("/v1/search?q=pdf&containerTag=alpha&searchMode=documents");
  assert.equal(chunkHits(search.body).filter((r) => r.documentId === body.documentId).length, 0);
  assert.equal(storedFiles().length, before, "no file should be left behind");
});

test("enforces the chunk-count ceiling", async () => {
  const original = process.env.MAX_CHUNKS;
  process.env.MAX_CHUNKS = "1";
  try {
    const { status, body } = await upload("many.txt", "text/plain", "sentence. ".repeat(60));
    assert.equal(status, 413);
    assert.equal(body.status, "failed");
  } finally {
    if (original === undefined) delete process.env.MAX_CHUNKS;
    else process.env.MAX_CHUNKS = original;
  }
});

test("enforces the PDF page ceiling", async () => {
  const original = process.env.MAX_PDF_PAGES;
  process.env.MAX_PDF_PAGES = "2";
  try {
    const pdf = buildPdf(["one", "two", "three"]);
    const { status, body } = await upload("long.pdf", "application/pdf", pdf);
    assert.equal(status, 413);
    assert.equal(body.status, "failed");
  } finally {
    process.env.MAX_PDF_PAGES = original;
  }
});

// ------------------------------------------------------ duplicates/versions --

test("re-uploading identical bytes is deduplicated", async () => {
  const text = "Deduplication content about otters in a river.";
  const first = await upload("dupe.txt", "text/plain", text);
  assert.equal(first.status, 201);
  assert.equal(first.body.duplicate, false);

  const second = await upload("dupe.txt", "text/plain", text);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.document.id, first.body.document.id);
  assert.equal(second.body.chunkCount, first.body.chunkCount);
  assert.equal(db.listChunksByDocument(first.body.document.id, "alpha").length, first.body.chunkCount);
});

test("changed content creates a new version linked to the previous one, both retained", async () => {
  const v1 = await upload("versioned.txt", "text/plain", "Version one talks about lobsters.");
  const v2 = await upload("versioned.txt", "text/plain", "Version two talks about penguins.");
  assert.equal(v1.status, 201);
  assert.equal(v2.status, 201);
  assert.equal(v2.body.document.previousDocumentId, v1.body.document.id);

  // previous_document_id is lineage, not supersession: the old version survives.
  const old = await api(`/v1/documents/${v1.body.document.id}?containerTag=alpha`);
  assert.equal(old.status, 200);
  assert.equal(old.body.document.status, "ready");
  const s1 = await api("/v1/search?q=lobsters&containerTag=alpha&searchMode=documents");
  assert.ok(chunkHits(s1.body).some((r) => r.documentId === v1.body.document.id));
});

// ------------------------------------------------------------- isolation --

test("documents are isolated between tenants", async () => {
  const up = await upload("secret.txt", "text/plain", "tenant A private content about wombats");
  const docId = up.body.document.id;

  // Another tenant cannot read the document, even naming its own container.
  const crossGet = await api(`/v1/documents/${docId}?containerTag=beta`, { key: KEY_B });
  assert.equal(crossGet.status, 404);

  // Another tenant cannot delete it.
  const crossDelete = await api(`/v1/documents/${docId}?containerTag=beta`, {
    key: KEY_B,
    method: "DELETE",
  });
  assert.equal(crossDelete.status, 404);
  assert.equal((await api(`/v1/documents/${docId}?containerTag=alpha`)).status, 200);

  // The other tenant's listing/search never shows it.
  const list = await api("/v1/documents?containerTag=beta", { key: KEY_B });
  assert.ok(list.body.documents.every((d) => d.containerTag === "beta"));

  // A tenant that does not own "alpha" is refused outright.
  const search = await api("/v1/search?q=wombats&containerTag=alpha", { key: KEY_B });
  assert.equal(search.status, 403);
});

// -------------------------------------------------------------- deletion --

test("deleting a document removes its chunks, its file and only its derived memories", async () => {
  const text = "I live in Berlin and I work as a backend engineer.";
  const up = await upload("facts.txt", "text/plain", text, { query: "?extractFacts=true" });
  assert.equal(up.status, 201);
  const docId = up.body.document.id;
  assert.ok(up.body.memoriesExtracted >= 1, "opt-in fact extraction should run");

  // An unrelated memory in the same container must survive the delete.
  await api("/v1/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "I enjoy hiking in the alps.", containerTag: "alpha" }),
  });

  const before = await api("/v1/memories?containerTag=alpha");
  const derived = before.body.memories.filter((m) => m.documentId === docId);
  assert.ok(derived.length >= 1, "derived memories are attributed to the source document");

  const file = storedFiles().find((n) => n.startsWith(docId));
  assert.ok(file, "the uploaded file should exist before deletion");

  const del = await api(`/v1/documents/${docId}?containerTag=alpha`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true });

  assert.equal((await api(`/v1/documents/${docId}?containerTag=alpha`)).status, 404);
  assert.equal(db.listChunksByDocument(docId, "alpha").length, 0);
  assert.ok(!storedFiles().includes(file), "the stored file must be removed");
  assert.equal(db.listMemories("alpha").filter((m) => m.documentId === docId).length, 0);

  const after = await api("/v1/memories?containerTag=alpha");
  assert.ok(after.body.memories.some((m) => /alps/i.test(m.text)), "unrelated memory is untouched");
});

test("deleting a missing document returns 404", async () => {
  const res = await api("/v1/documents/does-not-exist?containerTag=alpha", { method: "DELETE" });
  assert.equal(res.status, 404);
});

test("document id validation and unknown lookups", async () => {
  assert.equal((await api("/v1/documents/@@bad@@?containerTag=alpha")).status, 400);
  assert.equal((await api("/v1/documents/missing-id?containerTag=alpha")).status, 404);
});

// ------------------------------------------------------- persistence/regress --

test("uploaded chunks survive a reopen of the database", async () => {
  const up = await upload("persist.txt", "text/plain", "Persistent content about narwhals.");
  const other = sqlite.create({ file: path.join(DIR, "recall.db") });
  try {
    const doc = other.getDocument(up.body.document.id, "alpha");
    assert.ok(doc, "document metadata must be durable");
    const chunks = other.listChunksByDocument(up.body.document.id, "alpha");
    assert.equal(chunks.length, up.body.chunkCount);
    assert.ok(other.findDocumentByHash("alpha", doc.contentHash), "hash lookup must be durable");
  } finally {
    other.close();
  }
});

test("POST /v1/add behavior and shape are unchanged", async () => {
  const res = await api("/v1/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "I am a data engineer in Kyoto.", containerTag: "alpha" }),
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.document.id);
  // Raw-text documents must not gain upload metadata keys.
  assert.ok(!("source" in res.body.document));
  assert.ok(!("status" in res.body.document));

  const search = await api("/v1/search?q=Kyoto&containerTag=alpha&searchMode=documents");
  assert.ok(
    search.body.results.some((r) => r.source === "document"),
    "raw-text document search still works"
  );
});

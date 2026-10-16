const { test, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { mkTmp, rm } = require("./_support");

// Isolated, offline environment. The provider is lexical ("tfidf"), which is
// exactly the "embeddings absent" case we need to guarantee still retrieves.
const DIR = mkTmp();
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";

const db = require("../lib/db");
const embeddings = require("../lib/embeddings");
const search = require("../lib/search");

after(() => {
  db.close();
  rm(DIR);
});

function seedChunk(text) {
  const now = new Date().toISOString();
  const documentId = crypto.randomUUID();
  db.addDocument({
    id: documentId,
    containerTag: "rc",
    content: text,
    createdAt: now,
    embedding: null,
    source: "upload",
    filename: "f.txt",
    mediaType: "text/plain",
    byteSize: text.length,
    contentHash: crypto.randomUUID(),
    status: "ready",
    errorCode: null,
    pageCount: null,
    storageKey: null,
    chunkCount: 1,
    updatedAt: now,
    previousDocumentId: null,
  });
  db.addChunk({
    id: crypto.randomUUID(),
    documentId,
    containerTag: "rc",
    chunkIndex: 0,
    page: null,
    charStart: 0,
    charEnd: text.length,
    text,
    createdAt: now,
    embedding: null,
  });
  return documentId;
}

test("chunk ranking uses lexical scoring when the provider is lexical", async () => {
  const docId = seedChunk("A passage about volcanoes and geology.");
  const hits = await search.rankChunks("volcanoes", db.listChunks("rc"));
  assert.ok(hits.length >= 1, "lexical provider must still find the chunk");
  assert.equal(hits[0].item.documentId, docId);
});

test("chunk ranking falls back to lexical when embedding generation fails", async () => {
  const docId = seedChunk("A passage about glaciers and ice fields.");
  const origIsDense = embeddings.isDense;
  const origEmbed = embeddings.embed;
  // Simulate a dense provider that is configured and healthy enough to load,
  // but whose per-chunk embedding call fails (rate limit, OOM, network, ...).
  embeddings.isDense = () => true;
  embeddings.embed = async () => {
    throw new Error("provider down");
  };
  try {
    const hits = await search.rankChunks("glaciers", db.listChunks("rc"));
    assert.ok(hits.length >= 1, "retrieval must fall back to lexical, not return nothing");
    assert.equal(hits[0].item.documentId, docId);
  } finally {
    embeddings.isDense = origIsDense;
    embeddings.embed = origEmbed;
  }
});

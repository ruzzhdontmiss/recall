// Finding 1 regression: a stored vector from a foreign embedding space must
// never be scored against a query from the current space when re-embedding
// fails. The old and new spaces here have the SAME dimension, so a dimension
// check alone cannot catch the mismatch (this is the real Phase A situation:
// 768 -> 768 across the ONNX runtime bump).
//
// The tests drive the REAL search/ranking paths (search.rankChunks,
// search.searchDocuments, search.searchMemories) with a monkeypatched provider,
// so no hosted API or model download is involved. Foreign rows are seeded under
// a different EMBEDDINGS_PROVIDER so their recorded metadata is genuinely
// foreign; the search then runs under the local provider.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { mkTmp, rm } = require("./_support");

const DIR = mkTmp();
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf"; // no model loading; env is switched per test
process.env.EXTRACTION_PROVIDER = "regex";

const db = require("../lib/db");
const embeddings = require("../lib/embeddings");
const search = require("../lib/search");
const space = require("../lib/embeddings/space");
const { buildIndex } = require("../lib/tfidf");

after(() => {
  db.close();
  rm(DIR);
});

const NOW = "2024-01-01T00:00:00.000Z";
const LOCAL = { EMBEDDINGS_PROVIDER: "xenova", EMBEDDINGS_MODEL: undefined };
const FOREIGN = { EMBEDDINGS_PROVIDER: "openai", EMBEDDINGS_MODEL: undefined };

// A foreign-space vector with the SAME dimension as the query, deliberately not
// orthogonal to it: cos(STALE, QVEC) = 1/sqrt(2) ~ 0.7071. If the stale vector
// were (wrongly) scored, the hit would carry exactly this value.
const STALE = [1, 1, 0];
const QVEC = [1, 0, 0];
const DENSE_LEAK = Math.SQRT1_2;

function withEnv(patch) {
  const prev = {};
  for (const key of Object.keys(patch)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function patchEmbeddings(overrides) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = embeddings[key];
    embeddings[key] = overrides[key];
  }
  return () => {
    for (const key of Object.keys(overrides)) embeddings[key] = saved[key];
  };
}

function addUploadDoc(id, tag, content) {
  db.addDocument({
    id,
    containerTag: tag,
    content,
    createdAt: NOW,
    embedding: null,
    source: "upload",
    filename: "f.txt",
    mediaType: "text/plain",
    byteSize: content.length,
    contentHash: id,
    status: "ready",
    errorCode: null,
    pageCount: null,
    storageKey: null,
    chunkCount: 1,
    updatedAt: NOW,
    previousDocumentId: null,
  });
}

// Seed a document/chunk/memory whose recorded metadata belongs to a DIFFERENT
// space than the local provider used during the search.
function seedForeignDoc(id, tag, content) {
  const restore = withEnv(FOREIGN);
  try {
    db.addDocument({ id, containerTag: tag, content, createdAt: NOW, embedding: STALE });
  } finally {
    restore();
  }
}

function seedForeignChunk(docId, chunkId, tag, text) {
  const restore = withEnv(FOREIGN);
  try {
    addUploadDoc(docId, tag, "parent document");
    db.addChunk({
      id: chunkId,
      documentId: docId,
      containerTag: tag,
      chunkIndex: 0,
      page: null,
      charStart: 0,
      charEnd: text.length,
      text,
      createdAt: NOW,
      embedding: STALE,
    });
  } finally {
    restore();
  }
}

function seedForeignMemory(docId, memId, tag, text) {
  const restore = withEnv(FOREIGN);
  try {
    db.addDocument({ id: docId, containerTag: tag, content: "alpha", createdAt: NOW, embedding: null });
    db.addMemory({
      id: memId,
      documentId: docId,
      containerTag: tag,
      text,
      type: "note",
      slot: null,
      slotValue: null,
      status: "active",
      createdAt: NOW,
      expiresAt: null,
      supersedes: null,
      extractedBy: "regex",
      embedding: STALE,
    });
  } finally {
    restore();
  }
}

test("stale chunk whose re-embed throws is not scored; lexical fallback remains", async () => {
  const docId = "doc-chunk";
  const chunkId = "chunk-stale";
  const tag = "cs";
  seedForeignChunk(docId, chunkId, tag, "alpha beta gamma");
  const chunk = db.listChunks(tag).find((c) => c.id === chunkId);

  const restoreEnv = withEnv(LOCAL);
  const NEW = embeddings.describe();
  assert.equal(space.matches(chunk, NEW), false, "precondition: stored vector is foreign");
  const restoreEmb = patchEmbeddings({
    isDense: () => true,
    getImpl: async () => ({ kind: "xenova" }),
    embed: async (text, opts) => {
      if (opts && opts.isQuery) return QVEC;
      throw new Error("provider down");
    },
  });
  try {
    const hits = await search.rankChunks("alpha", [chunk]);
    assert.ok(
      !hits.some((h) => Math.abs(h.score - DENSE_LEAK) < 1e-9),
      "the foreign vector must never receive a dense score"
    );
    const expected = buildIndex([{ id: chunkId, text: chunk.text }])
      .score("alpha")
      .find((r) => r.id === chunkId);
    assert.ok(expected && expected.score > 0, "precondition: the query has a lexical match");
    assert.equal(hits.length, 1, "lexical fallback must still retrieve the chunk");
    assert.equal(hits[0].item.id, chunkId);
    assert.ok(Math.abs(hits[0].score - expected.score) < 1e-9, "score must be the lexical score");
  } finally {
    restoreEmb();
    restoreEnv();
  }
});

test("stale document whose re-embed returns a falsy vector is not scored", async () => {
  const id = "doc-falsy";
  const tag = "df";
  seedForeignDoc(id, tag, "alpha beta");
  const doc = db.listDocuments(tag).find((d) => d.id === id);

  const restoreEnv = withEnv(LOCAL);
  const NEW = embeddings.describe();
  assert.equal(space.matches(doc, NEW), false, "precondition: stored vector is foreign");
  const restoreEmb = patchEmbeddings({
    isDense: () => true,
    getImpl: async () => ({ kind: "xenova" }),
    embed: async (text, opts) => ((opts && opts.isQuery) ? QVEC : undefined),
  });
  try {
    const hits = await search.searchDocuments("alpha", [doc]);
    assert.equal(hits.length, 0, "a row that cannot be re-embedded must not be scored");
  } finally {
    restoreEmb();
    restoreEnv();
  }
});

test("stale memory whose re-embed returns a falsy vector is not scored", async () => {
  const docId = "doc-mem";
  const memId = "mem-falsy";
  const tag = "dm";
  seedForeignMemory(docId, memId, tag, "alpha beta");
  const mem = db.listMemories(tag).find((m) => m.id === memId);

  const restoreEnv = withEnv(LOCAL);
  const NEW = embeddings.describe();
  assert.equal(space.matches(mem, NEW), false, "precondition: stored vector is foreign");
  const restoreEmb = patchEmbeddings({
    isDense: () => true,
    getImpl: async () => ({ kind: "xenova" }),
    embed: async (text, opts) => ((opts && opts.isQuery) ? QVEC : undefined),
  });
  try {
    const hits = await search.searchMemories("alpha", [mem]);
    assert.equal(hits.length, 0, "a memory that cannot be re-embedded must not be scored");
  } finally {
    restoreEmb();
    restoreEnv();
  }
});

test("stale document whose re-embed throws is not scored", async () => {
  const id = "doc-throw";
  const tag = "dt";
  seedForeignDoc(id, tag, "alpha");
  const doc = db.listDocuments(tag).find((d) => d.id === id);

  const restoreEnv = withEnv(LOCAL);
  const restoreEmb = patchEmbeddings({
    isDense: () => true,
    getImpl: async () => ({ kind: "xenova" }),
    embed: async (text, opts) => {
      if (opts && opts.isQuery) return QVEC;
      throw new Error("provider down");
    },
  });
  try {
    const hits = await search.searchDocuments("alpha", [doc]);
    assert.equal(hits.length, 0, "a row whose re-embed throws must not be scored");
  } finally {
    restoreEmb();
    restoreEnv();
  }
});

test("a current-space vector is still scored (dense ranking is not disabled)", async () => {
  const id = "doc-ok";
  const tag = "dok";
  const restoreSeed = withEnv(LOCAL);
  try {
    db.addDocument({ id, containerTag: tag, content: "alpha", createdAt: NOW, embedding: [1, 0, 0] });
  } finally {
    restoreSeed();
  }

  const restoreEnv = withEnv(LOCAL);
  const NEW = embeddings.describe();
  const doc = db.listDocuments(tag).find((d) => d.id === id);
  assert.equal(space.matches(doc, NEW), true, "precondition: stored vector is current");
  const restoreEmb = patchEmbeddings({
    isDense: () => true,
    getImpl: async () => ({ kind: "xenova" }),
    embed: async () => [1, 0, 0],
  });
  try {
    const hits = await search.searchDocuments("alpha", [doc]);
    assert.equal(hits.length, 1, "a valid current-space vector must still be scored");
    assert.ok(hits[0].score > 0.99, "identical vectors must score ~1");
  } finally {
    restoreEmb();
    restoreEnv();
  }
});

test("a stale vector is re-embedded into the current space, persisted, then scored", async () => {
  const id = "doc-reembed";
  const tag = "dr";
  seedForeignDoc(id, tag, "alpha");

  const restoreEnv = withEnv(LOCAL);
  const NEW = embeddings.describe();
  const doc = db.listDocuments(tag).find((d) => d.id === id);
  const restoreEmb = patchEmbeddings({
    isDense: () => true,
    getImpl: async () => ({ kind: "xenova" }),
    embed: async () => [1, 0, 0],
  });
  try {
    const hits = await search.searchDocuments("alpha", [doc]);
    assert.equal(hits.length, 1, "the re-embedded row must be scored");
    const reloaded = db.getDocument(id, tag);
    assert.equal(space.matches(reloaded, NEW), true, "the persisted row must now be in the current space");
    assert.deepEqual(reloaded.embedding, [1, 0, 0]);
  } finally {
    restoreEmb();
    restoreEnv();
  }
});

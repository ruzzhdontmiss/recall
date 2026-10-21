const { test, after } = require("node:test");
const assert = require("node:assert");
const { mkTmp, rm } = require("./_support");

// Isolated, offline process. The dense vectors are stubbed so the test can
// control the dense ranking and prove that lexical evidence / the slot prior
// changes the order for the right reason.
const DIR = mkTmp("recall-rerank-");
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";

const db = require("../lib/db");
const embeddings = require("../lib/embeddings");
const search = require("../lib/search");

const NOW = "2024-01-01T00:00:00.000Z";
const unit = (x) => [x, Math.sqrt(1 - x * x)];

after(() => {
  db.close();
  rm(DIR);
});

function seedMemory(tag, id, text, slot = null) {
  const docId = `${id}-doc`;
  db.addDocument({
    id: docId,
    containerTag: tag,
    content: text,
    createdAt: NOW,
    embedding: null,
  });
  db.addMemory({
    id,
    documentId: docId,
    containerTag: tag,
    text,
    type: "static",
    slot,
    slotValue: null,
    status: "active",
    createdAt: NOW,
    expiresAt: null,
    embedding: null,
  });
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

function stubDense(vectorFor) {
  return patchEmbeddings({
    getImpl: async () => ({ kind: "xenova" }),
    isDense: () => true,
    embed: async (text, opts = {}) => {
      if (opts.isQuery) return [1, 0];
      return vectorFor(text) || [0, 1];
    },
  });
}

test("lexical evidence reranks a dense near-miss to the fact with the key term", async () => {
  const tag = "rerank-lexical";
  seedMemory(
    tag,
    "rerank-atlas",
    "Project Atlas uses PostgreSQL for its primary datastore."
  );
  seedMemory(
    tag,
    "rerank-apollo",
    "Project Apollo uses MongoDB for its primary datastore."
  );
  const restore = stubDense((text) => {
    if (/Atlas/.test(text)) return unit(1); // dense prefers Atlas
    if (/Apollo/.test(text)) return unit(0.9);
    return null;
  });
  try {
    const state = search.createRankingState();
    const hits = await search.searchMemories("MongoDB", db.listMemories(tag), state);
    assert.equal(hits[0].id, "rerank-apollo", "the MongoDB fact must win on lexical evidence");
    assert.equal(search.rankingMode(state), "hybrid");
  } finally {
    restore();
  }
});

test("a matching extracted slot gets a small prior when lexical overlap is silent", async () => {
  const tag = "rerank-slot";
  seedMemory(tag, "rerank-lisbon", "I now live in Lisbon.", "location");
  seedMemory(tag, "rerank-neovim", "I use Neovim as my editor.", "editor");
  const restore = stubDense((text) => {
    if (/Lisbon/.test(text)) return unit(0.95); // dense prefers Neovim
    if (/Neovim/.test(text)) return unit(1);
    return null;
  });
  try {
    const state = search.createRankingState();
    const hits = await search.searchMemories(
      "Where is the user based?",
      db.listMemories(tag),
      state
    );
    assert.equal(hits[0].id, "rerank-lisbon", "location intent must prefer the location slot");
    assert.equal(search.rankingMode(state), "hybrid");
  } finally {
    restore();
  }
});

test("documents and chunks are reranked on one shared lexical index before merge", async () => {
  const tag = "rerank-merge";
  const now = NOW;
  db.addDocument({
    id: "rerank-raw",
    containerTag: tag,
    content: "I'm a backend engineer.",
    createdAt: now,
    embedding: null,
  });
  db.addDocument({
    id: "rerank-upload",
    containerTag: tag,
    content: "incident runbook",
    createdAt: now,
    embedding: null,
    source: "upload",
    filename: "runbook.txt",
    mediaType: "text/plain",
    byteSize: 15,
    contentHash: "rerank-upload-hash",
    status: "ready",
    errorCode: null,
    pageCount: null,
    storageKey: null,
    chunkCount: 2,
    updatedAt: now,
    previousDocumentId: null,
  });
  db.addChunk({
    id: "rerank-correct-chunk",
    documentId: "rerank-upload",
    containerTag: tag,
    chunkIndex: 0,
    page: null,
    charStart: 0,
    charEnd: 62,
    text: "A sev1 incident pages the on-call engineer through Opsgenie.",
    createdAt: now,
    embedding: null,
  });
  db.addChunk({
    id: "rerank-other-chunk",
    documentId: "rerank-upload",
    containerTag: tag,
    chunkIndex: 1,
    page: null,
    charStart: 62,
    charEnd: 120,
    text: "The incident commander posts updates every thirty minutes.",
    createdAt: now,
    embedding: null,
  });

  const restore = stubDense((text) => {
    if (/backend engineer/.test(text)) return unit(1); // dense prefers the raw note
    if (/Opsgenie/.test(text)) return unit(0.95);
    if (/thirty minutes/.test(text)) return unit(0.5);
    return null;
  });
  try {
    const state = search.createRankingState();
    const raw = db.listDocuments(tag).find((d) => d.id === "rerank-raw");
    const upload = db.listDocuments(tag).find((d) => d.id === "rerank-upload");
    const hits = await search.searchDocumentsWithChunks({
      q: "What tool pages the on-call engineer for a sev1 incident?",
      docs: [raw],
      chunks: db.listChunks(tag),
      docById: new Map([[upload.id, upload]]),
      state,
    });
    assert.equal(
      hits[0].id,
      "rerank-correct-chunk",
      "the chunk with the query's key terms must win over the raw note"
    );
    assert.equal(search.rankingMode(state), "hybrid");
  } finally {
    restore();
  }
});

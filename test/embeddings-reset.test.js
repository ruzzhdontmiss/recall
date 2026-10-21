// Finding 3 regression: the embedding-space rollback mechanism. A plain
// code/dependency rollback is unsafe because the previous stack reused any
// non-empty vector. The reset must clear vectors (and the recorded space) for
// BOTH storage backends while preserving records, and it must be dry-run-first.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("node:child_process");
const sqlite = require("../lib/storage/sqlite");
const jsonStore = require("../lib/storage/json");
const { mkTmp, rm } = require("./_support");

const NOW = "2024-01-01T00:00:00.000Z";
const RESET_SCRIPT = path.join(__dirname, "..", "scripts", "reset-embeddings.js");

function seedStore(store) {
  store.addDocument({
    id: "d1",
    containerTag: "t",
    content: "hello world",
    createdAt: NOW,
    embedding: [1, 2, 3],
  });
  store.addMemory({
    id: "m1",
    documentId: "d1",
    containerTag: "t",
    text: "hello memory",
    type: "note",
    slot: null,
    slotValue: null,
    status: "active",
    createdAt: NOW,
    expiresAt: null,
    supersedes: null,
    extractedBy: "regex",
    embedding: [4, 5, 6],
  });
  store.addChunk({
    id: "c1",
    documentId: "d1",
    containerTag: "t",
    chunkIndex: 0,
    page: null,
    charStart: 0,
    charEnd: 5,
    text: "hello chunk",
    createdAt: NOW,
    embedding: [7, 8, 9],
  });
  store.setMeta("embedding_space", "xenova:Xenova/bge-base-en-v1.5@q8~r1");
}

test("sqlite: invalidateEmbeddings clears vectors + space, preserves records, is idempotent", (t) => {
  const dir = mkTmp();
  const store = sqlite.create({ file: path.join(dir, "recall.db") });
  t.after(() => {
    store.close();
    rm(dir);
  });
  seedStore(store);

  const { cleared } = store.invalidateEmbeddings();
  assert.equal(cleared, 3, "document + memory + chunk must all be cleared");

  assert.equal(store.documents[0].embedding, null);
  assert.equal(store.documents[0].embeddingProvider, null);
  assert.equal(store.documents[0].embeddingModel, null);
  assert.equal(store.documents[0].embeddingDim, null);
  assert.equal(store.memories[0].embedding, null);
  assert.equal(store.listChunks("t")[0].embedding, null);
  assert.equal(store.getMeta("embedding_space"), null, "the recorded space must be cleared");

  // Records and provenance are preserved.
  assert.equal(store.documents.length, 1);
  assert.equal(store.documents[0].content, "hello world");
  assert.equal(store.memories[0].text, "hello memory");
  assert.equal(store.listChunks("t")[0].text, "hello chunk");

  assert.equal(store.invalidateEmbeddings().cleared, 0, "second call is a no-op");
});

test("json: invalidateEmbeddings clears vectors + space, preserves records, persists", (t) => {
  const dir = mkTmp();
  const file = path.join(dir, "store.json");
  const store = jsonStore.create({ file });
  t.after(() => rm(dir));
  seedStore(store);

  const { cleared } = store.invalidateEmbeddings();
  assert.equal(cleared, 3);
  assert.equal(store.documents[0].embedding, null);
  assert.equal(store.memories[0].embedding, null);
  assert.equal(store.listChunks("t")[0].embedding, null);
  assert.equal(store.getMeta("embedding_space"), null);
  assert.equal(store.documents[0].content, "hello world");
  store.close();

  // The cleared state must be durable (parity with SQLite).
  const reopened = jsonStore.create({ file });
  t.after(() => reopened.close());
  assert.equal(reopened.documents[0].embedding, null);
  assert.equal(reopened.memories[0].embedding, null);
  assert.equal(reopened.getMeta("embedding_space"), null);
});

function runReset(dir, backend, args) {
  return spawnSync(process.execPath, [RESET_SCRIPT, ...args], {
    env: { ...process.env, DATA_DIR: dir, STORAGE_BACKEND: backend, EMBEDDINGS_PROVIDER: "tfidf" },
    encoding: "utf-8",
  });
}

test("reset script: dry run writes nothing, apply clears vectors (sqlite)", (t) => {
  const dir = mkTmp();
  t.after(() => rm(dir));
  const file = path.join(dir, "recall.db");
  const seeded = sqlite.create({ file });
  seedStore(seeded);
  seeded.close();

  const dry = runReset(dir, "sqlite", ["--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.match(dry.stdout, /DRY RUN/);

  const afterDry = sqlite.create({ file });
  assert.deepEqual(afterDry.documents[0].embedding, [1, 2, 3], "dry run must not clear vectors");
  assert.equal(afterDry.getMeta("embedding_space"), "xenova:Xenova/bge-base-en-v1.5@q8~r1");
  afterDry.close();

  const apply = runReset(dir, "sqlite", ["--apply"]);
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  assert.match(apply.stdout, /VERIFIED/);

  const after = sqlite.create({ file });
  assert.equal(after.documents[0].embedding, null);
  assert.equal(after.memories[0].embedding, null);
  assert.equal(after.listChunks("t")[0].embedding, null);
  assert.equal(after.getMeta("embedding_space"), null);
  assert.equal(after.documents[0].content, "hello world");
  after.close();
});

test("reset script: dry run writes nothing, apply clears vectors (json)", (t) => {
  const dir = mkTmp();
  t.after(() => rm(dir));
  const file = path.join(dir, "store.json");
  const seeded = jsonStore.create({ file });
  seedStore(seeded);
  seeded.close();

  const dry = runReset(dir, "json", ["--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.match(dry.stdout, /DRY RUN/);

  const afterDry = jsonStore.create({ file });
  assert.deepEqual(afterDry.documents[0].embedding, [1, 2, 3], "dry run must not clear vectors");
  afterDry.close();

  const apply = runReset(dir, "json", ["--apply"]);
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  assert.match(apply.stdout, /VERIFIED/);

  const after = jsonStore.create({ file });
  t.after(() => after.close());
  assert.equal(after.documents[0].embedding, null);
  assert.equal(after.memories[0].embedding, null);
  assert.equal(after.listChunks("t")[0].embedding, null);
  assert.equal(after.getMeta("embedding_space"), null);
  assert.equal(after.documents[0].content, "hello world");
});

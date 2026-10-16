const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const sqlite = require("../lib/storage/sqlite");
const { mkTmp, rm } = require("./_support");

function freshStore(t) {
  const dir = mkTmp();
  const file = path.join(dir, "recall.db");
  const store = sqlite.create({ file });
  t.after(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rm(dir);
  });
  return { store, file, dir };
}

const DOC = {
  id: "d1",
  containerTag: "u1",
  content: "hello world",
  createdAt: "2024-01-01T00:00:00.000Z",
};

const MEM = {
  id: "m1",
  documentId: "d1",
  containerTag: "u1",
  text: "hello world",
  type: "static",
  slot: "greeting",
  slotValue: "hello",
  status: "active",
  createdAt: "2024-01-01T00:00:00.000Z",
  expiresAt: null,
  supersedes: null,
  extractedBy: "regex",
};

test("CRUD: add, read, update embedding", (t) => {
  const { store } = freshStore(t);
  store.addDocument({ ...DOC, embedding: [1.5, -2.25, 0] });
  store.addMemory({ ...MEM, embedding: null });

  assert.equal(store.documents.length, 1);
  assert.equal(store.memories.length, 1);
  assert.deepEqual(store.documents[0].embedding, [1.5, -2.25, 0]);
  assert.equal(store.memories[0].embedding, null);

  const updated = store.updateEmbedding("memory", "m1", [0.5, 0.5]);
  assert.deepEqual(updated.embedding, [0.5, 0.5]);
  assert.deepEqual(store.memories[0].embedding, [0.5, 0.5]);
  assert.equal(store.updateEmbedding("memory", "nope", [1]), null);
});

test("vector validation rejects bad embeddings and never truncates", (t) => {
  const { store } = freshStore(t);
  assert.throws(() => store.addDocument({ ...DOC, embedding: ["x"] }), /finite/);
  assert.throws(() => store.addDocument({ ...DOC, id: "d2", embedding: [] }), /non-empty/);
  assert.throws(() => store.addDocument({ ...DOC, id: "d3", embedding: [1, NaN] }), /finite/);
  assert.equal(store.documents.length, 0);

  // full 768-dim round-trip preserves every value exactly
  const vec = Array.from({ length: 768 }, (_, i) => (i % 7) * 0.123456789);
  store.addDocument({ ...DOC, id: "d4", embedding: vec });
  assert.deepEqual(store.documents[0].embedding, vec);
});

test("forgetMemory enforces container ownership", (t) => {
  const { store } = freshStore(t);
  store.addDocument({ ...DOC });
  store.addMemory({ ...MEM });

  assert.equal(store.forgetMemory("m1", "OTHER"), null, "cross-container forget must not match");
  assert.equal(store.memories[0].status, "active");

  const forgotten = store.forgetMemory("m1", "u1");
  assert.equal(forgotten.status, "forgotten");
  assert.equal(store.memories[0].status, "forgotten");
});

test("transaction commits related writes atomically", (t) => {
  const { store, file } = freshStore(t);
  store.transaction(() => {
    store.addDocument({ ...DOC });
    store.addMemory({ ...MEM });
  });
  assert.equal(store.documents.length, 1);
  assert.equal(store.memories.length, 1);

  const reopened = sqlite.create({ file });
  assert.equal(reopened.documents.length, 1);
  assert.equal(reopened.memories.length, 1);
  reopened.close();
});

test("transaction rolls back both SQL and the in-memory mirror", (t) => {
  const { store, file } = freshStore(t);
  assert.throws(
    () =>
      store.transaction(() => {
        store.addDocument({ ...DOC, id: "keep-me" });
        throw new Error("boom");
      }),
    /boom/
  );
  assert.equal(store.documents.length, 0, "in-memory mirror must be reverted");

  const reopened = sqlite.create({ file });
  assert.equal(reopened.documents.length, 0, "on-disk rows must be reverted");
  reopened.close();
});

test("constraint failure inside a transaction reverts earlier writes", (t) => {
  const { store } = freshStore(t);
  store.addDocument({ ...DOC });
  assert.throws(() =>
    store.transaction(() => {
      store.addDocument({ ...DOC, id: "tmp", content: "tmp" });
      store.addDocument({ ...DOC }); // duplicate PK -> throws
    })
  );
  assert.deepEqual(
    store.documents.map((d) => d.id),
    ["d1"],
    "the temp row must be rolled back"
  );
});

test("data and vectors survive close/reopen", (t) => {
  const { store, file } = freshStore(t);
  const vec = [0.25, 0.5, 0.75, 1];
  store.addDocument({ ...DOC, embedding: vec });
  store.addMemory({ ...MEM, embedding: vec });
  store.close();

  const reopened = sqlite.create({ file });
  assert.deepEqual(reopened.documents[0].embedding, vec);
  assert.deepEqual(reopened.memories[0].embedding, vec);
  assert.equal(reopened.memories[0].slot, "greeting");
  reopened.close();
});

test("embedding dimension metadata is stored", (t) => {
  const { store, file } = freshStore(t);
  store.addDocument({ ...DOC, embedding: [1, 2, 3] });
  const row = store.db.prepare("SELECT embedding_dim, embedding_provider FROM documents").get();
  assert.equal(row.embedding_dim, 3);
  assert.ok(typeof row.embedding_provider === "string" && row.embedding_provider.length > 0);
});

test("reset clears all rows", (t) => {
  const { store } = freshStore(t);
  store.addDocument({ ...DOC });
  store.addMemory({ ...MEM });
  store.reset();
  assert.equal(store.documents.length, 0);
  assert.equal(store.memories.length, 0);
});

test("a second connection's writes are visible after reload", (t) => {
  const { store, file } = freshStore(t);
  const other = sqlite.create({ file });
  other.addDocument({ ...DOC, id: "external" });
  other.close();

  assert.equal(store.documents.length, 0, "mirror is stale before reload");
  store.reload();
  assert.deepEqual(
    store.documents.map((d) => d.id),
    ["external"]
  );
});

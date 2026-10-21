// Findings 4 & 5 regression: the backfill must not record the embedding space
// before post-verification, must treat a failed or zero-row update as a failure,
// and a dry run must not modify row data or the recorded space.

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
const space = require("../lib/embeddings/space");
const backfill = require("../scripts/backfill-embeddings");

after(() => {
  db.close();
  rm(DIR);
});

const NOW = "2024-01-01T00:00:00.000Z";
const LOCAL = { EMBEDDINGS_PROVIDER: "xenova", EMBEDDINGS_MODEL: undefined };
const FOREIGN = { EMBEDDINGS_PROVIDER: "openai", EMBEDDINGS_MODEL: undefined };

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

function localSpace() {
  const restore = withEnv(LOCAL);
  try {
    return embeddings.describe();
  } finally {
    restore();
  }
}

function seedStale(id, tag, content) {
  const restore = withEnv(FOREIGN);
  try {
    db.addDocument({ id, containerTag: tag, content, createdAt: NOW, embedding: [0.1, 0.2, 0.3] });
  } finally {
    restore();
  }
}

function captureConsole() {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return {
    text: () => lines.join("\n"),
    restore() {
      console.log = saved.log;
      console.warn = saved.warn;
      console.error = saved.error;
    },
  };
}

// Run the real backfill main() in --apply mode under the local provider with a
// patched embed/update. Returns the exit code it set and the captured output;
// always restores global state.
async function runApply({ embed, updateEmbedding } = {}) {
  const restoreEnv = withEnv(LOCAL);
  const restoreEmbeddings = patchEmbeddings({
    isDense: () => true,
    getImpl: async () => ({ kind: "xenova" }),
    embed: embed || (async () => [1, 0, 0]),
  });
  const savedUpdate = db.updateEmbedding;
  if (updateEmbedding) db.updateEmbedding = updateEmbedding;
  const savedExit = process.exitCode;
  process.exitCode = 0;
  const cap = captureConsole();
  try {
    await backfill.main(["--apply"]);
  } finally {
    cap.restore();
    restoreEmbeddings();
    db.updateEmbedding = savedUpdate;
    restoreEnv();
  }
  const result = { exitCode: process.exitCode, output: cap.text() };
  process.exitCode = savedExit;
  return result;
}

test("dry run reports stale rows but writes nothing (meta + rows unchanged)", async (t) => {
  const id = "bf-dry";
  const tag = "bfd";
  seedStale(id, tag, "alpha dry run");
  t.after(() => db.deleteDocument(id, tag));
  assert.equal(db.getMeta("embedding_space"), null, "precondition: no recorded space");

  const restoreEnv = withEnv(LOCAL);
  const restoreEmbeddings = patchEmbeddings({
    isDense: () => true,
    getImpl: async () => ({ kind: "xenova" }),
    embed: async () => [1, 0, 0],
  });
  const cap = captureConsole();
  try {
    await backfill.main([]); // dry-run is the default
  } finally {
    cap.restore();
    restoreEmbeddings();
    restoreEnv();
  }

  assert.match(cap.text(), /DRY RUN/, "dry run must say so");
  assert.equal(db.getMeta("embedding_space"), null, "dry run must not record the space");
  assert.equal(
    space.matches(db.getDocument(id, tag), localSpace()),
    false,
    "dry run must not modify stored vectors"
  );
});

test("apply does not record the space when a re-embed fails", async (t) => {
  const id = "bf-fail";
  const tag = "bff";
  seedStale(id, tag, "alpha fail");
  t.after(() => {
    db.deleteDocument(id, tag);
    db.setMeta("embedding_space", null);
  });

  const r = await runApply({
    embed: async () => {
      throw new Error("provider down");
    },
  });

  assert.equal(r.exitCode, 1, "a failed reindex must exit non-zero");
  assert.equal(db.getMeta("embedding_space"), null, "a failed reindex must not record the space");
  assert.equal(
    space.matches(db.getDocument(id, tag), localSpace()),
    false,
    "the row must remain stale after a failed update"
  );
  assert.match(r.output, /VERIFICATION FAILED/);
});

test("apply treats a zero-row update as a failure and does not record the space", async (t) => {
  const id = "bf-zero";
  const tag = "bfz";
  seedStale(id, tag, "alpha zero");
  t.after(() => {
    db.deleteDocument(id, tag);
    db.setMeta("embedding_space", null);
  });

  const r = await runApply({ updateEmbedding: () => null });

  assert.equal(r.exitCode, 1, "a zero-row update must fail the reindex");
  assert.equal(db.getMeta("embedding_space"), null, "a zero-row update must not record the space");
  assert.match(r.output, /failed=1/, "the zero-row update must be counted as a failure");
  assert.match(r.output, /VERIFICATION FAILED/);
});

test("apply records the space only after a fully verified reindex", async (t) => {
  const id = "bf-ok";
  const tag = "bfo";
  seedStale(id, tag, "alpha ok");
  t.after(() => {
    db.deleteDocument(id, tag);
    db.setMeta("embedding_space", null);
  });

  const NEW = localSpace();
  const r = await runApply();

  assert.notEqual(r.exitCode, 1, "a successful reindex must not set a failure exit code");
  assert.equal(db.getMeta("embedding_space"), NEW.space, "the verified space must be recorded");
  assert.equal(space.matches(db.getDocument(id, tag), NEW), true, "the row must now be current");
  assert.match(r.output, /VERIFIED/);
});

// Finding A regression: startup must not claim a store is migrated when its
// vectors predate the embedding-space metadata. `checkEmbeddingSpace()` (the
// exact function the listen callback calls after warmup) must:
//   * warn and record nothing when vectors exist but no space is recorded
//     (a pre-Phase-A store, or an incomplete reindex);
//   * warn and preserve the recorded space when it differs from the active one;
//   * record the active space only for a store that is genuinely empty of
//     vectors, and only once a provider has actually loaded.
//
// The in-process tests drive the real production function against the real
// storage backend. The child-process tests cover the JSON backend and the full
// warmup + check path (mirroring the listen callback).

const { test, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("node:child_process");
const { mkTmp, rm } = require("./_support");

const DIR = mkTmp();
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf"; // no model loading in this process
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";

const db = require("../lib/db");
const embeddings = require("../lib/embeddings");
const { app } = require("../server");

const NOW = "2024-01-01T00:00:00.000Z";
const DENSE = "xenova:Xenova/bge-base-en-v1.5@q8~r2+tf4.3.1+ort1.30.0";

after(() => {
  db.close();
  rm(DIR);
});

// Capture console.warn output produced while fn runs.
function captureWarn(fn) {
  const saved = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.warn = saved;
  }
  return lines.join("\n");
}

// Temporarily replace exported embeddings functions (e.g. to simulate a loaded
// dense provider without downloading a model).
function patchEmbeddings(overrides) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = embeddings[k];
    embeddings[k] = overrides[k];
  }
  return () => {
    for (const k of Object.keys(overrides)) embeddings[k] = saved[k];
  };
}

function seedVectorDoc(id, tag) {
  db.addDocument({
    id,
    containerTag: tag,
    content: "alpha beta",
    createdAt: NOW,
    embedding: [1, 0, 0],
  });
}

test("legacy store with vectors and no recorded space warns and records nothing", () => {
  db.reset();
  seedVectorDoc("legacy", "t1");
  assert.equal(db.hasStoredVectors(), true, "precondition: a stored vector exists");
  assert.equal(db.getMeta("embedding_space"), null, "precondition: no space recorded");

  const out = captureWarn(() => app.checkEmbeddingSpace());

  assert.match(out, /no embedding space is recorded|legacy\/unknown/);
  assert.equal(
    db.getMeta("embedding_space"),
    null,
    "startup must not claim an unverified legacy store is migrated"
  );
});

test("empty store records the active space once a provider is loaded", async () => {
  db.reset();
  await embeddings.getImpl(); // tfidf: loads without a model
  assert.equal(embeddings.isInitialized(), true);
  assert.equal(db.hasStoredVectors(), false);

  const out = captureWarn(() => app.checkEmbeddingSpace());

  assert.equal(db.getMeta("embedding_space"), embeddings.activeSpace());
  assert.equal(out.trim(), "", "no warning for a genuinely fresh store");
});

test("empty store records a dense active space (simulated loaded provider)", () => {
  db.reset();
  const restore = patchEmbeddings({
    activeSpace: () => DENSE,
    isInitialized: () => true,
  });
  try {
    const out = captureWarn(() => app.checkEmbeddingSpace());
    assert.equal(db.getMeta("embedding_space"), DENSE);
    assert.equal(out.trim(), "");
  } finally {
    restore();
  }
});

test("empty store does not record a space while no provider is initialized", () => {
  db.reset();
  const restore = patchEmbeddings({
    activeSpace: () => "uninitialized",
    isInitialized: () => false,
  });
  try {
    captureWarn(() => app.checkEmbeddingSpace());
    assert.equal(
      db.getMeta("embedding_space"),
      null,
      "must not record the configured-but-unloaded provider"
    );
  } finally {
    restore();
  }
});

test("a recorded space differing from the active one warns and is not overwritten", async () => {
  db.reset();
  await embeddings.getImpl();
  seedVectorDoc("diff", "t2");
  const OLD = "xenova:Xenova/bge-base-en-v1.5@q8~r1";
  db.setMeta("embedding_space", OLD);

  const out = captureWarn(() => app.checkEmbeddingSpace());

  assert.match(out, /different space/);
  assert.equal(db.getMeta("embedding_space"), OLD, "recorded evidence must be preserved");
});

test("a recorded space matching the active one is silent", async () => {
  db.reset();
  await embeddings.getImpl();
  seedVectorDoc("match", "t3");
  db.setMeta("embedding_space", embeddings.activeSpace());

  const out = captureWarn(() => app.checkEmbeddingSpace());

  assert.equal(out.trim(), "");
  assert.equal(db.getMeta("embedding_space"), embeddings.activeSpace());
});

test("a failed reindex leaves vectors unrecorded and startup keeps warning", () => {
  // embeddings-backfill.test.js proves a failed/zero-row reindex never records
  // the space. Here we assert the *next startup* does not paper over that.
  db.reset();
  seedVectorDoc("failed-bf", "t4");
  assert.equal(db.getMeta("embedding_space"), null);

  const out = captureWarn(() => app.checkEmbeddingSpace());

  assert.match(out, /no embedding space is recorded/);
  assert.equal(db.getMeta("embedding_space"), null, "no misleading success metadata");
});

// --------------------------------------------------------------- child procs ---
// Mirror the listen callback end to end: warmup the provider, then run the
// startup space check. Covers the JSON backend for SQLite/JSON parity.
function runStartupChild({ backend = "sqlite", provider = "tfidf", seed = false }) {
  const script = `
const db = require("./lib/db");
const embeddings = require("./lib/embeddings");
const { app } = require("./server");
const warns = [];
const ow = console.warn;
console.warn = (...a) => warns.push(a.join(" "));
${
  seed
    ? `(function seed() {
const prev = process.env.EMBEDDINGS_PROVIDER;
process.env.EMBEDDINGS_PROVIDER = "openai";
try {
  db.addDocument({ id: "d1", containerTag: "t", content: "x", createdAt: new Date().toISOString(), embedding: [1, 0, 0] });
} finally { process.env.EMBEDDINGS_PROVIDER = prev; }
})();`
    : ""
}
(async () => {
  await embeddings.warmup();
  app.checkEmbeddingSpace();
  console.warn = ow;
  process.stdout.write("RESULT " + JSON.stringify({
    meta: db.getMeta("embedding_space"),
    hasVectors: db.hasStoredVectors(),
    isInitialized: embeddings.isInitialized(),
    activeSpace: embeddings.activeSpace(),
    warnedLegacy: warns.some((w) => /no embedding space is recorded/i.test(w)),
    warnedDifferent: warns.some((w) => /different space/i.test(w)),
  }) + "\\n");
  db.close();
})().catch((e) => { console.error(e); process.exit(1); });
`;
  const dir = mkTmp();
  const env = {
    ...process.env,
    DATA_DIR: dir,
    STORAGE_BACKEND: backend,
    EMBEDDINGS_PROVIDER: provider,
    EXTRACTION_PROVIDER: "regex",
    AUTH_MODE: "required",
  };
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  try {
    const res = spawnSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, ".."), env, encoding: "utf-8" });
    const line = (res.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `child produced no RESULT line (status=${res.status})\n${res.stdout}\n${res.stderr}`);
    return JSON.parse(line.slice("RESULT ".length));
  } finally {
    rm(dir);
  }
}

test("JSON: legacy store with vectors warns and records nothing (startup path)", () => {
  const out = runStartupChild({ backend: "json", provider: "tfidf", seed: true });
  assert.equal(out.hasVectors, true);
  assert.equal(out.meta, null);
  assert.equal(out.warnedLegacy, true);
});

test("JSON: empty store records the active space (startup path)", () => {
  const out = runStartupChild({ backend: "json", provider: "tfidf", seed: false });
  assert.equal(out.hasVectors, false);
  assert.equal(out.isInitialized, true);
  assert.equal(out.meta, out.activeSpace);
  assert.equal(out.warnedLegacy, false);
});

test("SQLite: warmup failure leaves an empty store unrecorded (startup path)", () => {
  const out = runStartupChild({ backend: "sqlite", provider: "openai", seed: false });
  assert.equal(out.isInitialized, false, "openai has no key in this child");
  assert.equal(out.activeSpace, "uninitialized");
  assert.equal(out.meta, null, "must not record the failed provider as an active space");
  assert.equal(out.warnedLegacy, false);
});

test("SQLite: legacy store with the provider unavailable still warns (startup path)", () => {
  const out = runStartupChild({ backend: "sqlite", provider: "openai", seed: true });
  assert.equal(out.hasVectors, true);
  assert.equal(out.meta, null);
  assert.equal(out.warnedLegacy, true);
});

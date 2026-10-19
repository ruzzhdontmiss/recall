// Finding B regression: a configured-but-unusable provider must never be
// reported as an active dense space. If a hosted provider fails to initialize
// (missing credentials), activeDescribe()/activeSpace() report an explicit
// uninitialized space instead of the configured dense one, and rows written
// during that state are not stamped as valid hosted embeddings. A successfully
// initialized hosted provider keeps its real identity.
//
// Every case runs in an isolated child process so the module's one-shot init
// state is clean, and no live API call is made (ready() only checks credentials).

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");

function mkTmp(prefix = "recall-hosted-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runChild(script, { provider, key, backend = "sqlite" } = {}) {
  const dir = mkTmp();
  const env = { ...process.env, DATA_DIR: dir, STORAGE_BACKEND: backend, EXTRACTION_PROVIDER: "regex" };
  // Never let an ambient key leak in: control credentials explicitly per test.
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  if (provider) env.EMBEDDINGS_PROVIDER = provider;
  if (key) env.OPENAI_API_KEY = key;
  try {
    const res = spawnSync(process.execPath, ["-e", script], { cwd: REPO, env, encoding: "utf-8" });
    const line = (res.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `child produced no RESULT line (status=${res.status})\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    return JSON.parse(line.slice("RESULT ".length));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Report the provider state after attempting initialization.
const INIT_SCRIPT = `
const e = require("./lib/embeddings");
(async () => {
  let rejected = null;
  try { await e.getImpl(); } catch (err) { rejected = err.message; }
  process.stdout.write("RESULT " + JSON.stringify({
    rejected,
    providerName: e.getProviderName(),
    isDense: e.isDense(),
    isInitialized: e.isInitialized(),
    describeSpace: e.describe().space,
    activeProvider: e.activeDescribe().provider,
    activeModel: e.activeDescribe().model,
    activeSpace: e.activeSpace(),
  }) + "\\n");
})();
`;

test("openai with no key: active space is uninitialized, not the configured dense space", () => {
  const out = runChild(INIT_SCRIPT, { provider: "openai" });
  assert.ok(out.rejected, "initialization must fail without a key");
  assert.equal(out.providerName, "uninitialized");
  assert.equal(out.isDense, false, "no dense provider is usable");
  assert.equal(out.isInitialized, false);
  assert.match(out.describeSpace, /^openai:/, "describe() still reports the configured space");
  assert.equal(out.activeProvider, "uninitialized", "must not claim openai is active");
  assert.equal(out.activeModel, null);
  assert.equal(out.activeSpace, "uninitialized");
  assert.notEqual(out.activeSpace, out.describeSpace);
});

test("gemini with no key: active space is uninitialized, not the configured dense space", () => {
  const out = runChild(INIT_SCRIPT, { provider: "gemini" });
  assert.ok(out.rejected, "initialization must fail without a key");
  assert.equal(out.providerName, "uninitialized");
  assert.equal(out.isDense, false);
  assert.equal(out.isInitialized, false);
  assert.match(out.describeSpace, /^gemini:/);
  assert.equal(out.activeSpace, "uninitialized");
});

test("rows written while the hosted provider is unusable are not stamped as hosted embeddings", () => {
  const script = `
const e = require("./lib/embeddings");
const db = require("./lib/db");
const space = require("./lib/embeddings/space");
(async () => {
  try { await e.getImpl(); } catch {}
  db.addDocument({ id: "d1", containerTag: "t", content: "x", createdAt: new Date().toISOString(), embedding: null });
  const d = db.getDocument("d1", "t");
  process.stdout.write("RESULT " + JSON.stringify({
    provider: d.embeddingProvider,
    model: d.embeddingModel,
    matchesConfigured: space.matches(d, e.describe()),
  }) + "\\n");
  db.close();
})();
`;
  const out = runChild(script, { provider: "openai" });
  assert.equal(out.provider, "uninitialized", "must not stamp the failed provider");
  assert.notEqual(out.provider, "openai");
  assert.equal(out.model, null);
  assert.equal(out.matchesConfigured, false, "the row is not reusable as the configured space");
});

test("a successfully initialized hosted provider (mock key) keeps its real identity", () => {
  const script = `
const e = require("./lib/embeddings");
const db = require("./lib/db");
const space = require("./lib/embeddings/space");
(async () => {
  await e.getImpl(); // ready() only checks that a key is present; no network call
  db.addDocument({ id: "d1", containerTag: "t", content: "x", createdAt: new Date().toISOString(), embedding: [1, 2] });
  const d = db.getDocument("d1", "t");
  process.stdout.write("RESULT " + JSON.stringify({
    providerName: e.getProviderName(),
    isDense: e.isDense(),
    isInitialized: e.isInitialized(),
    activeProvider: e.activeDescribe().provider,
    activeSpace: e.activeSpace(),
    describeSpace: e.describe().space,
    stampedProvider: d.embeddingProvider,
    matches: space.matches(d, e.describe()),
  }) + "\\n");
  db.close();
})();
`;
  const out = runChild(script, { provider: "openai", key: "sk-test-not-used" });
  assert.equal(out.providerName, "openai");
  assert.equal(out.isDense, true);
  assert.equal(out.isInitialized, true);
  assert.equal(out.activeProvider, "openai");
  assert.equal(out.activeSpace, "openai:text-embedding-3-small");
  assert.equal(out.describeSpace, out.activeSpace);
  assert.equal(out.stampedProvider, "openai", "a real hosted vector is stamped with its provider");
  assert.equal(out.matches, true);
});

test("the local fallback still reports lexical (tfidf), not the configured dense space", () => {
  const script = `
const e = require("./lib/embeddings");
(async () => {
  await e.getImpl();
  process.stdout.write("RESULT " + JSON.stringify({
    providerName: e.getProviderName(),
    isDense: e.isDense(),
    isInitialized: e.isInitialized(),
    activeSpace: e.activeSpace(),
    describeSpace: e.describe().space,
  }) + "\\n");
})();
`;
  const env = { provider: "xenova" };
  // Force the local provider to fail without a model download.
  const dir = mkTmp();
  const childEnv = {
    ...process.env,
    DATA_DIR: dir,
    STORAGE_BACKEND: "sqlite",
    EXTRACTION_PROVIDER: "regex",
    EMBEDDINGS_PROVIDER: env.provider,
    EMBEDDINGS_OFFLINE: "true",
    EMBEDDINGS_MODEL: "Xenova/does-not-exist-xyz",
  };
  try {
    const res = spawnSync(process.execPath, ["-e", script], { cwd: REPO, env: childEnv, encoding: "utf-8" });
    const line = (res.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `child produced no RESULT line\n${res.stdout}\n${res.stderr}`);
    const out = JSON.parse(line.slice("RESULT ".length));
    assert.equal(out.providerName, "tfidf");
    assert.equal(out.isDense, false);
    assert.equal(out.isInitialized, true, "lexical fallback is still an initialized provider");
    assert.equal(out.activeSpace, "tfidf");
    assert.match(out.describeSpace, /^xenova:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

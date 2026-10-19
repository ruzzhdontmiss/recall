// Stage 1 regression: a failed upload produced no vector, so it must never be
// stamped with an embedding provider/model — not the configured dense provider
// (which, before the first initialization attempt, activeDescribe() still
// reports) and not the "uninitialized" sentinel either. The failed row must keep
// its provenance, remain excluded from search, and a normal upload must be
// unaffected.
//
// Each case runs in an isolated child process: the embedding module's one-shot
// init state and the storage backend are process-global.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");

function mkTmp(prefix = "recall-failed-prov-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runChild(script, { provider, key, backend = "sqlite", extraEnv = {} } = {}) {
  const dir = mkTmp();
  const env = {
    ...process.env,
    DATA_DIR: dir,
    STORAGE_BACKEND: backend,
    EXTRACTION_PROVIDER: "regex",
    AUTH_MODE: "required",
  };
  // Never let an ambient key leak in: control credentials explicitly per test.
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  if (provider) env.EMBEDDINGS_PROVIDER = provider;
  if (key) env.OPENAI_API_KEY = key;
  Object.assign(env, extraEnv);
  try {
    const res = spawnSync(process.execPath, ["-e", script], { cwd: REPO, env, encoding: "utf-8" });
    const line = (res.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(
      line,
      `child produced no RESULT line (status=${res.status})\nstdout:${res.stdout}\nstderr:${res.stderr}`
    );
    return JSON.parse(line.slice("RESULT ".length));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A corrupt PDF fails extraction before any embedding call, so the failure is
// recorded during the pre-initialization window — the exact path the finding
// described.
const FAILED_UPLOAD_SCRIPT = `
const e = require("./lib/embeddings");
const db = require("./lib/db");
const { ingestUpload } = require("./lib/documents/ingest");
(async () => {
  let err = null;
  try {
    await ingestUpload({
      db,
      containerTag: "fp",
      filename: "broken.pdf",
      declaredMime: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 this is not a real pdf"),
    });
  } catch (e2) {
    err = e2;
  }
  const row = err && err.document ? db.getDocument(err.document.id, "fp") : null;
  process.stdout.write("RESULT " + JSON.stringify({
    threw: Boolean(err),
    errorCode: err && err.code,
    initialized: e.isInitialized(),
    providerName: e.getProviderName(),
    configuredProvider: e.activeDescribe().provider,
    row: row && {
      status: row.status,
      errorCode: row.errorCode,
      source: row.source,
      filename: row.filename,
      contentHash: row.contentHash,
      byteSize: row.byteSize,
      embedding: row.embedding,
      provider: row.embeddingProvider,
      model: row.embeddingModel,
      dim: row.embeddingDim,
    },
    chunkCount: row ? db.listChunksByDocument(row.id, "fp").length : -1,
  }) + "\\n");
  db.close();
})();
`;

test("a failed PDF upload records no embedding provider (configured dense provider, pre-init)", () => {
  const out = runChild(FAILED_UPLOAD_SCRIPT, { provider: "openai" });
  assert.equal(out.threw, true, "the corrupt PDF must fail ingestion");
  assert.equal(out.errorCode, "pdf_unreadable");
  // Precondition proving we exercised the pre-initialization window: the
  // configured provider is what activeDescribe() would report, yet it is not
  // initialized and nothing has been attempted.
  assert.equal(out.initialized, false);
  assert.equal(out.providerName, "uninitialized");
  assert.equal(out.configuredProvider, "openai");
  // The failed row is preserved with its provenance but claims no embedding.
  assert.ok(out.row, "the failed row must be recorded");
  assert.equal(out.row.status, "failed");
  assert.equal(out.row.errorCode, "pdf_unreadable");
  assert.equal(out.row.source, "upload");
  assert.equal(out.row.filename, "broken.pdf");
  assert.ok(out.row.contentHash, "content hash provenance is preserved");
  assert.ok(out.row.byteSize > 0, "byte size provenance is preserved");
  assert.equal(out.row.embedding, null);
  assert.equal(out.row.provider, null, "must not stamp the configured provider");
  assert.notEqual(out.row.provider, "openai");
  assert.equal(out.row.model, null);
  assert.equal(out.row.dim, null);
  assert.equal(out.chunkCount, 0, "a failed upload creates no searchable chunks");
});

test("a failed upload records no embedding provider after a failed init attempt too", () => {
  const script = `
const e = require("./lib/embeddings");
const db = require("./lib/db");
const { ingestUpload } = require("./lib/documents/ingest");
(async () => {
  try { await e.getImpl(); } catch {}
  let err = null;
  try {
    await ingestUpload({
      db, containerTag: "fp", filename: "broken.pdf",
      declaredMime: "application/pdf", buffer: Buffer.from("%PDF-1.4 nope"),
    });
  } catch (e2) { err = e2; }
  const row = err && err.document ? db.getDocument(err.document.id, "fp") : null;
  process.stdout.write("RESULT " + JSON.stringify({
    initialized: e.isInitialized(),
    activeProvider: e.activeDescribe().provider,
    provider: row && row.embeddingProvider,
    model: row && row.embeddingModel,
  }) + "\\n");
  db.close();
})();
`;
  const out = runChild(script, { provider: "openai" });
  assert.equal(out.initialized, false);
  assert.equal(out.activeProvider, "uninitialized");
  assert.equal(out.provider, null);
  assert.equal(out.model, null);
});

test("JSON backend parity: a failed upload records no embedding provider", () => {
  const out = runChild(FAILED_UPLOAD_SCRIPT, { provider: "openai", backend: "json" });
  assert.equal(out.threw, true);
  assert.ok(out.row, "the failed row must be recorded");
  assert.equal(out.row.status, "failed");
  assert.equal(out.row.filename, "broken.pdf");
  assert.equal(out.row.provider, null);
  assert.equal(out.row.model, null);
  assert.equal(out.row.dim, null);
  assert.equal(out.chunkCount, 0);
});

// End-to-end: a failed upload is never searchable, while a normal upload still
// ingests and is retrievable with provenance (lexical provider so the whole
// request path runs without a model download).
const SEARCH_SCRIPT = `
const { app } = require("./server");
const db = require("./lib/db");
const { issueApiKey } = require("./lib/auth");
const { buildPdf } = require("./test/_pdf");
(async () => {
  const { key } = issueApiKey(db, { tenantId: "fpseg", containerTag: "fpseg" });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = { authorization: "Bearer " + key };
  const upload = (name, body) =>
    fetch(base + "/v1/documents/upload?containerTag=fpseg", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/pdf", "x-recall-filename": name }, auth),
      body,
    });
  const badRes = await upload("broken.pdf", Buffer.from("%PDF-1.4 not a pdf"));
  const badBody = await badRes.json();
  const goodRes = await upload("good.pdf", buildPdf(["zebra quokka uniquely searchable payload"]));
  const goodBody = await goodRes.json();
  const searchRes = await fetch(
    base + "/v1/search?containerTag=fpseg&q=" + encodeURIComponent("zebra quokka"),
    { headers: auth }
  );
  const searchBody = await searchRes.json();
  const badRow = badBody.documentId ? db.getDocument(badBody.documentId, "fpseg") : null;
  // Uploaded content is ranked at chunk granularity, so a hit carries the
  // owning document id in documentId (raw-text docs carry it in id).
  const ids = (searchBody.results || []).map((r) => r.documentId || r.id);
  process.stdout.write("RESULT " + JSON.stringify({
    badStatus: badRes.status,
    badHasId: Boolean(badBody.documentId),
    badBodyStatus: badBody.status,
    badRowStatus: badRow && badRow.status,
    goodStatus: goodRes.status,
    goodDoc: goodBody.document && {
      status: goodBody.document.status,
      pageCount: goodBody.document.pageCount,
      chunkCount: goodBody.document.chunkCount,
    },
    goodChunkCount: goodBody.chunkCount,
    searchStatus: searchRes.status,
    badSearchable: badBody.documentId ? ids.includes(badBody.documentId) : null,
    goodSearchable: goodBody.document ? ids.includes(goodBody.document.id) : null,
    resultCount: ids.length,
  }) + "\\n");
  await new Promise((r) => server.close(r));
  db.close();
})();
`;

test("a failed upload is not searchable and a normal upload is unchanged", () => {
  const out = runChild(SEARCH_SCRIPT, { provider: "tfidf" });
  // Failed upload: rejected, recorded as failed, excluded from search.
  assert.equal(out.badStatus, 422, "a corrupt upload is rejected with 422");
  assert.equal(out.badHasId, true, "the failed document id is reported");
  assert.equal(out.badBodyStatus, "failed");
  assert.equal(out.badRowStatus, "failed");
  assert.equal(out.badSearchable, false, "a failed upload must never be searchable");
  // Normal upload: unchanged.
  assert.equal(out.goodStatus, 201);
  assert.equal(out.goodDoc.status, "ready");
  assert.equal(out.goodDoc.pageCount, 1);
  assert.equal(out.goodDoc.chunkCount, 1);
  assert.equal(out.goodChunkCount, 1);
  assert.equal(out.searchStatus, 200);
  assert.equal(out.goodSearchable, true, "the valid document is still searchable");
});

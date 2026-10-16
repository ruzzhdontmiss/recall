const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { mkTmp, rm } = require("./_support");

// Regression for the verification finding: a failed upload produced a document
// row with empty content, which leaked into document/hybrid search as an empty
// hit and was fed to the embedder (breaking providers that reject empty input).
const DIR = mkTmp();
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";

const { app } = require("../server");
const db = require("../lib/db");
const embeddings = require("../lib/embeddings");
const { issueApiKey } = require("../lib/auth");

let server;
let base;
let KEY;

before(async () => {
  ({ key: KEY } = issueApiKey(db, { tenantId: "search_fix", containerTag: "sfix" }));
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

async function api(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${KEY}`, ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("a failed upload cannot appear as an empty hit and is never embedded", async () => {
  // A ready raw-text document that search should keep working for.
  const add = await api("/v1/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "I work as a backend engineer in Osaka.", containerTag: "sfix" }),
  });
  assert.equal(add.status, 200);
  const readyId = add.body.document.id;

  // A malformed upload records a `failed` row (content "", chunkCount 0).
  const bad = await api("/v1/documents/upload", {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-Recall-Filename": "broken.pdf" },
    body: Buffer.from("%PDF-1.4 this is not a valid pdf body"),
  });
  assert.equal(bad.status, 422);
  const failedId = bad.body.documentId;
  assert.ok(failedId, "the failed row id is reported");

  // Failed rows stay visible in the listing (existing behaviour, unchanged).
  const list = await api("/v1/documents?containerTag=sfix");
  assert.ok(
    list.body.documents.some((d) => d.id === failedId && d.status === "failed"),
    "failed uploads remain visible in the document listing"
  );

  // Baseline (lexical provider): the ready document is found, the failed one is not.
  const base1 = await api("/v1/search?q=Osaka&containerTag=sfix&searchMode=documents");
  assert.equal(base1.status, 200);
  assert.ok(base1.body.results.some((r) => r.id === readyId));
  assert.ok(base1.body.results.every((r) => r.id !== failedId && r.text !== ""));

  // Simulate a hosted dense provider that rejects empty input.
  const orig = { getImpl: embeddings.getImpl, isDense: embeddings.isDense, embed: embeddings.embed };
  const seen = [];
  embeddings.getImpl = async () => ({});
  embeddings.isDense = () => true;
  embeddings.embed = async (text) => {
    seen.push(text);
    if (!text || !text.trim()) throw new Error("400: input must not be empty");
    return [1, 2, 3, 4]; // fixed vector => non-empty docs score 1.0
  };
  try {
    const docs = await api("/v1/search?q=Osaka&containerTag=sfix&searchMode=documents");
    assert.equal(docs.status, 200, "documents search must not 500 on a failed document");
    assert.ok(docs.body.results.some((r) => r.id === readyId), "ready document still ranks");
    assert.ok(
      docs.body.results.every((r) => r.id !== failedId && r.text !== ""),
      "no empty hit from the failed document"
    );

    const hybrid = await api("/v1/search?q=Osaka&containerTag=sfix&searchMode=hybrid");
    assert.equal(hybrid.status, 200, "hybrid search must not 500 on a failed document");
    assert.ok(hybrid.body.results.every((r) => r.id !== failedId && r.text !== ""));

    assert.ok(seen.length > 0, "the embedder was exercised");
    assert.ok(seen.every((t) => t && t.trim()), "the embedder must never receive empty input");
  } finally {
    embeddings.getImpl = orig.getImpl;
    embeddings.isDense = orig.isDense;
    embeddings.embed = orig.embed;
  }
});

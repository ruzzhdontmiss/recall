const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { mkTmp, rm } = require("./_support");

// Same ingestion behaviour, exercised against the legacy JSON backend so the
// rollback path keeps full document-and-chunk parity with SQLite.
const DIR = mkTmp();
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "json";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";
process.env.CHUNK_SIZE = "80";
process.env.CHUNK_OVERLAP = "10";

const { app } = require("../server");
const db = require("../lib/db");
const { issueApiKey } = require("../lib/auth");

let server;
let base;
let KEY_A;
let KEY_B;

before(async () => {
  ({ key: KEY_A } = issueApiKey(db, { tenantId: "json_a", containerTag: "jalpha" }));
  ({ key: KEY_B } = issueApiKey(db, { tenantId: "json_b", containerTag: "jbeta" }));
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

async function upload(filename, body, { key = KEY_A } = {}) {
  const res = await fetch(`${base}/v1/documents/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "text/plain",
      "X-Recall-Filename": filename,
    },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function api(pathname, { key = KEY_A, ...opts } = {}) {
  const res = await fetch(base + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${key}`, ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("json backend: upload, search, dedupe, isolation and delete", async () => {
  const up = await upload("jn.txt", "JSON backend content about hedgehogs.");
  assert.equal(up.status, 201);
  assert.equal(up.body.document.status, "ready");
  assert.ok(up.body.chunkCount >= 1);
  assert.ok(!("storageKey" in up.body.document));

  const search = await api("/v1/search?q=hedgehogs&containerTag=jalpha&searchMode=documents");
  assert.ok(
    search.body.results.some(
      (r) => r.source === "chunk" && r.documentId === up.body.document.id
    )
  );

  const detail = await api(`/v1/documents/${up.body.document.id}?containerTag=jalpha`);
  assert.equal(detail.body.chunks.length, up.body.chunkCount);

  const again = await upload("jn.txt", "JSON backend content about hedgehogs.");
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.document.id, up.body.document.id);

  const cross = await api(`/v1/documents/${up.body.document.id}?containerTag=jbeta`, { key: KEY_B });
  assert.equal(cross.status, 404);

  const file = fs
    .readdirSync(path.join(DIR, "uploads"))
    .find((n) => n !== "tmp" && n.startsWith(up.body.document.id));
  const del = await api(`/v1/documents/${up.body.document.id}?containerTag=jalpha`, {
    method: "DELETE",
  });
  assert.equal(del.status, 200);
  assert.equal(db.listChunksByDocument(up.body.document.id, "jalpha").length, 0);
  if (file) {
    assert.ok(!fs.existsSync(path.join(DIR, "uploads", file)), "stored file must be removed");
  }
});

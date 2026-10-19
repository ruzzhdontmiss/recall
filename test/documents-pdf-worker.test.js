// Stage 2 (Phase B): PDF processing is isolated, bounded and always cleaned up.
//
// Two layers are covered:
//   A. the runner + real extraction (in-process): page provenance, malformed
//      input, page/text ceilings, the concurrency bound, the deadline and worker
//      termination, startup/processing failures, and shutdown;
//   B. the end-to-end upload flow (isolated child processes, one per backend):
//      SQLite/JSON parity, concurrent ingestion, temp/stored-file cleanup after a
//      failure, and that a partially-ingested document is never searchable.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("node:child_process");
const { mkTmp, rm } = require("./_support");
const { buildPdf } = require("./_pdf");
const { extractDocument } = require("../lib/documents/extract");
const { createPdfRunner } = require("../lib/documents/pdf");

const REPO = path.join(__dirname, "..");
const WORKERS = path.join(__dirname, "fixtures", "workers");
const worker = (name) => path.join(WORKERS, name);

// ===================================================================== A ====

test("valid single-page PDF keeps page identity and count", async () => {
  const out = await extractDocument(buildPdf(["Only one page here"]), "pdf");
  assert.equal(out.pageCount, 1);
  assert.deepEqual(out.pages, [{ page: 1, text: "Only one page here" }]);
});

test("valid multi-page PDF keeps page order and numbering", async () => {
  const out = await extractDocument(buildPdf(["one zebra", "two yaks", "three ibex"]), "pdf");
  assert.equal(out.pageCount, 3);
  assert.deepEqual(
    out.pages.map((p) => p.page),
    [1, 2, 3]
  );
  assert.deepEqual(
    out.pages.map((p) => p.text),
    ["one zebra", "two yaks", "three ibex"]
  );
});

test("empty, truncated and malformed PDFs fail as unreadable", async () => {
  const inputs = [
    Buffer.alloc(0),
    Buffer.from("%PDF-1.4"),
    Buffer.from("%PDF-1.4\ntruncated body with no xref"),
  ];
  for (const buf of inputs) {
    await assert.rejects(
      extractDocument(buf, "pdf"),
      (err) => err.status === 422 && err.code === "pdf_unreadable",
      `expected pdf_unreadable for ${buf.length} byte input`
    );
  }
});

test("the page ceiling is enforced inside the worker", async () => {
  await assert.rejects(
    extractDocument(buildPdf(["a", "b", "c"]), "pdf", { maxPdfPages: 2 }),
    (err) => err.status === 413 && err.code === "pdf_too_many_pages"
  );
});

test("the extracted-text ceiling is enforced inside the worker", async () => {
  await assert.rejects(
    extractDocument(buildPdf(["x".repeat(500)]), "pdf", { maxExtractedChars: 10 }),
    (err) => err.status === 413 && err.code === "too_much_text"
  );
});

test("concurrency is bounded by maxConcurrent workers", async () => {
  const runner = createPdfRunner({ scriptPath: worker("echo-ok.js"), maxConcurrent: 2 });
  try {
    const jobs = Array.from({ length: 6 }, () =>
      runner.run({ timeoutMs: 5000, workerData: { ms: 120 } })
    );
    const out = await Promise.all(jobs);
    assert.equal(out.length, 6);
    assert.ok(out.every((r) => r.pageCount === 1));
    assert.equal(runner.stats().peakActive, 2, "never more than two workers at once");
    assert.equal(runner.stats().active, 0);
    assert.equal(runner.stats().live, 0);
  } finally {
    runner.shutdown();
  }
});

test("the queue is bounded: excess jobs are shed with 503 pdf_busy", async () => {
  const runner = createPdfRunner({
    scriptPath: worker("echo-ok.js"),
    maxConcurrent: 1,
    maxQueued: 2,
  });
  try {
    const running = [0, 1, 2].map(() =>
      runner.run({ timeoutMs: 5000, workerData: { ms: 200 } })
    );
    await assert.rejects(
      runner.run({ timeoutMs: 5000, workerData: { ms: 1 } }),
      (err) => err.status === 503 && err.code === "pdf_busy"
    );
    await Promise.all(running);
  } finally {
    runner.shutdown();
  }
});

test("a job that exceeds its deadline is terminated", async () => {
  const runner = createPdfRunner({ scriptPath: worker("hang.js"), maxConcurrent: 1 });
  try {
    const started = Date.now();
    await assert.rejects(
      runner.run({ timeoutMs: 150, workerData: {} }),
      (err) => err.status === 422 && err.code === "pdf_timeout"
    );
    assert.ok(Date.now() - started < 3000, "must fail at the deadline, not hang");
    assert.equal(runner.stats().active, 0, "slot released after termination");
    assert.equal(runner.stats().live, 0, "worker reaped after termination");
  } finally {
    runner.shutdown();
  }
});

test("a worker startup failure rejects and releases the slot", async () => {
  const runner = createPdfRunner({
    scriptPath: worker("does-not-exist.js"),
    maxConcurrent: 1,
    maxQueued: 1,
  });
  try {
    const ok = (err) =>
      err.status === 500 &&
      (err.code === "pdf_worker_start_failed" || err.code === "pdf_worker_failed");
    await assert.rejects(runner.run({ timeoutMs: 2000, workerData: {} }), ok);
    // The slot was freed: a second call fails the same way rather than hanging
    // or being rejected as pdf_busy.
    await assert.rejects(runner.run({ timeoutMs: 2000, workerData: {} }), ok);
    assert.equal(runner.stats().active, 0);
  } finally {
    runner.shutdown();
  }
});

test("a worker that reports a structured failure propagates its code", async () => {
  const runner = createPdfRunner({ scriptPath: worker("report-failure.js"), maxConcurrent: 1 });
  try {
    await assert.rejects(
      runner.run({ timeoutMs: 2000, workerData: {} }),
      (err) => err.status === 422 && err.code === "pdf_unreadable"
    );
    assert.equal(runner.stats().active, 0);
  } finally {
    runner.shutdown();
  }
});

test("a worker that crashes or exits without a result fails cleanly", async () => {
  for (const name of ["throw-at-start.js", "exit-only.js"]) {
    const runner = createPdfRunner({ scriptPath: worker(name), maxConcurrent: 1 });
    try {
      await assert.rejects(
        runner.run({ timeoutMs: 2000, workerData: {} }),
        (err) => err.status === 500
      );
      assert.equal(runner.stats().active, 0, `${name}: slot must be released`);
      assert.equal(runner.stats().live, 0, `${name}: worker must be reaped`);
    } finally {
      runner.shutdown();
    }
  }
});

test("shutdown terminates in-flight and queued jobs without hanging", async () => {
  const runner = createPdfRunner({
    scriptPath: worker("hang.js"),
    maxConcurrent: 1,
    maxQueued: 4,
  });
  const active = runner.run({ timeoutMs: 10000, workerData: {} });
  const queued = runner.run({ timeoutMs: 10000, workerData: {} });
  await new Promise((r) => setTimeout(r, 60)); // let the first job start

  // Attach the rejection expectations BEFORE shutdown: resolving the queued
  // waiter during shutdown rejects it immediately, and an unattached rejection
  // would surface as an unhandled-rejection failure.
  const activeResult = assert.rejects(active, (err) => err.status >= 500 || err.code === "pdf_timeout");
  const queuedResult = assert.rejects(queued, (err) => err.status === 503);
  const started = Date.now();
  runner.shutdown();
  await activeResult;
  await queuedResult;
  assert.ok(Date.now() - started < 3000, "shutdown must not wait for the deadline");
  assert.equal(runner.stats().active, 0);
  assert.equal(runner.stats().live, 0);
});

// ===================================================================== B ====

function runChild(script, env) {
  const dir = mkTmp("recall-pdf-");
  const childEnv = {
    ...process.env,
    DATA_DIR: dir,
    EXTRACTION_PROVIDER: "regex",
    EMBEDDINGS_PROVIDER: "tfidf",
    AUTH_MODE: "required",
    ...env,
  };
  try {
    const res = spawnSync(process.execPath, ["-e", script], {
      cwd: REPO,
      env: childEnv,
      encoding: "utf-8",
    });
    const line = (res.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(
      line,
      `child produced no RESULT line (status=${res.status})\nstdout:${res.stdout}\nstderr:${res.stderr}`
    );
    return JSON.parse(line.slice("RESULT ".length));
  } finally {
    rm(dir);
  }
}

// Boots the real server and runs a PDF upload -> inspect -> search flow.
// Reports the pieces needed for both the parity and failure-isolation checks.
const FLOW_SCRIPT = `
const { app } = require("./server");
const db = require("./lib/db");
const { issueApiKey } = require("./lib/auth");
const { buildPdf } = require("./test/_pdf");
(async () => {
  const TAG = "pdfc";
  const { key } = issueApiKey(db, { tenantId: "t_pdf", containerTag: TAG });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = { authorization: "Bearer " + key };
  const up = (name, body) =>
    fetch(base + "/v1/documents/upload?containerTag=" + TAG, {
      method: "POST",
      headers: Object.assign({ "content-type": "application/pdf", "x-recall-filename": name }, auth),
      body,
    });

  const goodRes = await up("multi.pdf", buildPdf(["page one zebra", "page two yak", "page three ibex"]));
  const goodBody = await goodRes.json();
  const doc = goodBody.document;
  const chunks = db.listChunksByDocument(doc.id, TAG).map((c) => ({
    index: c.chunkIndex, page: c.page, provider: c.embeddingProvider,
  }));
  const docRow = db.getDocument(doc.id, TAG);

  const badRes = await up("bad.pdf", Buffer.from("%PDF-1.4 broken"));
  const badBody = await badRes.json();
  const badRow = badBody.documentId ? db.getDocument(badBody.documentId, TAG) : null;

  const searchRes = await fetch(
    base + "/v1/search?containerTag=" + TAG + "&q=" + encodeURIComponent("zebra") + "&searchMode=documents",
    { headers: auth }
  );
  const searchBody = await searchRes.json();
  const hitIds = (searchBody.results || []).map((r) => r.documentId || r.id);

  process.stdout.write("RESULT " + JSON.stringify({
    backend: db.backend,
    goodStatus: goodRes.status,
    pageCount: doc.pageCount,
    chunkCount: doc.chunkCount,
    chunkPages: chunks.map((c) => c.page),
    chunkIndexes: chunks.map((c) => c.index),
    chunkProviders: chunks.map((c) => c.provider),
    docRowProvider: docRow.embeddingProvider,
    badStatus: badRes.status,
    badErrorCode: badRow ? badRow.errorCode : null,
    badProvider: badRow ? badRow.embeddingProvider : "missing",
    badChunks: badBody.documentId ? db.listChunksByDocument(badBody.documentId, TAG).length : -1,
    inSearchGood: hitIds.includes(doc.id),
    inSearchBad: badBody.documentId ? hitIds.includes(badBody.documentId) : null,
  }) + "\\n");
  await new Promise((r) => server.close(r));
  db.close();
})();
`;

test("SQLite/JSON parity: PDF page provenance, chunk ordering, failure isolation", () => {
  const sqlite = runChild(FLOW_SCRIPT, { STORAGE_BACKEND: "sqlite" });
  const json = runChild(FLOW_SCRIPT, { STORAGE_BACKEND: "json" });

  for (const out of [sqlite, json]) {
    assert.equal(out.goodStatus, 201, `${out.backend}: valid PDF accepted`);
    assert.equal(out.pageCount, 3);
    assert.equal(out.chunkCount, 3);
    assert.deepEqual(out.chunkPages, [1, 2, 3], `${out.backend}: page attribution`);
    assert.deepEqual(out.chunkIndexes, [0, 1, 2], `${out.backend}: chunk ordering`);
    assert.equal(out.badStatus, 422, `${out.backend}: malformed PDF rejected`);
    assert.equal(out.badErrorCode, "pdf_unreadable");
    assert.equal(out.badProvider, null, `${out.backend}: failed row claims no provider`);
    assert.equal(out.badChunks, 0);
    assert.equal(out.inSearchGood, true, `${out.backend}: valid document searchable`);
    assert.equal(out.inSearchBad, false, `${out.backend}: failed document not searchable`);
  }

  // The two backends must agree on the observable shape.
  assert.equal(sqlite.pageCount, json.pageCount);
  assert.equal(sqlite.chunkCount, json.chunkCount);
  assert.deepEqual(sqlite.chunkPages, json.chunkPages);
  assert.deepEqual(sqlite.chunkIndexes, json.chunkIndexes);
});

const CONCURRENT_SCRIPT = `
const { app } = require("./server");
const db = require("./lib/db");
const { issueApiKey } = require("./lib/auth");
const { buildPdf } = require("./test/_pdf");
(async () => {
  const TAG = "pdfconc";
  const { key } = issueApiKey(db, { tenantId: "t_conc", containerTag: TAG });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = { authorization: "Bearer " + key };
  const uploads = Array.from({ length: 6 }, (_, i) =>
    fetch(base + "/v1/documents/upload?containerTag=" + TAG, {
      method: "POST",
      headers: Object.assign({ "content-type": "application/pdf", "x-recall-filename": "c" + i + ".pdf" }, auth),
      body: buildPdf(["page A of doc " + i, "page B of doc " + i]),
    }).then((res) => res.json())
  );
  const bodies = await Promise.all(uploads);
  const docs = db.listDocuments(TAG).filter((d) => d.status === "ready");
  const searchRes = await fetch(
    base + "/v1/search?containerTag=" + TAG + "&q=" + encodeURIComponent("page") + "&searchMode=documents",
    { headers: auth }
  );
  const searchBody = await searchRes.json();
  const searchable = new Set((searchBody.results || []).map((r) => r.documentId));
  process.stdout.write("RESULT " + JSON.stringify({
    count: bodies.length,
    pageCounts: bodies.map((b) => b.document && b.document.pageCount),
    statuses: bodies.map((b) => b.document && b.document.status),
    readyDocs: docs.length,
    searchable: docs.filter((d) => searchable.has(d.id)).length,
  }) + "\\n");
  await new Promise((r) => server.close(r));
  db.close();
})();
`;

test("concurrent PDF ingestion stays bounded and correct", () => {
  const out = runChild(CONCURRENT_SCRIPT, {
    STORAGE_BACKEND: "sqlite",
    PDF_MAX_CONCURRENT: "2",
    PDF_MAX_QUEUE: "16",
  });
  assert.equal(out.count, 6);
  assert.deepEqual(out.statuses, ["ready", "ready", "ready", "ready", "ready", "ready"]);
  assert.deepEqual(out.pageCounts, [2, 2, 2, 2, 2, 2]);
  assert.equal(out.readyDocs, 6);
  assert.equal(out.searchable, 6, "every valid upload must be retrievable");
});

const CLEANUP_SCRIPT = `
const { app } = require("./server");
const db = require("./lib/db");
const fs = require("fs");
const path = require("path");
const { issueApiKey } = require("./lib/auth");
(async () => {
  const TAG = "pdfcln";
  const { key } = issueApiKey(db, { tenantId: "t_cln", containerTag: TAG });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const res = await fetch(base + "/v1/documents/upload?containerTag=" + TAG, {
    method: "POST",
    headers: {
      authorization: "Bearer " + key,
      "content-type": "application/pdf",
      "x-recall-filename": "broken.pdf",
    },
    body: Buffer.from("%PDF-1.4 not a real pdf"),
  });
  const body = await res.json();
  const upDir = path.join(process.env.DATA_DIR, "uploads");
  const list = (p) => { try { return fs.readdirSync(p); } catch { return []; } };
  const stored = list(upDir).filter((n) => n !== "tmp");
  const temp = list(path.join(upDir, "tmp"));
  const chunks = body.documentId ? db.listChunksByDocument(body.documentId, TAG).length : -1;
  process.stdout.write("RESULT " + JSON.stringify({
    status: res.status,
    stored: stored.length,
    temp: temp.length,
    chunks,
  }) + "\\n");
  await new Promise((r) => server.close(r));
  db.close();
})();
`;

test("a failed PDF upload leaves no temp file, no stored file and no chunks", () => {
  const out = runChild(CLEANUP_SCRIPT, { STORAGE_BACKEND: "sqlite" });
  assert.equal(out.status, 422);
  assert.equal(out.stored, 0, "no stored file left behind");
  assert.equal(out.temp, 0, "no temp file left behind");
  assert.equal(out.chunks, 0);
});

const PARTIAL_SCRIPT = `
const { app } = require("./server");
const db = require("./lib/db");
const { issueApiKey } = require("./lib/auth");
const { buildPdf } = require("./test/_pdf");
(async () => {
  const TAG = "pdfpart";
  const { key } = issueApiKey(db, { tenantId: "t_part", containerTag: TAG });
  // Fail the commit half-way through: the document row and its chunks must roll
  // back together, so a partial document is never left searchable.
  db.addChunk = () => { throw Object.assign(new Error("simulated chunk insert failure"), { code: "EINSERT" }); };
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = { authorization: "Bearer " + key };
  const res = await fetch(base + "/v1/documents/upload?containerTag=" + TAG, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/pdf", "x-recall-filename": "partial.pdf" }, auth),
    body: buildPdf(["page one about zebras", "page two about yaks"]),
  });
  const body = await res.json();
  const searchRes = await fetch(
    base + "/v1/search?containerTag=" + TAG + "&q=zebras&searchMode=documents",
    { headers: auth }
  );
  const searchBody = await searchRes.json();
  const hitIds = (searchBody.results || []).map((r) => r.documentId || r.id);
  process.stdout.write("RESULT " + JSON.stringify({
    status: res.status,
    failedRows: db.listDocuments(TAG).filter((d) => d.status === "failed").length,
    readyRows: db.listDocuments(TAG).filter((d) => d.status === "ready").length,
    chunks: db.listChunks(TAG).length,
    inSearch: body.documentId ? hitIds.includes(body.documentId) : null,
  }) + "\\n");
  await new Promise((r) => server.close(r));
  db.close();
})();
`;

test("a document that fails mid-commit is rolled back and never searchable", () => {
  const out = runChild(PARTIAL_SCRIPT, { STORAGE_BACKEND: "sqlite" });
  assert.equal(out.status, 500, "an internal commit failure is a 500");
  assert.equal(out.failedRows, 1, "the failure is recorded for observability");
  assert.equal(out.readyRows, 0, "no document is presented as ready");
  assert.equal(out.chunks, 0, "no partial chunks survive the rollback");
  assert.equal(out.inSearch, false, "nothing partial is searchable");
});

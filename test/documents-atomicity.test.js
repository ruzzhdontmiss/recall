const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { mkTmp, rm } = require("./_support");

// Regressions for the verification findings:
//  - a cleanup failure must not mask the original ingestion error, drop the
//    failed-row record, or log sensitive detail;
//  - document deletion must not log a raw filesystem message / absolute path.
const DIR = mkTmp();
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";

const { app } = require("../server");
const db = require("../lib/db");
const storage = require("../lib/documents/storage");
const { ingestUpload } = require("../lib/documents/ingest");
const { issueApiKey } = require("../lib/auth");

const UPLOADS = path.join(DIR, "uploads");
const storedCount = () => {
  try {
    return fs.readdirSync(UPLOADS).filter((n) => n !== "tmp").length;
  } catch {
    return 0;
  }
};

let server;
let base;
let KEY;

before(async () => {
  ({ key: KEY } = issueApiKey(db, { tenantId: "atomic", containerTag: "sfix2" }));
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

async function captureWarnings(fn) {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = origWarn;
  }
  return warns.join("\n");
}

test("a failing cleanup cannot mask the original ingestion error", async () => {
  const origRemove = storage.remove;
  const origAddChunk = db.addChunk;
  db.addChunk = () => {
    throw Object.assign(new Error("simulated chunk insert failure"), { code: "EINSERT" });
  };
  storage.remove = () => {
    throw Object.assign(
      new Error("EACCES: permission denied, unlink '/abs/secret/path/file.txt'"),
      { code: "EACCES" }
    );
  };

  let err = null;
  const log = await captureWarnings(async () => {
    try {
      await ingestUpload({
        db,
        containerTag: "atomic1",
        filename: "a.txt",
        declaredMime: "text/plain",
        buffer: Buffer.from("body with SECRET_MARKER_42 and more"),
      });
    } catch (e) {
      err = e;
    } finally {
      storage.remove = origRemove;
      db.addChunk = origAddChunk;
    }
  });

  assert.ok(err, "ingest must throw");
  assert.equal(err.message, "simulated chunk insert failure", "the original error is preserved");
  assert.equal(err.code, "EINSERT");

  // The failure is still recorded, and nothing searchable was created.
  assert.equal(db.listDocuments("atomic1").filter((d) => d.status === "failed").length, 1);
  assert.equal(db.listChunks("atomic1").length, 0);

  // The cleanup warning is safe: a code, never a path or file contents.
  assert.ok(!log.includes("/abs/secret/path"), "must not log absolute paths");
  assert.ok(!log.includes("SECRET_MARKER_42"), "must not log file contents");
  assert.ok(/EACCES/.test(log), "must record a safe cleanup code");
});

test("a successful cleanup leaves no orphan and preserves the original error", async () => {
  const origAddChunk = db.addChunk;
  db.addChunk = () => {
    throw Object.assign(new Error("boom"), { code: "EBOOM" });
  };

  const before = storedCount();
  let err = null;
  const log = await captureWarnings(async () => {
    try {
      await ingestUpload({
        db,
        containerTag: "atomic2",
        filename: "b.txt",
        declaredMime: "text/plain",
        buffer: Buffer.from("another document body about cleanup"),
      });
    } catch (e) {
      err = e;
    } finally {
      db.addChunk = origAddChunk;
    }
  });

  assert.equal(err.message, "boom");
  assert.equal(err.code, "EBOOM");
  assert.equal(storedCount(), before, "the committed file was removed (no orphan)");
  assert.ok(!/cleanup incomplete/.test(log), "no cleanup warning when cleanup succeeds");
  assert.equal(db.listDocuments("atomic2").filter((d) => d.status === "failed").length, 1);
  assert.equal(db.listChunks("atomic2").length, 0);
});

test("document deletion logs a safe code, never a raw filesystem path", async () => {
  const up = await ingestUpload({
    db,
    containerTag: "sfix2",
    filename: "d.txt",
    declaredMime: "text/plain",
    buffer: Buffer.from("deletable content about removal"),
  });
  const id = up.document.id;

  const origRemove = storage.remove;
  storage.remove = () => {
    throw Object.assign(
      new Error("EPERM: operation not permitted, unlink '/Users/secret/uploads/x'"),
      { code: "EPERM" }
    );
  };

  let res;
  const log = await captureWarnings(async () => {
    try {
      res = await fetch(`${base}/v1/documents/${id}?containerTag=sfix2`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${KEY}` },
      });
    } finally {
      storage.remove = origRemove;
    }
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(db.getDocument(id, "sfix2"), null, "the database record is gone");
  assert.ok(!log.includes("/Users/secret"), "must not log absolute paths");
  assert.ok(/EPERM/.test(log), "should log a safe error code");
});

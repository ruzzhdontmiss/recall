// Stage 3 (Phase C): storage reconciliation is conservative and safe.
//
// Covers orphaned files, missing files, the grace period protecting in-flight
// uploads, transient filesystem errors, idempotent repeated runs, the CLI
// contract, and SQLite/JSON parity. Records and provenance are never modified.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const { reconcileStorage } = require("../lib/documents/reconcile");
const storage = require("../lib/documents/storage");

const OLD = () => new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

function mkTmp(prefix = "recall-reconcile-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeStore(backend, dir) {
  if (backend === "json") {
    return require("../lib/storage/json").create({ file: path.join(dir, "store.json") });
  }
  return require("../lib/storage/sqlite").create({ file: path.join(dir, "recall.db") });
}

function setup(backend = "sqlite") {
  const dir = mkTmp();
  const uploads = path.join(dir, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  process.env.UPLOAD_DIR = uploads;
  const store = makeStore(backend, dir);
  return {
    dir,
    uploads,
    store,
    cleanup() {
      try {
        store.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function addReadyDoc(store, id, storageKey, extra = {}) {
  return store.addDocument({
    id,
    containerTag: "t",
    content: "content",
    createdAt: new Date().toISOString(),
    source: "upload",
    status: "ready",
    filename: storageKey,
    mediaType: "application/pdf",
    storageKey,
    chunkCount: 1,
    ...extra,
  });
}

function writeFile(uploads, name, { old = true, body = "file-bytes" } = {}) {
  const full = path.join(uploads, name);
  fs.writeFileSync(full, body);
  if (old) fs.utimesSync(full, OLD(), OLD());
  return full;
}

// ------------------------------------------------------------------ tests --

for (const backend of ["sqlite", "json"]) {
  test(`${backend}: detects orphans, deletes only with apply, preserves records`, () => {
    const ctx = setup(backend);
    try {
      addReadyDoc(ctx.store, "doc-keep", "keep.pdf");
      writeFile(ctx.uploads, "keep.pdf");
      writeFile(ctx.uploads, "orphan.pdf");

      // Dry run: reported, nothing deleted.
      const dry = reconcileStorage({ db: ctx.store, storage, apply: false });
      assert.equal(dry.files.orphans, 1, "one orphan reported");
      assert.equal(dry.files.referenced, 1, "the referenced file is counted");
      assert.equal(dry.orphans[0].name, "orphan.pdf");
      assert.equal(dry.removed.length, 0, "dry run removes nothing");
      assert.ok(fs.existsSync(path.join(ctx.uploads, "orphan.pdf")), "orphan still present after dry run");

      // Apply: orphan deleted, referenced file and record untouched.
      const applied = reconcileStorage({ db: ctx.store, storage, apply: true });
      assert.equal(applied.removed.length, 1);
      assert.equal(applied.failedRemovals.length, 0);
      assert.ok(!fs.existsSync(path.join(ctx.uploads, "orphan.pdf")), "orphan deleted");
      assert.ok(fs.existsSync(path.join(ctx.uploads, "keep.pdf")), "referenced file kept");
      assert.ok(ctx.store.getDocument("doc-keep", "t"), "record preserved");

      // Idempotent: a second apply finds nothing.
      const again = reconcileStorage({ db: ctx.store, storage, apply: true });
      assert.equal(again.files.orphans, 0);
      assert.equal(again.removed.length, 0);
    } finally {
      ctx.cleanup();
    }
  });

  test(`${backend}: a missing file is reported and its record is preserved`, () => {
    const ctx = setup(backend);
    try {
      addReadyDoc(ctx.store, "doc-missing", "gone.pdf"); // no file written

      const report = reconcileStorage({ db: ctx.store, storage, apply: true });
      assert.equal(report.missing.length, 1);
      assert.deepEqual(report.missing[0], { documentId: "doc-missing", name: "gone.pdf" });
      assert.equal(report.files.orphans, 0);
      // Apply never touches records.
      assert.ok(ctx.store.getDocument("doc-missing", "t"), "record preserved despite missing file");
      assert.equal(report.removed.length, 0);
    } finally {
      ctx.cleanup();
    }
  });
}

test("recent files are protected by the grace period", () => {
  const ctx = setup();
  try {
    writeFile(ctx.uploads, "fresh.pdf", { old: false }); // mtime = now

    const report = reconcileStorage({ db: ctx.store, storage, apply: true });
    assert.equal(report.files.orphans, 0, "a fresh file is not an orphan");
    assert.equal(report.files.recent, 1);
    assert.equal(report.removed.length, 0);
    assert.ok(fs.existsSync(path.join(ctx.uploads, "fresh.pdf")), "fresh file must survive apply");

    // With the grace period disabled it becomes an orphan (demonstrates the guard).
    const strict = reconcileStorage({ db: ctx.store, storage, apply: false, graceMs: 0 });
    assert.equal(strict.files.orphans, 1, "grace=0 exposes the same file as an orphan");
  } finally {
    ctx.cleanup();
  }
});

test("a file committed by an in-flight upload is not treated as an orphan", () => {
  const ctx = setup();
  try {
    // Simulates the commit-then-insert window: the file exists and is fresh, the
    // row has not been written yet.
    writeFile(ctx.uploads, "in-flight.pdf", { old: false });
    const report = reconcileStorage({ db: ctx.store, storage, apply: true });
    assert.equal(report.files.orphans, 0);
    assert.equal(report.files.recent, 1);
    assert.ok(fs.existsSync(path.join(ctx.uploads, "in-flight.pdf")));
  } finally {
    ctx.cleanup();
  }
});

test("a completed concurrent deletion reports neither an orphan nor a missing file", () => {
  const ctx = setup();
  try {
    // After a delete, both the record and the file are gone, so nothing is
    // reported in either direction.
    const report = reconcileStorage({ db: ctx.store, storage, apply: true });
    assert.equal(report.missing.length, 0);
    assert.equal(report.files.orphans, 0);
  } finally {
    ctx.cleanup();
  }
});

test("transient filesystem errors are reported, never treated as orphans", () => {
  const ctx = setup();
  try {
    writeFile(ctx.uploads, "flaky.bin");
    const fsImpl = {
      readdirSync: (p) => fs.readdirSync(p),
      statSync: (p) => {
        if (path.basename(p) === "flaky.bin") {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return fs.statSync(p);
      },
    };
    const report = reconcileStorage({ db: ctx.store, storage, apply: true, fsImpl });
    assert.equal(report.files.orphans, 0, "an unreadable file is not proven to be an orphan");
    assert.equal(report.files.unresolved, 1);
    assert.equal(report.unresolved[0].code, "EACCES");
    assert.equal(report.removed.length, 0);
    assert.ok(fs.existsSync(path.join(ctx.uploads, "flaky.bin")), "unreadable file left alone");
  } finally {
    ctx.cleanup();
  }
});

test("a record whose file cannot be stat'd is reported as unverifiable, not missing", () => {
  const ctx = setup();
  try {
    addReadyDoc(ctx.store, "doc-flaky", "flaky.pdf");
    const fsImpl = {
      readdirSync: (p) => fs.readdirSync(p),
      statSync: (p) => {
        if (path.basename(p) === "flaky.pdf") {
          throw Object.assign(new Error("io error"), { code: "EIO" });
        }
        return fs.statSync(p);
      },
    };
    const report = reconcileStorage({ db: ctx.store, storage, apply: true, fsImpl });
    assert.equal(report.missing.length, 0, "a transient error is not proof the file is gone");
    assert.equal(report.unreadableRecords.length, 1);
    assert.equal(report.unreadableRecords[0].code, "EIO");
    assert.ok(ctx.store.getDocument("doc-flaky", "t"));
  } finally {
    ctx.cleanup();
  }
});

test("tmp files and directories are never touched", () => {
  const ctx = setup();
  try {
    fs.mkdirSync(path.join(ctx.uploads, "tmp"), { recursive: true });
    writeFile(path.join(ctx.uploads, "tmp"), "buffered.tmp"); // old, but must be skipped
    fs.mkdirSync(path.join(ctx.uploads, "nested"), { recursive: true });

    const report = reconcileStorage({ db: ctx.store, storage, apply: true });
    assert.equal(report.files.orphans, 0, "tmp/ and directories are not orphans");
    assert.equal(report.removed.length, 0);
    assert.ok(fs.existsSync(path.join(ctx.uploads, "tmp", "buffered.tmp")));
    assert.ok(fs.existsSync(path.join(ctx.uploads, "nested")));
  } finally {
    ctx.cleanup();
  }
});

test("a missing upload directory is not an error", () => {
  const ctx = setup();
  try {
    process.env.UPLOAD_DIR = path.join(ctx.dir, "does-not-exist");
    const report = reconcileStorage({ db: ctx.store, storage, apply: true });
    assert.equal(report.files.total, 0);
    assert.equal(report.dirUnreadable, null);
    assert.equal(report.missing.length, 0);
  } finally {
    ctx.cleanup();
  }
});

// -------------------------------------------------------------------- CLI --

function runCli(dir, args, env = {}) {
  const res = spawnSync(process.execPath, [path.join(REPO, "scripts", "reconcile-storage.js"), ...args], {
    cwd: REPO,
    env: { ...process.env, DATA_DIR: dir, STORAGE_BACKEND: "sqlite", UPLOAD_DIR: path.join(dir, "uploads"), ...env },
    encoding: "utf-8",
  });
  return res;
}

test("CLI: --json dry run reports counts and exits 0", () => {
  const ctx = setup();
  try {
    addReadyDoc(ctx.store, "cli-doc", "cli.pdf");
    writeFile(ctx.uploads, "cli.pdf");
    writeFile(ctx.uploads, "cli-orphan.pdf");
    ctx.store.close();

    const res = runCli(ctx.dir, ["--json", "--dry-run"]);
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.backend, "sqlite");
    assert.equal(report.apply, false);
    assert.equal(report.files.orphans, 1);
    assert.equal(report.removed.length, 0);
    assert.ok(fs.existsSync(path.join(ctx.uploads, "cli-orphan.pdf")), "dry run deletes nothing");
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("CLI: --apply removes the orphan, is idempotent, and exits 0", () => {
  const ctx = setup();
  try {
    addReadyDoc(ctx.store, "cli-doc2", "cli2.pdf");
    writeFile(ctx.uploads, "cli2.pdf");
    writeFile(ctx.uploads, "cli2-orphan.pdf");
    ctx.store.close();

    const first = runCli(ctx.dir, ["--json", "--apply"]);
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.removed.length, 1);
    assert.ok(!fs.existsSync(path.join(ctx.uploads, "cli2-orphan.pdf")));
    assert.ok(fs.existsSync(path.join(ctx.uploads, "cli2.pdf")), "referenced file kept");

    const second = runCli(ctx.dir, ["--json", "--apply"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).removed.length, 0, "idempotent");
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("CLI: an unknown argument fails with a non-zero exit", () => {
  const dir = mkTmp();
  try {
    const res = runCli(dir, ["--nope"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unknown argument/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

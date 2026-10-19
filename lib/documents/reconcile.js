// Conservative reconciliation between the document records and the uploaded
// files on local disk.
//
// Two directions are checked:
//   - orphaned files: a file in UPLOAD_DIR that no document record references;
//   - missing files:  a document record whose expected file is absent.
//
// Safety rules:
//   - records, chunks and provenance are NEVER modified — only unreferenced
//     *files* may be deleted, and only with an explicit apply flag;
//   - a file newer than the grace period is treated as "possibly in flight"
//     (a concurrent upload commits the file before it inserts the row) and is
//     never deleted;
//   - a transient filesystem error is reported, not treated as proof of an
//     orphan, so an unreadable directory/file is left alone;
//   - `tmp/` (in-progress buffered uploads) and any directories are skipped.
//
// The caller supplies the store (which exposes `documents`) and the file store
// (`uploadDir()` / `remove()`); `fsImpl` is injectable for tests.

const path = require("path");
const fs = require("fs");

const DEFAULT_GRACE_MS = 60 * 60 * 1000; // 1 hour

function errCode(err, fallback) {
  return (err && err.code) || fallback;
}

function reconcileStorage(options = {}) {
  const { db, storage } = options;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : DEFAULT_GRACE_MS;
  const apply = Boolean(options.apply);
  const fsImpl = options.fsImpl || fs;

  if (!db || typeof db.documents === "undefined") {
    throw new Error("reconcileStorage requires a store exposing `documents`");
  }
  if (!storage || typeof storage.uploadDir !== "function" || typeof storage.remove !== "function") {
    throw new Error("reconcileStorage requires file storage with uploadDir()/remove()");
  }

  const uploadDir = storage.uploadDir();
  const docs = Array.from(db.documents || []);
  const referenced = new Set();
  for (const d of docs) if (d && d.storageKey) referenced.add(d.storageKey);

  // -- direction 1: records whose expected file is absent / unreadable --------
  const missing = [];
  const unreadableRecords = [];
  let withFile = 0;
  for (const d of docs) {
    if (!d || !d.storageKey) continue;
    withFile += 1;
    try {
      const st = fsImpl.statSync(path.join(uploadDir, d.storageKey));
      if (!st.isFile()) {
        unreadableRecords.push({ documentId: d.id, name: d.storageKey, code: "not_a_file" });
      }
    } catch (err) {
      const c = errCode(err, "stat_failed");
      if (c === "ENOENT") missing.push({ documentId: d.id, name: d.storageKey });
      else unreadableRecords.push({ documentId: d.id, name: d.storageKey, code: c });
    }
  }

  // -- direction 2: files that no record references ---------------------------
  let names = [];
  let dirUnreadable = null;
  try {
    names = fsImpl.readdirSync(uploadDir);
  } catch (err) {
    // A missing upload dir simply means there is nothing to reconcile.
    if (errCode(err) !== "ENOENT") dirUnreadable = errCode(err, "readdir_failed");
  }

  const recent = [];
  const orphans = [];
  const unresolved = [];
  let referencedFiles = 0;
  for (const name of names) {
    if (name === "tmp") continue;
    let st;
    try {
      st = fsImpl.statSync(path.join(uploadDir, name));
    } catch (err) {
      // Transient/unknown error: report it, never assume it is an orphan.
      unresolved.push({ name, code: errCode(err, "stat_failed") });
      continue;
    }
    if (!st.isFile()) continue; // directories and special files are never touched
    if (referenced.has(name)) {
      referencedFiles += 1;
      continue;
    }
    const ageMs = Math.max(0, now - st.mtimeMs);
    if (ageMs < graceMs) {
      recent.push({ name, ageMs }); // possibly a concurrent upload still in flight
      continue;
    }
    orphans.push({ name, size: st.size, ageMs });
  }

  // -- apply: delete orphaned files only --------------------------------------
  const removed = [];
  const failedRemovals = [];
  if (apply && !dirUnreadable) {
    for (const o of orphans) {
      try {
        storage.remove(o.name);
        let gone = true;
        try {
          fsImpl.statSync(path.join(uploadDir, o.name));
          gone = false;
        } catch {
          /* gone as expected */
        }
        if (gone) removed.push(o.name);
        else failedRemovals.push({ name: o.name, code: "still_present" });
      } catch (err) {
        failedRemovals.push({ name: o.name, code: errCode(err, "unlink_failed") });
      }
    }
  }

  const totalFiles = referencedFiles + recent.length + orphans.length + unresolved.length;
  return {
    backend: db.backend || "unknown",
    apply,
    now,
    graceMs,
    documents: { total: docs.length, withFile, withoutFile: docs.length - withFile },
    files: {
      total: totalFiles,
      referenced: referencedFiles,
      recent: recent.length,
      orphans: orphans.length,
      unresolved: unresolved.length,
    },
    missing,
    unreadableRecords,
    recent,
    orphans,
    unresolved,
    removed,
    failedRemovals,
    dirUnreadable,
  };
}

module.exports = { reconcileStorage, DEFAULT_GRACE_MS };

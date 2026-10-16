// Private local storage for uploaded files.
//
// Files are written under UPLOAD_DIR (default DATA_DIR/uploads) with the final
// name fully generated on the server: `<docId>.<ext>` where the extension comes
// from a fixed allowlist in lib/validate.js. A user-supplied filename is never
// part of a filesystem path, which removes path traversal as a class of bug.
//
// Permissions: directories 0700, files 0600 (private by default).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readConfig } = require("./config");

function uploadDir() {
  return readConfig().uploadDir;
}

function tempDir() {
  return path.join(uploadDir(), "tmp");
}

function ensureDirs() {
  fs.mkdirSync(uploadDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(tempDir(), { recursive: true, mode: 0o700 });
}

// Buffer a validated upload to a private temp file. Returns the temp path.
function writeTemp(buffer) {
  ensureDirs();
  const name = crypto.randomBytes(16).toString("hex") + ".tmp";
  const target = path.join(tempDir(), name);
  fs.writeFileSync(target, buffer, { mode: 0o600 });
  return target;
}

// Move a temp file into place under a server-generated name. Returns the
// relative storage key (safe to persist; never absolute).
function commit(tempPath, docId, ext) {
  ensureDirs();
  const key = `${docId}.${ext}`;
  const target = path.join(uploadDir(), key);
  fs.renameSync(tempPath, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* best-effort on platforms without POSIX modes */
  }
  return key;
}

// Delete a stored file by its relative key. Tolerates a missing file and
// refuses any key that would resolve outside the upload directory.
function remove(storageKey) {
  if (!storageKey) return false;
  const base = path.resolve(uploadDir());
  const target = path.resolve(base, storageKey);
  if (target !== base && !target.startsWith(base + path.sep)) return false;
  try {
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

function removeTemp(tempPath) {
  if (!tempPath) return;
  try {
    fs.unlinkSync(tempPath);
  } catch {
    /* already gone */
  }
}

// Remove leftover temp files (e.g. after a crash mid-upload). Safe to call at
// startup and on shutdown.
function sweepTemps() {
  try {
    ensureDirs();
    for (const name of fs.readdirSync(tempDir())) {
      try {
        fs.unlinkSync(path.join(tempDir(), name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* directory unavailable */
  }
}

module.exports = { writeTemp, commit, remove, removeTemp, sweepTemps, uploadDir };

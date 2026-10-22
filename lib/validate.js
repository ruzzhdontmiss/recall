// Request validation helpers.
//
// Kept dependency-free and explicit so every route can reject bad input with a
// predictable status code. These validate *shape and size* only; ownership is a
// separate concern handled by the auth/authorization layer.

// Unicode letters/digits, plus `. _ : -`, 1..128 chars. Allows existing tags
// such as `user_123`, `demo_user` and `user_né` while rejecting control
// characters, whitespace and path-ish input.
const CONTAINER_TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,127}$/u;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEARCH_MODES = new Set(["hybrid", "memories", "documents"]);

const MAX_CONTENT_CHARS = 200_000;
const MAX_QUERY_CHARS = 1_000;
const MAX_FILENAME_CHARS = 255;

// Supported upload types. The extension drives which adapter runs and which
// content types are acceptable; nothing here is derived from user input beyond
// a lookup.
const UPLOAD_TYPES = {
  ".txt": { mediaType: "text/plain", adapter: "text", mimes: ["text/plain", "application/octet-stream"] },
  ".md": {
    mediaType: "text/markdown",
    adapter: "markdown",
    mimes: ["text/markdown", "text/x-markdown", "text/plain", "application/octet-stream"],
  },
  ".pdf": {
    mediaType: "application/pdf",
    adapter: "pdf",
    mimes: ["application/pdf", "application/x-pdf", "application/octet-stream"],
  },
};
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidContainerTag(value) {
  return typeof value === "string" && CONTAINER_TAG_RE.test(value.trim());
}

function isValidId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

function isValidSearchMode(value) {
  return SEARCH_MODES.has(value);
}

// Returns null when valid, otherwise { status, error }.
function validateContent(value) {
  if (value === undefined || value === null) return { status: 400, error: "content is required" };
  if (typeof value !== "string") return { status: 400, error: "content must be a string" };
  if (!value.trim()) return { status: 400, error: "content is required" };
  if (value.length > MAX_CONTENT_CHARS) return { status: 413, error: "content too large" };
  return null;
}

function validateQuery(value) {
  if (!isNonEmptyString(value)) return { status: 400, error: "q is required" };
  if (value.length > MAX_QUERY_CHARS) return { status: 400, error: "q is too long" };
  return null;
}

// Optional relevance floor for search clients. Kept opt-in (default 0) because
// absolute hybrid scores are not calibrated across providers/corpora; the
// evaluation shows that a single global cutoff cannot separate real answers from
// plausible near-misses. The route compares the reported (rounded) score.
function validateMinScore(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    return { status: 400, error: "minScore must be a number between 0 and 1" };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return { status: 400, error: "minScore must be a number between 0 and 1" };
  }
  return null;
}

// ---- upload validation ----------------------------------------------------

// Keep the original filename as display metadata only. Strip any path
// components and control characters so it can never be mistaken for a path and
// so responses/logs stay clean.
function sanitizeFilename(value) {
  if (typeof value !== "string") return "";
  const base = value.split(/[\\/]/).pop() || "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, MAX_FILENAME_CHARS);
}

function extensionOf(filename) {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return "";
  return filename.slice(idx).toLowerCase();
}

// Detect and validate an upload from its declared filename, declared content
// type and bytes. Returns { ok: true, ... } or { ok: false, status, error }.
// A mismatch between extension, declared MIME and magic bytes is rejected
// rather than guessed.
function detectUploadType({ filename, declaredMime, buffer }) {
  const name = sanitizeFilename(filename);
  if (!name) return { ok: false, status: 400, error: "filename is required" };

  const ext = extensionOf(name);
  const type = UPLOAD_TYPES[ext];
  if (!type) return { ok: false, status: 415, error: "unsupported file type" };

  const mime = typeof declaredMime === "string" ? declaredMime.split(";")[0].trim().toLowerCase() : "";
  if (mime && !type.mimes.includes(mime)) {
    return { ok: false, status: 415, error: "content type does not match file extension" };
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, status: 400, error: "file is empty" };
  }

  if (type.adapter === "pdf") {
    if (buffer.length < PDF_MAGIC.length || !buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      return { ok: false, status: 415, error: "file is not a valid PDF" };
    }
  } else {
    // Text formats must not contain NUL bytes in the scanned prefix.
    const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
    if (probe.includes(0)) {
      return { ok: false, status: 415, error: "file is not valid text" };
    }
  }

  return { ok: true, filename: name, ext, mediaType: type.mediaType, adapter: type.adapter };
}

module.exports = {
  CONTAINER_TAG_RE,
  MAX_CONTENT_CHARS,
  MAX_QUERY_CHARS,
  MAX_FILENAME_CHARS,
  UPLOAD_TYPES,
  isNonEmptyString,
  isValidContainerTag,
  isValidId,
  isValidSearchMode,
  validateContent,
  validateQuery,
  validateMinScore,
  sanitizeFilename,
  extensionOf,
  detectUploadType,
};

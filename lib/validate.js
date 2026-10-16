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

module.exports = {
  CONTAINER_TAG_RE,
  MAX_CONTENT_CHARS,
  MAX_QUERY_CHARS,
  isNonEmptyString,
  isValidContainerTag,
  isValidId,
  isValidSearchMode,
  validateContent,
  validateQuery,
};

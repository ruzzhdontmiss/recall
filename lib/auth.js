// API-key authentication and container authorization.
//
// Model: a *scoped API key* maps to exactly one tenant and one default
// container. The authenticated principal (tenant + default container) is derived
// only from the validated key — a client-supplied `containerTag` is a resource
// selector, never proof of ownership.
//
// Only the SHA-256 hash of a key is stored; the raw secret is shown once at
// creation and never persisted or logged.

const crypto = require("crypto");
const { isNonEmptyString, isValidContainerTag } = require("./validate");

const KEY_PREFIX = "sm_";
const KEY_BYTES = 32;
const LAST_USED_THROTTLE_MS = 60_000;

function generateApiKey() {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString("base64url");
}

function hashApiKey(key) {
  return crypto.createHash("sha256").update(String(key), "utf8").digest("hex");
}

function newKeyId() {
  return "key_" + crypto.randomBytes(9).toString("base64url");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractToken(req) {
  const headers = (req && req.headers) || {};
  const raw = headers.authorization || headers.Authorization;
  if (typeof raw !== "string") return null;
  const match = raw.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

// Create and persist a key for a tenant. Returns { key, record }. The raw `key`
// is returned exactly once, here, and is never stored.
function issueApiKey(db, { tenantId, name = null, containerTag = null, expiresAt = null } = {}) {
  if (!isNonEmptyString(tenantId)) throw new Error("tenantId is required");
  const defaultContainer = String(containerTag || tenantId).trim();
  if (!isValidContainerTag(defaultContainer)) throw new Error("invalid containerTag");
  if (expiresAt != null && Number.isNaN(Date.parse(expiresAt))) {
    throw new Error("expiresAt must be an ISO date-time");
  }

  // Provision the container first so a tag already owned by another tenant fails
  // before we persist a key that could not be used.
  if (!db.claimContainer(defaultContainer, tenantId)) {
    throw new Error(`container "${defaultContainer}" is already owned by another tenant`);
  }

  const key = generateApiKey();
  const record = {
    id: newKeyId(),
    keyHash: hashApiKey(key),
    tenantId,
    defaultContainer,
    name,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: expiresAt || null,
  };
  db.createApiKey(record);
  return { key, record };
}

function unauthorized(res) {
  return res.status(401).json({ error: "unauthorized" });
}

function createAuthMiddleware({ db, mode = "required", devTenant = "dev", devContainer = "dev" }) {
  const devEnabled = mode === "dev";
  return function authenticate(req, res, next) {
    const token = extractToken(req);
    if (!token) {
      if (devEnabled) {
        req.auth = {
          tenantId: devTenant,
          keyId: null,
          defaultContainer: devContainer,
          dev: true,
        };
        return next();
      }
      return unauthorized(res);
    }
    if (!token.startsWith(KEY_PREFIX)) return unauthorized(res);

    const hash = hashApiKey(token);
    const record = db.getApiKeyByHash(hash);
    if (!record) return unauthorized(res);
    if (!timingSafeEqualHex(record.keyHash, hash)) return unauthorized(res);
    if (record.revokedAt) return unauthorized(res);
    if (record.expiresAt) {
      const exp = Date.parse(record.expiresAt);
      if (Number.isFinite(exp) && exp <= Date.now()) return unauthorized(res);
    }

    const now = Date.now();
    const last = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
    if (!last || now - last > LAST_USED_THROTTLE_MS) {
      try {
        db.touchApiKey(record.id, new Date(now).toISOString());
      } catch {
        /* last-used metadata is best-effort, never a request blocker */
      }
    }

    req.auth = {
      tenantId: record.tenantId,
      keyId: record.id,
      defaultContainer: record.defaultContainer,
      dev: false,
    };
    return next();
  };
}

// Authorize a request's container selector against the authenticated tenant.
// `claim` allows POST /v1/add to provision a brand-new container for the tenant;
// every other route requires the container to already be owned (so reading a
// container the caller has never written to is denied rather than auto-created).
function authorizeContainer(db, auth, requestedTag, { claim = false } = {}) {
  const tag = isNonEmptyString(requestedTag) ? requestedTag.trim() : auth.defaultContainer;
  if (!isValidContainerTag(tag)) return { ok: false, reason: "invalid" };
  const ok = claim
    ? db.claimContainer(tag, auth.tenantId)
    : db.isContainerOwned(tag, auth.tenantId);
  return ok ? { ok: true, tag } : { ok: false, reason: "forbidden" };
}

module.exports = {
  KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  timingSafeEqualHex,
  extractToken,
  issueApiKey,
  createAuthMiddleware,
  authorizeContainer,
};

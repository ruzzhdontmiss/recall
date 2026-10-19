// Storage facade.
//
// Selects the backend (SQLite by default, JSON for rollback) and exposes the
// exact method surface the rest of the app already relies on, so server.js,
// lib/search.js and lib/extract/persist.js do not need to know which backend is
// active.
//
//   STORAGE_BACKEND=sqlite   (default)  DATA_DIR/recall.db
//   STORAGE_BACKEND=json                DATA_DIR/store.json   (legacy/rollback)
//
// The backend is never changed silently: if SQLite is active but a legacy JSON
// store with data exists and the database is empty, a loud warning with the
// migration command is printed at startup (we do not auto-migrate).

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "..", "data");
const BACKEND = (process.env.STORAGE_BACKEND || "sqlite").toLowerCase().trim();
const JSON_FILE = process.env.STORE_FILE || path.join(DATA_DIR, "store.json");
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(DATA_DIR, "recall.db");

function stripEmbedding(row) {
  if (!row) return row;
  // `storageKey` is a server-side relative path and must never reach clients.
  // Embedding vectors and their provider/model/dimension bookkeeping are
  // server-side only and must never reach clients either.
  const { embedding, storageKey, embeddingProvider, embeddingModel, embeddingDim, ...rest } = row;
  return rest;
}

function legacyJsonHasData() {
  try {
    if (!fs.existsSync(JSON_FILE)) return false;
    const parsed = JSON.parse(fs.readFileSync(JSON_FILE, "utf-8"));
    return Boolean(
      parsed && ((parsed.documents && parsed.documents.length) || (parsed.memories && parsed.memories.length))
    );
  } catch {
    return false;
  }
}

let adapter;
if (BACKEND === "json") {
  adapter = require("./json").create({ file: JSON_FILE });
} else if (BACKEND === "sqlite") {
  adapter = require("./sqlite").create({ file: SQLITE_FILE });
} else {
  throw new Error(`unknown STORAGE_BACKEND=${BACKEND} (expected "sqlite" or "json")`);
}

// Diagnostics go to stderr so machine-readable stdout (e.g. `key-cli --json`)
// stays clean.
console.error(`[storage] backend=${adapter.backend} file=${adapter.file}`);

if (adapter.backend === "sqlite" && adapter.isEmpty() && legacyJsonHasData()) {
  console.warn(
    `[storage] WARNING: an existing JSON store with data was found at ${JSON_FILE} but the ` +
      `SQLite database is empty. Recall will NOT migrate automatically. Run ` +
      `"npm run db:migrate-json" to migrate it (see README), or set STORAGE_BACKEND=json to keep using JSON.`
  );
}

const facade = {
  backend: adapter.backend,
  file: adapter.file,

  get documents() {
    return adapter.documents;
  },
  get memories() {
    return adapter.memories;
  },

  addDocument: (doc) => adapter.addDocument(doc),
  addMemory: (mem) => adapter.addMemory(mem),
  updateEmbedding: (kind, id, vec) => adapter.updateEmbedding(kind, id, vec),
  invalidateEmbeddings: () => adapter.invalidateEmbeddings(),
  hasStoredVectors: () => adapter.hasStoredVectors(),
  forgetMemory: (id, containerTag) => adapter.forgetMemory(id, containerTag),
  transaction: (fn) => adapter.transaction(fn),
  isEmpty: () => adapter.isEmpty(),
  touch: () => adapter.touch(),
  flush: () => adapter.flush(),
  close: () => adapter.close(),
  reset: () => adapter.reset(),

  // Key/value bookkeeping (embedding space identity).
  getMeta: (key) => adapter.getMeta(key),
  setMeta: (key, value) => adapter.setMeta(key, value),

  // Tenant-scoped content queries (enforce container ownership at the data layer).
  listDocuments: (containerTag) => adapter.listDocuments(containerTag),
  getDocument: (id, containerTag) => adapter.getDocument(id, containerTag),
  findDocumentByHash: (containerTag, hash) => adapter.findDocumentByHash(containerTag, hash),
  deleteDocument: (id, containerTag) => adapter.deleteDocument(id, containerTag),
  listMemories: (containerTag) => adapter.listMemories(containerTag),
  getMemory: (id, containerTag) => adapter.getMemory(id, containerTag),
  supersedeSlot: (containerTag, slot, iso) => adapter.supersedeSlot(containerTag, slot, iso),

  // Uploaded-document chunks.
  listChunks: (containerTag) => adapter.listChunks(containerTag),
  listChunksByDocument: (documentId, containerTag) =>
    adapter.listChunksByDocument(documentId, containerTag),
  addChunk: (chunk) => adapter.addChunk(chunk),

  // Container ownership.
  getContainer: (containerTag) => adapter.getContainer(containerTag),
  listContainers: (tenantId) => adapter.listContainers(tenantId),
  isContainerOwned: (containerTag, tenantId) => adapter.isContainerOwned(containerTag, tenantId),
  claimContainer: (containerTag, tenantId) => adapter.claimContainer(containerTag, tenantId),

  // API keys (hashes only; the raw secret never reaches storage).
  createApiKey: (record) => adapter.createApiKey(record),
  getApiKeyByHash: (hash) => adapter.getApiKeyByHash(hash),
  touchApiKey: (id, iso) => adapter.touchApiKey(id, iso),
  revokeApiKey: (id, tenantId, iso) => adapter.revokeApiKey(id, tenantId, iso),
  listApiKeys: (tenantId) => adapter.listApiKeys(tenantId),

  publicDocument: stripEmbedding,
  publicMemory: stripEmbedding,
};

module.exports = facade;

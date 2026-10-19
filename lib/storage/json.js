// Legacy JSON storage backend.
//
// Preserved so the SQLite migration can be rolled back by setting
// STORAGE_BACKEND=json. Behaviour matches the original lib/db.js with two safety
// changes: a corrupt store file now fails loudly instead of silently starting
// from an empty store, and a shared transaction() method was added for parity
// with the SQLite backend.

const fs = require("fs");
const path = require("path");

function emptyStore() {
  return { documents: [], memories: [], chunks: [], containers: [], apiKeys: [], meta: {} };
}

// Record which vector space produced a row, so search can detect stale vectors.
// Mirrors the SQLite backend's helper.
function embeddingMeta() {
  try {
    const embeddings = require("../embeddings");
    if (typeof embeddings.activeDescribe === "function") return embeddings.activeDescribe();
    if (typeof embeddings.describe === "function") return embeddings.describe();
  } catch {
    /* embeddings module unavailable (e.g. unit test) */
  }
  return { provider: null, model: null };
}

function stampEmbeddingMeta(obj, meta) {
  obj.embeddingProvider = meta.provider ?? null;
  obj.embeddingModel = meta.model ?? null;
  obj.embeddingDim = obj.embedding ? obj.embedding.length : null;
  return obj;
}

function create({ file }) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(emptyStore(), null, 2));
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    // Never treat a corrupt store as "empty" — that would silently discard data.
    throw new Error(`store JSON at ${file} is corrupt and was NOT reset: ${err.message}`);
  }
  if (!store || !Array.isArray(store.documents) || !Array.isArray(store.memories)) {
    throw new Error(`store JSON at ${file} has an unexpected shape`);
  }
  // Backwards compatible with Phase 2 stores, which had no auth tables.
  if (!Array.isArray(store.containers)) store.containers = [];
  if (!Array.isArray(store.apiKeys)) store.apiKeys = [];
  // Backwards compatible with Phase 3 stores, which had no chunks.
  if (!Array.isArray(store.chunks)) store.chunks = [];
  // Backwards compatible with stores that predate the embedding-space bookkeeping.
  if (!store.meta || typeof store.meta !== "object" || Array.isArray(store.meta)) store.meta = {};

  let dirty = false;
  let saveTimer = null;
  let txDepth = 0;

  function persist() {
    if (!dirty) return;
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
    dirty = false;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      persist();
      saveTimer = null;
    }, 50);
  }

  const api = {
    backend: "json",
    file,
    get documents() {
      return store.documents;
    },
    get memories() {
      return store.memories;
    },
    isEmpty() {
      return store.documents.length === 0 && store.memories.length === 0;
    },
    // See the SQLite backend: `meta` may be supplied explicitly so a row that
    // produced no vector (e.g. a failed upload) records no embedding provider.
    addDocument(doc, meta = embeddingMeta()) {
      if (doc.embedding === undefined) doc.embedding = null;
      store.documents.push(stampEmbeddingMeta(doc, meta));
      scheduleSave();
      return doc;
    },
    addMemory(mem) {
      if (mem.embedding === undefined) mem.embedding = null;
      store.memories.push(stampEmbeddingMeta(mem, embeddingMeta()));
      scheduleSave();
      return mem;
    },
    updateEmbedding(kind, id, vec) {
      const list =
        kind === "document" ? store.documents : kind === "memory" ? store.memories : store.chunks;
      const row = list.find((x) => x.id === id);
      if (!row) return null;
      const meta = embeddingMeta();
      row.embedding = vec;
      row.embeddingProvider = meta.provider ?? null;
      row.embeddingModel = meta.model ?? null;
      row.embeddingDim = vec ? vec.length : null;
      scheduleSave();
      return row;
    },
    // Drop every stored vector and its embedding-space metadata so vectors can be
    // regenerated in the restored/current space (parity with the SQLite backend).
    // Records, provenance and text are preserved.
    invalidateEmbeddings() {
      let cleared = 0;
      for (const list of [store.documents, store.memories, store.chunks]) {
        for (const row of list) {
          if (
            row.embedding != null ||
            row.embeddingProvider != null ||
            row.embeddingModel != null ||
            row.embeddingDim != null
          ) {
            row.embedding = null;
            row.embeddingProvider = null;
            row.embeddingModel = null;
            row.embeddingDim = null;
            cleared += 1;
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(store.meta, "embedding_space")) {
        delete store.meta.embedding_space;
      }
      scheduleSave();
      return { cleared };
    },
    // See the SQLite backend: true when any row still carries a stored vector
    // (not merely metadata without a vector).
    hasStoredVectors() {
      for (const list of [store.documents, store.memories, store.chunks]) {
        for (const row of list) {
          if (row.embedding != null) return true;
        }
      }
      return false;
    },
    forgetMemory(id, containerTag) {
      const row = store.memories.find((m) => m.id === id && m.containerTag === containerTag);
      if (!row) return null;
      row.status = "forgotten";
      scheduleSave();
      return row;
    },

    // ---- tenant-scoped content queries -----------------------------------
    listDocuments(containerTag) {
      return store.documents.filter((d) => d.containerTag === containerTag);
    },
    getDocument(id, containerTag) {
      return (
        store.documents.find((d) => d.id === id && d.containerTag === containerTag) || null
      );
    },
    findDocumentByHash(containerTag, contentHash) {
      if (!contentHash) return null;
      return (
        store.documents.find(
          (d) =>
            d.containerTag === containerTag && d.contentHash === contentHash && d.status === "ready"
        ) || null
      );
    },
    listChunks(containerTag) {
      return store.chunks.filter((c) => c.containerTag === containerTag);
    },
    listChunksByDocument(documentId, containerTag) {
      return store.chunks
        .filter((c) => c.documentId === documentId && c.containerTag === containerTag)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
    },
    addChunk(chunk) {
      if (chunk.embedding === undefined) chunk.embedding = null;
      store.chunks.push(stampEmbeddingMeta(chunk, embeddingMeta()));
      scheduleSave();
      return chunk;
    },
    deleteDocument(id, containerTag) {
      const doc = store.documents.find((d) => d.id === id && d.containerTag === containerTag);
      if (!doc) return null;
      // Only memories attributable to this source document are removed.
      store.memories = store.memories.filter(
        (m) => !(m.documentId === id && m.containerTag === containerTag)
      );
      store.chunks = store.chunks.filter(
        (c) => !(c.documentId === id && c.containerTag === containerTag)
      );
      store.documents = store.documents.filter(
        (d) => !(d.id === id && d.containerTag === containerTag)
      );
      scheduleSave();
      return doc;
    },
    listMemories(containerTag) {
      return store.memories.filter((m) => m.containerTag === containerTag);
    },
    getMemory(id, containerTag) {
      return store.memories.find((m) => m.id === id && m.containerTag === containerTag) || null;
    },
    supersedeSlot(containerTag, slot, iso) {
      const changed = [];
      for (const m of store.memories) {
        if (m.containerTag === containerTag && m.slot === slot && m.status === "active") {
          m.status = "superseded";
          m.supersededAt = iso;
          changed.push(m.id);
        }
      }
      if (changed.length) scheduleSave();
      return changed;
    },

    // ---- container ownership ---------------------------------------------
    getContainer(containerTag) {
      return store.containers.find((c) => c.containerTag === containerTag) || null;
    },
    listContainers(tenantId) {
      return store.containers
        .filter((c) => c.tenantId === tenantId)
        .sort((a, b) => a.containerTag.localeCompare(b.containerTag));
    },
    isContainerOwned(containerTag, tenantId) {
      const c = store.containers.find((x) => x.containerTag === containerTag);
      return Boolean(c) && c.tenantId === tenantId;
    },
    claimContainer(containerTag, tenantId) {
      const existing = store.containers.find((c) => c.containerTag === containerTag);
      if (existing) return existing.tenantId === tenantId;
      store.containers.push({ containerTag, tenantId, createdAt: new Date().toISOString() });
      scheduleSave();
      return true;
    },

    // ---- api keys --------------------------------------------------------
    createApiKey(record) {
      store.apiKeys.push(record);
      scheduleSave();
      return record;
    },
    getApiKeyByHash(keyHash) {
      return store.apiKeys.find((k) => k.keyHash === keyHash) || null;
    },
    touchApiKey(id, iso) {
      const key = store.apiKeys.find((k) => k.id === id);
      if (!key) return;
      key.lastUsedAt = iso;
      scheduleSave();
    },
    revokeApiKey(id, tenantId, iso) {
      const key = store.apiKeys.find(
        (k) => k.id === id && k.tenantId === tenantId && !k.revokedAt
      );
      if (!key) return 0;
      key.revokedAt = iso;
      scheduleSave();
      return 1;
    },
    listApiKeys(tenantId) {
      return store.apiKeys
        .filter((k) => k.tenantId === tenantId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map(({ keyHash, ...rest }) => rest);
    },
    // ---- key/value bookkeeping (e.g. the embedding space) ----------------
    getMeta(key) {
      return Object.prototype.hasOwnProperty.call(store.meta, key) ? store.meta[key] : null;
    },
    setMeta(key, value) {
      store.meta[key] = value == null ? null : String(value);
      scheduleSave();
    },
    touch() {
      scheduleSave();
    },
    flush() {
      persist();
    },
    close() {
      persist();
    },
    reset() {
      store = emptyStore();
      dirty = true;
      persist();
    },
    transaction(fn) {
      if (txDepth > 0) return fn(); // already inside a transaction
      const snapshot = structuredClone(store);
      txDepth += 1;
      try {
        const result = fn();
        persist();
        return result;
      } catch (err) {
        store = snapshot; // revert in-place mutations
        dirty = true;
        persist();
        throw err;
      } finally {
        txDepth -= 1;
      }
    },
  };

  // Last-resort flush on normal exit. Signal handling (SIGTERM/SIGINT) is owned
  // by server.js, which calls close() during graceful shutdown — registering a
  // signal listener here would suppress Node's default termination for scripts
  // that import the store directly.
  process.on("exit", () => {
    try {
      persist();
    } catch {
      /* ignore */
    }
  });

  return api;
}

module.exports = { create };

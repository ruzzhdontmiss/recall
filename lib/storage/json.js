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
  return { documents: [], memories: [], containers: [], apiKeys: [] };
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
    addDocument(doc) {
      if (doc.embedding === undefined) doc.embedding = null;
      store.documents.push(doc);
      scheduleSave();
      return doc;
    },
    addMemory(mem) {
      if (mem.embedding === undefined) mem.embedding = null;
      store.memories.push(mem);
      scheduleSave();
      return mem;
    },
    updateEmbedding(kind, id, vec) {
      const list = kind === "document" ? store.documents : store.memories;
      const row = list.find((x) => x.id === id);
      if (!row) return null;
      row.embedding = vec;
      scheduleSave();
      return row;
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

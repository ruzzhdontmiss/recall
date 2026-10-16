// SQLite storage backend (better-sqlite3) — durable replacement for the JSON
// store.
//
// Design note: we keep an in-memory mirror of documents/memories so the existing
// array-based read surface (`db.documents`, `db.memories`) used by server.js,
// lib/search.js and lib/extract/persist.js keeps working unchanged. Every write
// is committed to SQLite synchronously (WAL), so durability no longer depends on
// a debounce timer or a clean shutdown. On a failed transaction we reload the
// mirror from disk so in-place mutations are undone too.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { assertVector, encodeVector, decodeVector } = require("./vectors");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function embeddingMeta() {
  // Best-effort provider/model metadata. Never load a model just to describe it.
  try {
    const embeddings = require("../embeddings");
    if (typeof embeddings.describe === "function") return embeddings.describe();
  } catch {
    /* embeddings module unavailable (e.g. unit test) */
  }
  return { provider: null, model: null };
}

// ---- schema migrations ---------------------------------------------------

function applyMigrations(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version)
  );
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString()
      );
    });
    run();
  }
}

function openDatabase(file) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL"); // durability + concurrent readers
  db.pragma("busy_timeout = 5000"); // wait instead of throwing SQLITE_BUSY
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return db;
}

// ---- row <-> object mapping ---------------------------------------------

function rowToDocument(row) {
  const doc = {
    id: row.id,
    containerTag: row.container_tag,
    content: row.content,
    createdAt: row.created_at,
    embedding: decodeVector(row.embedding, row.embedding_dim),
  };
  // Upload metadata is only present on documents created via the upload route.
  // Raw-text documents (POST /v1/add) leave `source` null, so their shape is
  // unchanged from Phase 3.
  if (row.source != null) {
    doc.source = row.source;
    doc.filename = row.filename;
    doc.mediaType = row.media_type;
    doc.byteSize = row.byte_size;
    doc.contentHash = row.content_hash;
    doc.status = row.status;
    doc.errorCode = row.error_code;
    doc.pageCount = row.page_count;
    doc.storageKey = row.storage_key;
    doc.chunkCount = row.chunk_count;
    doc.updatedAt = row.updated_at;
    doc.previousDocumentId = row.previous_document_id;
  }
  return doc;
}

function rowToChunk(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    containerTag: row.container_tag,
    chunkIndex: row.chunk_index,
    page: row.page,
    charStart: row.char_start,
    charEnd: row.char_end,
    text: row.text,
    createdAt: row.created_at,
    embedding: decodeVector(row.embedding, row.embedding_dim),
  };
}

function rowToMemory(row) {
  const mem = {
    id: row.id,
    documentId: row.document_id,
    containerTag: row.container_tag,
    text: row.text,
    type: row.type,
    slot: row.slot,
    slotValue: row.slot_value,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    supersedes: row.supersedes,
    extractedBy: row.extracted_by,
    embedding: decodeVector(row.embedding, row.embedding_dim),
  };
  // Match the JSON store: supersededAt only present once a row is superseded.
  if (row.superseded_at != null) mem.supersededAt = row.superseded_at;
  return mem;
}

function rowToContainer(row) {
  return {
    containerTag: row.container_tag,
    tenantId: row.tenant_id,
    createdAt: row.created_at,
  };
}

function rowToApiKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    keyHash: row.key_hash,
    tenantId: row.tenant_id,
    defaultContainer: row.default_container,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
  };
}

const INSERT_DOCUMENT_SQL = `INSERT INTO documents
  (id, container_tag, content, created_at, embedding, embedding_provider, embedding_model, embedding_dim,
   source, filename, media_type, byte_size, content_hash, status, error_code, page_count, storage_key,
   chunk_count, updated_at, previous_document_id)
  VALUES (@id, @containerTag, @content, @createdAt, @embedding, @embeddingProvider, @embeddingModel, @embeddingDim,
   @source, @filename, @mediaType, @byteSize, @contentHash, @status, @errorCode, @pageCount, @storageKey,
   @chunkCount, @updatedAt, @previousDocumentId)`;

const INSERT_MEMORY_SQL = `INSERT INTO memories
  (id, document_id, container_tag, text, type, slot, slot_value, status, created_at,
   expires_at, superseded_at, supersedes, extracted_by, embedding, embedding_provider, embedding_model, embedding_dim)
  VALUES (@id, @documentId, @containerTag, @text, @type, @slot, @slotValue, @status, @createdAt,
   @expiresAt, @supersededAt, @supersedes, @extractedBy, @embedding, @embeddingProvider, @embeddingModel, @embeddingDim)`;

function insertDocument(db, doc, meta = { provider: null, model: null }) {
  const embedding = assertVector(doc.embedding ?? null);
  const info = db.prepare(INSERT_DOCUMENT_SQL).run({
    id: doc.id,
    containerTag: doc.containerTag,
    content: doc.content,
    createdAt: doc.createdAt,
    embedding: encodeVector(embedding),
    embeddingProvider: meta.provider ?? null,
    embeddingModel: meta.model ?? null,
    embeddingDim: embedding ? embedding.length : null,
    source: doc.source ?? null,
    filename: doc.filename ?? null,
    mediaType: doc.mediaType ?? null,
    byteSize: doc.byteSize ?? null,
    contentHash: doc.contentHash ?? null,
    status: doc.status ?? null,
    errorCode: doc.errorCode ?? null,
    pageCount: doc.pageCount ?? null,
    storageKey: doc.storageKey ?? null,
    chunkCount: doc.chunkCount ?? null,
    updatedAt: doc.updatedAt ?? null,
    previousDocumentId: doc.previousDocumentId ?? null,
  });
  return info.changes;
}

const INSERT_CHUNK_SQL = `INSERT INTO chunks
  (id, document_id, container_tag, chunk_index, page, char_start, char_end, text, created_at,
   embedding, embedding_provider, embedding_model, embedding_dim)
  VALUES (@id, @documentId, @containerTag, @chunkIndex, @page, @charStart, @charEnd, @text, @createdAt,
   @embedding, @embeddingProvider, @embeddingModel, @embeddingDim)`;

function insertChunk(db, chunk, meta = { provider: null, model: null }) {
  const embedding = assertVector(chunk.embedding ?? null);
  const info = db.prepare(INSERT_CHUNK_SQL).run({
    id: chunk.id,
    documentId: chunk.documentId,
    containerTag: chunk.containerTag,
    chunkIndex: chunk.chunkIndex,
    page: chunk.page ?? null,
    charStart: chunk.charStart ?? null,
    charEnd: chunk.charEnd ?? null,
    text: chunk.text,
    createdAt: chunk.createdAt,
    embedding: encodeVector(embedding),
    embeddingProvider: meta.provider ?? null,
    embeddingModel: meta.model ?? null,
    embeddingDim: embedding ? embedding.length : null,
  });
  return info.changes;
}

function insertMemory(db, mem, meta = { provider: null, model: null }) {
  const embedding = assertVector(mem.embedding ?? null);
  const info = db.prepare(INSERT_MEMORY_SQL).run({
    id: mem.id,
    documentId: mem.documentId,
    containerTag: mem.containerTag,
    text: mem.text,
    type: mem.type,
    slot: mem.slot ?? null,
    slotValue: mem.slotValue ?? null,
    status: mem.status,
    createdAt: mem.createdAt,
    expiresAt: mem.expiresAt ?? null,
    supersededAt: mem.supersededAt ?? null,
    supersedes: mem.supersedes ?? null,
    extractedBy: mem.extractedBy ?? null,
    embedding: encodeVector(embedding),
    embeddingProvider: meta.provider ?? null,
    embeddingModel: meta.model ?? null,
    embeddingDim: embedding ? embedding.length : null,
  });
  return info.changes;
}

// ---- adapter -------------------------------------------------------------

class SqliteStore {
  constructor(db, file) {
    this.backend = "sqlite";
    this.file = file;
    this.db = db;
    this.reload();
  }

  reload() {
    this.docs = this.db
      .prepare("SELECT * FROM documents ORDER BY rowid")
      .all()
      .map(rowToDocument);
    this.mems = this.db
      .prepare("SELECT * FROM memories ORDER BY rowid")
      .all()
      .map(rowToMemory);
  }

  get documents() {
    return this.docs;
  }

  get memories() {
    return this.mems;
  }

  isEmpty() {
    return this.docs.length === 0 && this.mems.length === 0;
  }

  addDocument(doc) {
    if (doc.embedding === undefined) doc.embedding = null;
    insertDocument(this.db, doc, embeddingMeta());
    this.docs.push(doc);
    return doc;
  }

  addMemory(mem) {
    if (mem.embedding === undefined) mem.embedding = null;
    insertMemory(this.db, mem, embeddingMeta());
    this.mems.push(mem);
    return mem;
  }

  updateEmbedding(kind, id, vec) {
    const embedding = assertVector(vec);
    const table = kind === "document" ? "documents" : kind === "memory" ? "memories" : "chunks";
    const meta = embeddingMeta();
    const info = this.db
      .prepare(
        `UPDATE ${table} SET embedding = ?, embedding_provider = ?, embedding_model = ?, embedding_dim = ? WHERE id = ?`
      )
      .run(
        encodeVector(embedding),
        meta.provider ?? null,
        meta.model ?? null,
        embedding ? embedding.length : null,
        id
      );
    if (info.changes === 0) return null;
    if (kind === "chunk") return { id, embedding };
    const list = kind === "document" ? this.docs : this.mems;
    const row = list.find((x) => x.id === id);
    if (row) row.embedding = embedding;
    return row;
  }

  // Ownership is enforced here, at the data-access boundary: a memory is only
  // forgotten when both its id AND containerTag match.
  forgetMemory(id, containerTag) {
    const info = this.db
      .prepare("UPDATE memories SET status = 'forgotten' WHERE id = ? AND container_tag = ?")
      .run(id, containerTag);
    if (info.changes === 0) return null;
    const row = this.mems.find((m) => m.id === id && m.containerTag === containerTag);
    if (row) row.status = "forgotten";
    return row || { id, status: "forgotten" };
  }

  // ---- tenant-scoped content queries ------------------------------------
  // Route handlers use these instead of the in-memory arrays so a query can
  // never accidentally span containers. They read fresh from SQLite, which is
  // safe because every write is committed synchronously.

  listDocuments(containerTag) {
    return this.db
      .prepare("SELECT * FROM documents WHERE container_tag = ? ORDER BY rowid")
      .all(containerTag)
      .map(rowToDocument);
  }

  getDocument(id, containerTag) {
    const row = this.db
      .prepare("SELECT * FROM documents WHERE id = ? AND container_tag = ?")
      .get(id, containerTag);
    return row ? rowToDocument(row) : null;
  }

  // Dedupe only considers fully-processed documents; a previously failed upload
  // must never block a fresh attempt with the same bytes.
  findDocumentByHash(containerTag, contentHash) {
    if (!contentHash) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM documents
          WHERE container_tag = ? AND content_hash = ? AND status = 'ready'
          ORDER BY rowid LIMIT 1`
      )
      .get(containerTag, contentHash);
    return row ? rowToDocument(row) : null;
  }

  // ---- chunks (uploaded-document passages) ------------------------------

  listChunks(containerTag) {
    return this.db
      .prepare("SELECT * FROM chunks WHERE container_tag = ? ORDER BY rowid")
      .all(containerTag)
      .map(rowToChunk);
  }

  listChunksByDocument(documentId, containerTag) {
    return this.db
      .prepare(
        "SELECT * FROM chunks WHERE document_id = ? AND container_tag = ? ORDER BY chunk_index"
      )
      .all(documentId, containerTag)
      .map(rowToChunk);
  }

  addChunk(chunk) {
    if (chunk.embedding === undefined) chunk.embedding = null;
    insertChunk(this.db, chunk, embeddingMeta());
    return chunk;
  }

  // Delete a source document together with its chunks and ONLY the memories that
  // are attributable to it (matched by document_id), all scoped to the
  // container. Ownership is enforced here, at the data-access boundary.
  deleteDocument(id, containerTag) {
    const doc = this.getDocument(id, containerTag);
    if (!doc) return null;
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM memories WHERE document_id = ? AND container_tag = ?")
        .run(id, containerTag);
      this.db
        .prepare("DELETE FROM chunks WHERE document_id = ? AND container_tag = ?")
        .run(id, containerTag);
      this.db
        .prepare("DELETE FROM documents WHERE id = ? AND container_tag = ?")
        .run(id, containerTag);
    })();
    this.reload();
    return doc;
  }

  listMemories(containerTag) {
    return this.db
      .prepare("SELECT * FROM memories WHERE container_tag = ? ORDER BY rowid")
      .all(containerTag)
      .map(rowToMemory);
  }

  getMemory(id, containerTag) {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ? AND container_tag = ?")
      .get(id, containerTag);
    return row ? rowToMemory(row) : null;
  }

  // ---- container ownership (tenant isolation) ---------------------------
  // Queried directly from SQLite (not the in-memory mirror) so ownership stays
  // correct even when another process, such as the key CLI, wrote it.

  getContainer(containerTag) {
    const row = this.db
      .prepare("SELECT * FROM containers WHERE container_tag = ?")
      .get(containerTag);
    return row ? rowToContainer(row) : null;
  }

  listContainers(tenantId) {
    return this.db
      .prepare("SELECT * FROM containers WHERE tenant_id = ? ORDER BY container_tag")
      .all(tenantId)
      .map(rowToContainer);
  }

  isContainerOwned(containerTag, tenantId) {
    const row = this.db
      .prepare("SELECT tenant_id FROM containers WHERE container_tag = ?")
      .get(containerTag);
    return Boolean(row) && row.tenant_id === tenantId;
  }

  // Claim a container for a tenant if it is free. Returns false when the tag is
  // already owned by another tenant. Implemented as a single atomic statement so
  // two tenants racing for the same tag cannot both win (and the loser gets a
  // clean "false", never a constraint error): the PRIMARY KEY conflict is
  // ignored, and 0 changed rows means we lost the race.
  claimContainer(containerTag, tenantId) {
    const existing = this.getContainer(containerTag);
    if (existing) return existing.tenantId === tenantId;
    const info = this.db
      .prepare(
        `INSERT INTO containers (container_tag, tenant_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(container_tag) DO NOTHING`
      )
      .run(containerTag, tenantId, new Date().toISOString());
    if (info.changes === 1) return true;
    const winner = this.getContainer(containerTag);
    return Boolean(winner) && winner.tenantId === tenantId;
  }

  // ---- api keys ----------------------------------------------------------

  createApiKey(record) {
    this.db
      .prepare(
        `INSERT INTO api_keys
          (id, key_hash, tenant_id, default_container, name, created_at, last_used_at, revoked_at, expires_at)
         VALUES (@id, @keyHash, @tenantId, @defaultContainer, @name, @createdAt, @lastUsedAt, @revokedAt, @expiresAt)`
      )
      .run({
        id: record.id,
        keyHash: record.keyHash,
        tenantId: record.tenantId,
        defaultContainer: record.defaultContainer,
        name: record.name ?? null,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt ?? null,
        revokedAt: record.revokedAt ?? null,
        expiresAt: record.expiresAt ?? null,
      });
    return record;
  }

  getApiKeyByHash(keyHash) {
    return rowToApiKey(this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash));
  }

  touchApiKey(id, iso) {
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(iso, id);
  }

  // Revocation is tenant-scoped so one tenant can never revoke another's key.
  revokeApiKey(id, tenantId, iso) {
    return this.db
      .prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL"
      )
      .run(iso, id, tenantId).changes;
  }

  // Never returns key hashes — listing must not expose or enable offline attacks.
  listApiKeys(tenantId) {
    return this.db
      .prepare(
        `SELECT id, tenant_id, default_container, name, created_at, last_used_at, revoked_at, expires_at
         FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`
      )
      .all(tenantId)
      .map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        defaultContainer: row.default_container,
        name: row.name,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
        expiresAt: row.expires_at,
      }));
  }

  // Supersede every active memory in a container/slot, writing through to the
  // database. Without this, supersession only lived in the in-memory mirror and
  // was silently lost on restart.
  supersedeSlot(containerTag, slot, iso) {
    const ids = this.db
      .prepare(
        "SELECT id FROM memories WHERE container_tag = ? AND slot = ? AND status = 'active'"
      )
      .all(containerTag, slot)
      .map((r) => r.id);
    if (!ids.length) return [];
    const stmt = this.db.prepare(
      "UPDATE memories SET status = 'superseded', superseded_at = ? WHERE id = ? AND status = 'active'"
    );
    const changed = [];
    this.db.transaction(() => {
      for (const id of ids) {
        if (stmt.run(iso, id).changes) changed.push(id);
      }
    })();
    for (const mem of this.mems) {
      if (changed.includes(mem.id)) {
        mem.status = "superseded";
        mem.supersededAt = iso;
      }
    }
    return changed;
  }

  // Synchronous grouped write. The callback must be synchronous (better-sqlite3
  // transactions cannot span await points). On throw the transaction rolls back
  // and the in-memory mirror is reloaded so in-place mutations are reverted too.
  transaction(fn) {
    const run = this.db.transaction(() => fn());
    try {
      return run();
    } catch (err) {
      this.reload();
      throw err;
    }
  }

  touch() {
    /* writes are already durable in SQLite; nothing to debounce */
  }

  flush() {
    /* durability is immediate; intentionally a no-op */
  }

  close() {
    if (this.db && this.db.open) this.db.close();
  }

  reset() {
    this.db.exec(
      "DELETE FROM chunks; DELETE FROM memories; DELETE FROM documents; DELETE FROM containers; DELETE FROM api_keys;"
    );
    this.reload();
  }
}

function create({ file }) {
  const db = openDatabase(file);
  return new SqliteStore(db, file);
}

module.exports = {
  create,
  openDatabase,
  applyMigrations,
  insertDocument,
  insertMemory,
  insertChunk,
  rowToDocument,
  rowToMemory,
  rowToChunk,
  rowToContainer,
  rowToApiKey,
  SqliteStore,
};

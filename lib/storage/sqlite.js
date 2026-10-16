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
  return {
    id: row.id,
    containerTag: row.container_tag,
    content: row.content,
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

const INSERT_DOCUMENT_SQL = `INSERT INTO documents
  (id, container_tag, content, created_at, embedding, embedding_provider, embedding_model, embedding_dim)
  VALUES (@id, @containerTag, @content, @createdAt, @embedding, @embeddingProvider, @embeddingModel, @embeddingDim)`;

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
    const table = kind === "document" ? "documents" : "memories";
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
    this.db.exec("DELETE FROM memories; DELETE FROM documents;");
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
  rowToDocument,
  rowToMemory,
  SqliteStore,
};

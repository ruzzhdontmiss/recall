-- Phase 2 initial schema.
--
-- Timestamps are stored as ISO-8601 TEXT (identical to the JSON store) so the
-- migration is a straight copy and nothing is reinterpreted. Embeddings are
-- stored as Float64 BLOBs plus provider/model/dimension metadata so mismatched
-- vectors can be detected and re-embedded safely.

CREATE TABLE documents (
  id                 TEXT PRIMARY KEY,
  container_tag      TEXT NOT NULL,
  content            TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  embedding          BLOB,
  embedding_provider TEXT,
  embedding_model    TEXT,
  embedding_dim      INTEGER
);

CREATE INDEX idx_documents_container ON documents (container_tag);
CREATE INDEX idx_documents_created   ON documents (created_at);

CREATE TABLE memories (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents (id),
  container_tag      TEXT NOT NULL,
  text               TEXT NOT NULL,
  type               TEXT NOT NULL,
  slot               TEXT,
  slot_value         TEXT,
  status             TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  expires_at         TEXT,
  superseded_at      TEXT,
  supersedes         TEXT,
  extracted_by       TEXT,
  embedding          BLOB,
  embedding_provider TEXT,
  embedding_model    TEXT,
  embedding_dim      INTEGER
);

CREATE INDEX idx_memories_container   ON memories (container_tag);
CREATE INDEX idx_memories_doc         ON memories (document_id);
CREATE INDEX idx_memories_status      ON memories (status);
CREATE INDEX idx_memories_expires     ON memories (expires_at);
CREATE INDEX idx_memories_slot        ON memories (container_tag, slot, status);

-- Small key/value table for schema/embedding bookkeeping (e.g. the embedding
-- provider that produced the stored vectors).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

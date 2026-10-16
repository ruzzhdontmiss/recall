-- Phase 4: uploaded-document ingestion.
--
-- Additive only: existing rows in `documents` keep working (every new column is
-- nullable). Raw-text ingestion via POST /v1/add doesn't set the upload columns,
-- so its behaviour and shapes are unchanged. `chunks` holds the searchable
-- passages of an uploaded file; source documents stay distinct from extracted
-- user memories.

ALTER TABLE documents ADD COLUMN source               TEXT;     -- 'text' | 'upload'
ALTER TABLE documents ADD COLUMN filename             TEXT;     -- original name (display metadata only)
ALTER TABLE documents ADD COLUMN media_type           TEXT;     -- detected content type
ALTER TABLE documents ADD COLUMN byte_size            INTEGER;
ALTER TABLE documents ADD COLUMN content_hash         TEXT;     -- sha256 of raw bytes (dedupe / versioning)
ALTER TABLE documents ADD COLUMN status               TEXT;     -- 'ready' | 'failed'
ALTER TABLE documents ADD COLUMN error_code           TEXT;
ALTER TABLE documents ADD COLUMN page_count           INTEGER;
ALTER TABLE documents ADD COLUMN storage_key          TEXT;     -- server-generated relative path (never user input)
ALTER TABLE documents ADD COLUMN chunk_count          INTEGER;
ALTER TABLE documents ADD COLUMN updated_at           TEXT;
ALTER TABLE documents ADD COLUMN previous_document_id TEXT;     -- version lineage (NOT implicit supersession)

CREATE INDEX idx_documents_hash ON documents (container_tag, content_hash);

CREATE TABLE chunks (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  container_tag      TEXT NOT NULL,
  chunk_index        INTEGER NOT NULL,
  page               INTEGER,   -- 1-based PDF page where available
  char_start         INTEGER,
  char_end           INTEGER,
  text               TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  embedding          BLOB,
  embedding_provider TEXT,
  embedding_model    TEXT,
  embedding_dim      INTEGER
);

CREATE INDEX idx_chunks_document  ON chunks (document_id);
CREATE INDEX idx_chunks_container ON chunks (container_tag);
CREATE UNIQUE INDEX idx_chunks_doc_index ON chunks (document_id, chunk_index);

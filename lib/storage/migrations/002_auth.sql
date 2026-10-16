-- Phase 3: authentication, tenant ownership and API keys.
--
-- Only SHA-256 hashes of API keys are stored; the raw secret is never persisted.
-- Containers are owned by exactly one tenant; this table is the authorization
-- source of truth for "which tenant may touch this containerTag".

CREATE TABLE containers (
  container_tag TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_containers_tenant ON containers (tenant_id);

CREATE TABLE api_keys (
  id                TEXT PRIMARY KEY,
  key_hash          TEXT NOT NULL UNIQUE,
  tenant_id         TEXT NOT NULL,
  default_container TEXT NOT NULL,
  name              TEXT,
  created_at        TEXT NOT NULL,
  last_used_at      TEXT,
  revoked_at        TEXT,
  expires_at        TEXT
);

CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id);

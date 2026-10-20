# Recall — self-hosted AI memory infrastructure

Recall is a small, self-contained memory engine for AI applications: it ingests raw
text, extracts durable and temporary facts, keeps them consistent over time (supersession
and expiry), and serves them back through hybrid semantic search and a user profile.

It is *memory infrastructure*, not a chatbot. A consuming agent or app calls Recall to
store what it learns and to retrieve relevant context, then uses that context when
generating a response.

The whole loop runs locally with **no external services or cloud keys required** for the
default path — local embeddings, a regex extractor fallback, and a single SQLite file.
Optional provider keys upgrade embeddings and extraction to hosted models.

```mermaid
flowchart LR
  A[Client / agent] -->|POST /v1/add| B(Extract facts)
  B --> C{LLM key set?}
  C -- yes --> D[Structured LLM extraction]
  C -- no --> E[Regex extraction]
  D --> F[Supersession + TTL]
  E --> F
  F --> G[(SQLite + vectors)]
  A -->|GET /v1/search| H[Hybrid ranking]
  A -->|GET /v1/profile| I[Static + dynamic facts]
  G --> H
  G --> I
```

## Why it exists

Hosted "memory" APIs make the core mechanics invisible. Recall implements the same
mechanics end-to-end in readable code so they can be studied, extended, and self-hosted:

- **Structured fact extraction** — an LLM (OpenAI / Anthropic / Gemini) emits typed facts
  through a JSON schema; a deterministic regex extractor keeps the app working offline.
- **Memory lifecycle** — slot-based supersession resolves contradictions ("I live in
  Berlin" → "I now live in Lisbon") and temporal keywords give temporary facts a TTL.
- **Semantic retrieval** — local `bge-base-en-v1.5` embeddings power hybrid search over
  both memories and the raw source documents.
- **Persistence** — a transactional SQLite backend (WAL) with explicit schema migrations
  and embeddings stored alongside each row.
- **Document ingestion** — upload `.txt`/`.md`/`.pdf`; files are validated, stored privately,
  chunked (PDF page-aware) and made searchable with provenance back to the source passage.
- **Tenant-scoped API access** — hashed, scoped API keys with container ownership enforced
  in the data layer.

## Architecture

```
server.js                 Express app: routes, auth, tenant isolation, limits, health, shutdown
lib/config.js             env reading + fail-fast validation (server + document limits)
lib/auth.js               API-key issuance/hashing, auth middleware, container authorization
lib/validate.js           request / identifier / container / payload-size validation
lib/ratelimit.js          in-memory per-key rate limiter
lib/db.js                 compatibility shim → lib/storage
lib/storage/index.js      backend selection + facade (STORAGE_BACKEND)
lib/storage/sqlite.js     SQLite backend (better-sqlite3, WAL, transactions, indexes)
lib/storage/json.js       legacy JSON backend (kept for rollback)
lib/storage/migrations/   explicit SQL schema migrations (001 storage, 002 auth, 003 documents)
lib/storage/vectors.js    embedding encode/decode + validation
lib/documents/            upload pipeline: storage, extract (txt/md/pdf), pdf-worker, chunk, ingest
lib/extract.js            orchestrates LLM vs regex; applies slot/TTL mechanics
lib/extract/              openai / anthropic / gemini structured extractors + regex
lib/embeddings/           xenova (default) / openai / gemini / tfidf
lib/search.js             hybrid ranking over stored vectors
lib/tfidf.js              TF-IDF fallback scorer
public/                   vanilla HTML/CSS/JS dashboard (API-key field + authenticated calls)
scripts/                  key CLI, migrations, evaluation scripts, smoke test + matrix
test/                     node:test regression suite
Dockerfile / docker-compose.yml / .github/workflows/ci.yml   deployment + CI
```

## How a memory flows through Recall

1. **Ingest** — `POST /v1/add` accepts raw text and stores the source document.
2. **Extract** — the text is classified into typed facts. With a provider key, an LLM
   returns structured JSON; otherwise the regex extractor runs. Each fact becomes a memory.
3. **Persist** — document and memories are written in a single transaction, with embeddings
   attached when the embedding provider is dense.
4. **Resolve** — a new fact in an existing *slot* (location, employer, editor, …) supersedes
   the older one; dynamic facts get an expiry derived from temporal keywords and are
   filtered out on read once expired.
5. **Retrieve** — `GET /v1/search` ranks memories + documents by vector cosine similarity
   (or TF-IDF when no dense provider is available); `GET /v1/profile` returns static
   (durable) and dynamic (temporary) facts.

## How a document flows through Recall

`POST /v1/documents/upload` ingests a file (`.txt`, `.md`, `.pdf`) and makes its text
searchable at passage granularity:

1. **Validate** — filename, extension, declared content type and magic bytes must agree; size,
   page count, extracted length and chunk count are all bounded. Anything else is rejected.
2. **Deduplicate** — the SHA-256 of the bytes identifies an identical, already-processed upload
   in the same container; it returns the existing document and creates no new chunks.
3. **Extract** — text is pulled per page for PDFs and normalized. PDF parsing runs in a
   dedicated **worker thread**, never in the main server process: each job has a wall-clock
   deadline (the thread is terminated when it expires), the number of concurrent parsers and
   the queue behind them are bounded, and a parser crash or timeout fails only that upload.
4. **Chunk** — text is split into overlapping passages (paragraph/sentence-aware) with character
   offsets and, for PDFs, the page number.
5. **Embed** — chunks are embedded in batches when a dense provider is configured; embedding is
   best-effort and a failure leaves the chunk lexically searchable rather than lost.
6. **Persist** — the document row and its chunks are written in one transaction after the file
   is committed to private storage; any failure removes the file and records a `failed` row.
7. **Retrieve** — chunks appear in `/v1/search` results with `source: "chunk"`, `documentId`,
   `filename` and `page`, so every hit is traceable to its source document and passage.

Fact extraction from an upload is **off by default**. Add `?extractFacts=true` to derive
memories, which are then attributed to the source document (`documentId`) and removed with it.

## Quick start

```bash
npm install

# Bootstrap your first API key (offline CLI — shown once, then hashed):
npm run key:create -- --tenant alice --container my_space
#   API key created. This secret is shown ONCE — store it now.
#     sm_…
#     tenant:    alice
#     container: my_space

npm start
# open http://localhost:6767 and paste the key into the "api key" field
```

Requires **Node.js >= 22** (developed and tested on Node 23.11; the PDF extractor `unpdf`
targets Node 22+). Data is stored in SQLite by default (`data/recall.db`), and uploaded files
under `data/uploads/`.

On the first request with the default embedding provider, `bge-base-en-v1.5` (~100 MB) is
downloaded and cached. After that, search is local and key-free.

## Configuration

Copy `.env.example` to `.env` (never commit it) and adjust. Everything has a working
default; the variables below are the full surface. Values are validated at startup: an
explicitly-set invalid value (a bad port, a wildcard CORS origin, a non-numeric limit, a
`HOST` containing a scheme or path) makes the process exit non-zero with a clear message
rather than silently falling back.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `6767` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. Loopback by default; set `0.0.0.0` only behind TLS/firewall with `AUTH_MODE=required`. |
| `NODE_ENV` | *(unset)* | Set to `production` in production. Also makes `AUTH_MODE=dev` a startup error. |
| `DATA_DIR` | `./data` | Base directory for the database. |
| `STORAGE_BACKEND` | `sqlite` | `sqlite` (default) or `json` (legacy/rollback). |
| `SQLITE_FILE` / `STORE_FILE` | `data/recall.db` / `data/store.json` | Explicit file paths. |
| `AUTH_MODE` | `required` | `required`, or `dev` for a local single-tenant bypass. |
| `DEV_TENANT` / `DEV_CONTAINER` | `dev` / `dev` | Tenant/container used in `dev` mode. |
| `RATE_LIMIT_PER_MIN` | `120` | Per-key overall request budget. |
| `RATE_LIMIT_EXPENSIVE_PER_MIN` | `30` | Budget for embedding/LLM operations. |
| `CORS_ORIGINS` | *(off)* | Explicit comma-separated allowlist. Never a wildcard. |
| `EMBEDDINGS_PROVIDER` | `xenova` | `xenova` \| `openai` \| `gemini` \| `tfidf`. |
| `EMBEDDINGS_MODEL` | provider default | Override the embedding model id. |
| `EMBEDDINGS_DTYPE` | `q8` | Local precision. Changing it changes the vector space (stale vectors are re-embedded on access; run `npm run embeddings:reindex`). |
| `EMBEDDINGS_CACHE_DIR` | *(inside `node_modules`)* | Durable model cache directory (survives `npm ci`). |
| `EMBEDDINGS_LOCAL_MODEL_PATH` | *(unset)* | Load models from a local directory (offline installs). |
| `EMBEDDINGS_OFFLINE` | `false` | Never fetch models from the network. |
| `EXTRACTION_PROVIDER` | `auto` | `auto` \| `openai` \| `anthropic` \| `gemini` \| `regex`. |
| `EXTRACTION_MODEL` | provider default | Override the extraction model id. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` | *(empty)* | Provider credentials. |
| `UPLOAD_DIR` | `DATA_DIR/uploads` | Private directory for uploaded files (dirs `0700`, files `0600`). |
| `MAX_UPLOAD_BYTES` | `10485760` (10 MiB) | Hard cap on a single uploaded file. |
| `MAX_PDF_PAGES` | `500` | Reject PDFs with more pages. |
| `PDF_EXTRACT_TIMEOUT_MS` | `20000` | Wall-clock bound on PDF parsing; the worker thread is terminated when exceeded. |
| `PDF_MAX_CONCURRENT` | `2` | PDFs parsed at once (one worker thread each). |
| `PDF_MAX_QUEUE` | `64` | Uploads that may wait for a PDF worker slot before the API returns `503` (`pdf_busy`). |
| `PDF_WORKER_HEAP_MB` | `0` | Per-worker V8 old-space cap in MiB (`0` = Node default). |
| `MAX_EXTRACTED_CHARS` | `2000000` | Reject documents that extract more text than this. |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1200` / `200` | Chunking window and overlap (characters). |
| `MAX_CHUNKS` | `2000` | Reject documents that produce more chunks. |
| `EMBED_BATCH_SIZE` | `64` | Chunks embedded per batch. |

### API-key bootstrap

There is deliberately **no unauthenticated HTTP admin endpoint**. Use the offline CLI,
which talks to the same database:

```bash
# The first key: name a tenant and a container (the container is created/claimed).
npm run key:create -- --tenant alice --container demo_user --name "alice laptop"

# Existing-data migration: adopt a pre-existing container tag.
#   e.g. if your old tags were user_123 / demo_user, create keys with those --container values.
```

### Command-line client

`npm run recall` is a small client for a **running** server (local or private remote). It uses
`RECALL_URL` (default `http://127.0.0.1:6767`) and `RECALL_API_KEY`, or `--url` / `--key`:

```bash
export RECALL_URL=http://127.0.0.1:6767
export RECALL_API_KEY=sm_…

npm run recall -- whoami
npm run recall -- add "I'm a backend engineer in Berlin."
npm run recall -- search "where does this person work" --mode hybrid
npm run recall -- memories
npm run recall -- upload ./notes.pdf
npm run recall -- documents
npm run recall -- document <id>        # status, filename and source passages
npm run recall -- delete <id> --yes    # destructive: --yes is required
npm run recall -- forget <memoryId> --yes
```

Every command accepts `--container <tag>` (default: the key's container) and `--json`. A failed
operation — invalid input, an HTTP error, or a **failed ingestion** — exits non-zero;
destructive commands without `--yes` exit `2` and change nothing.

### Browser dashboard

Serving `/` (the private, same-origin dashboard) lets you add memories, search, inspect the
profile, list/forget memories and click any document to see its source passages. Enter your API
key in the header (kept only in this browser's `localStorage`); the dashboard talks exclusively
to the public `/v1` API, so embedding vectors, provider/model bookkeeping and server-side paths
never reach the browser.

## Authentication and multi-tenancy

All `/v1` endpoints require a bearer API key:

```
Authorization: Bearer sm_…
```

- **Keys are hashed, never stored raw.** A key is `sm_` + 32 random bytes; only its SHA-256
  hash is persisted. The raw secret is shown **once**, when you create it.
- **Scoped keys.** Each key maps to exactly one `tenant` and one default `container`. The
  container named in a request (`?containerTag=…`) is a *selector*, never proof of ownership:
  you can only touch containers your tenant owns. Supplying a container that belongs to
  another tenant returns `403`, and so does a container you have never written to.
- **Ownership is enforced in the data layer** (`lib/storage`), not just in the routes, so a
  query cannot accidentally span containers.
- `/v1/containers` is authenticated and only ever returns *your* containers.

### Rotation and revocation

```bash
# List keys for a tenant (ids, container, created/last-used, revoked state — never the secret)
npm run key:list -- --tenant alice

# Create an additional key for the same tenant (rotation: issue new, then revoke old)
npm run key:create -- --tenant alice --container my_space

# Revoke by key id, or by presenting the raw key
npm run key:revoke -- --tenant alice --id key_xxx
npm run key:revoke -- --tenant alice --key sm_xxx
```

Revocation is immediate and tenant-scoped (one tenant can never revoke another's key).
Revoked and expired keys return `401`. A key may be created with `--expires 2027-01-01T00:00:00Z`.

### Local development mode

For local scripting without a key you may explicitly opt in:

```bash
AUTH_MODE=dev DEV_TENANT=dev DEV_CONTAINER=dev npm start
```

Dev mode maps **every** unauthenticated request to a single configured tenant/container and
prints a loud warning. It refuses to start when `NODE_ENV=production`. It is off unless you
set it — authentication is never silently bypassed.

### Rate limiting

Per-key request limits are enforced **in memory, in a single process** (defaults:
`RATE_LIMIT_PER_MIN=120` overall, `RATE_LIMIT_EXPENSIVE_PER_MIN=30` for the embedding/LLM
operations: `POST /v1/add`, `GET /v1/search`, and `GET /v1/profile` when a `q` is supplied).
Exceeding a limit returns `429` with a `Retry-After` header. Counters are not shared across
processes — see [Limitations](#limitations).

### CORS

CORS is **off by default** (the bundled dashboard is same-origin). To allow browser clients
from other origins, set an explicit allowlist — never a wildcard:

```bash
CORS_ORIGINS=https://app.example.com,https://admin.example.com npm start
```

### Network exposure

Recall binds to **`127.0.0.1` by default**, so a fresh install is not reachable from another
machine until you deliberately set `HOST=0.0.0.0` (or a specific interface). If you bind to a
non-loopback address the server logs a warning to that effect. Before exposing it:

1. Keep `AUTH_MODE=required` (the server refuses `dev` when `NODE_ENV=production`).
2. Put TLS in front (a reverse proxy) — Recall speaks plain HTTP.
3. Restrict reachability with a firewall or private network; never publish it directly.

Defence-in-depth that is always on:

- **Every `/v1` route requires a bearer key**; the dashboard page itself holds no data and no
  secrets (it prompts for a key, kept only in the browser's `localStorage`).
- **Strict browser headers** on every response: a self-only `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy`/`-Resource-Policy: same-origin`, and a locked-down
  `Permissions-Policy`. `X-Powered-By` is disabled.
- **CSRF does not apply**: authentication is a bearer token in a header (no cookies, no ambient
  credentials), so a cross-site form cannot authenticate a state-changing request.
- **Uploads are validated by magic bytes** and stored under server-generated names — the client
  filename is metadata only, so path traversal is impossible.
- **Errors are generic and redacted** — no stack traces, paths or secrets reach the client, and
  request bodies/headers are never logged.

## API

All endpoints require `Authorization: Bearer <key>`. `containerTag` is an optional selector
that must name a container your tenant owns; if omitted, the key's default container is used.
There is no implicit `demo_user` default.

```bash
KEY=sm_…   # from `npm run key:create`

# Add content — facts get extracted automatically
curl -X POST localhost:6767/v1/add -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content":"I am a backend engineer. I live in Berlin. I prefer Rust over Go.","containerTag":"user_123"}'

# Hybrid search (memories + documents). searchMode: hybrid | memories | documents
# -> { results, searchMode, containerTag, embeddingsProvider, ranking }
#    `ranking` is "dense" | "lexical" | "none" — it reports how THIS response was
#    actually ranked, so a lexical fallback is never reported as semantic search.
curl -H "Authorization: Bearer $KEY" "localhost:6767/v1/search?q=where+does+the+user+live&containerTag=user_123&searchMode=hybrid"

# User profile: static (durable) + dynamic (temporary) facts
curl -H "Authorization: Bearer $KEY" "localhost:6767/v1/profile?containerTag=user_123"

# All memories, including superseded/expired ones (for transparency/debugging)
curl -H "Authorization: Bearer $KEY" "localhost:6767/v1/memories?containerTag=user_123"

# Forget a memory
curl -X DELETE -H "Authorization: Bearer $KEY" "localhost:6767/v1/memories/<id>?containerTag=user_123"

# Upload a document (.txt | .md | .pdf). Raw body; the original name is metadata only.
curl -X POST localhost:6767/v1/documents/upload \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: text/markdown" \
  -H "X-Recall-Filename: notes.md" \
  --data-binary @notes.md
# -> 201 { duplicate:false, document:{ id, source:"upload", filename, mediaType, pageCount, status:"ready", ... }, chunkCount, memoriesExtracted:0 }

# Optional: also extract memories from the upload (attributed to the document)
curl -X POST "localhost:6767/v1/documents/upload?extractFacts=true&containerTag=user_123" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/pdf" \
  -H "X-Recall-Filename: resume.pdf" --data-binary @resume.pdf

# Document metadata + its searchable chunks
curl -H "Authorization: Bearer $KEY" "localhost:6767/v1/documents/<id>?containerTag=user_123"

# Uploaded content is searchable; chunk hits carry provenance
curl -H "Authorization: Bearer $KEY" "localhost:6767/v1/search?q=rockets&containerTag=user_123&searchMode=documents"
# -> results: [{ source:"chunk", documentId:"…", chunkIndex:3, page:2, filename:"report.pdf", score, text }, …]

# Delete a source: removes the document, its chunks, its stored file and only
# the memories derived from it
curl -X DELETE -H "Authorization: Bearer $KEY" "localhost:6767/v1/documents/<id>?containerTag=user_123"

# Your containers, and a self-description of the calling key
curl -H "Authorization: Bearer $KEY" localhost:6767/v1/containers
curl -H "Authorization: Bearer $KEY" localhost:6767/v1/whoami
```

Status codes: `400` validation error, `401` missing/invalid/revoked/expired key, `403`
container not owned by your tenant, `404` unknown id within an owned container, `413` payload
too large (or a document over the size/page/chunk limits), `415` unsupported type / content
type-magic-byte mismatch, `422` unreadable or malformed document, `429` rate limited. Error
bodies are generic (`{"error":"..."}`) and never leak secrets, absolute paths or internals.

### Document ingestion

- **Supported now:** `.txt`, `.md`, `.pdf` (text extraction; no OCR). Word/audio/code and
  scanned/image-only PDFs are out of scope for this phase.
- **Synchronous pipeline, isolated parser.** Uploads are processed in the request; there is no
  queue. PDF parsing runs in a bounded pool of worker threads (`PDF_MAX_CONCURRENT` active,
  `PDF_MAX_QUEUE` waiting) so it can never run unbounded in the server. A job that exceeds
  `PDF_EXTRACT_TIMEOUT_MS` is terminated and fails with `pdf_timeout`; when the wait queue is
  full the API returns `503` (`pdf_busy`) rather than buffering without bound.
- **Private storage.** Files are written under `UPLOAD_DIR` with server-generated names
  (`<uuid>.<ext>`) and `0600` permissions. The client's filename is stored as metadata only and
  is never used to build a path — path traversal is not possible.
- **Version lineage, not supersession.** Uploading a new file with the same name and different
  bytes creates a *new* document whose `previousDocumentId` points at the prior version; both
  are retained and searchable until you delete one.
- **Failed uploads** are recorded with `status:"failed"` and an `errorCode` (e.g.
  `pdf_unreadable`), create no chunks, leave no file, and never block a later retry. A PDF that
  times out, crashes the parser, or is rejected by a limit is recorded the same way and is never
  exposed as searchable.
- **Bounds that are best-effort.** `PDF_EXTRACT_TIMEOUT_MS` terminates the worker thread, but a
  hard memory limit inside a PDF parser cannot be fully enforced by `PDF_WORKER_HEAP_MB` alone
  (a worker can also be killed externally, e.g. by the OS OOM killer); such a job fails cleanly
  rather than corrupting state. Deadline enforcement is wall-clock, so a machine under heavy
  load may terminate a job that would otherwise have finished.
- **Retrieval without embeddings.** When the embedding provider is lexical, or chunk embedding
  fails, chunk ranking falls back to TF-IDF so uploaded content stays searchable.

### Try contradiction resolution

```bash
KEY=sm_…

curl -X POST localhost:6767/v1/add -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content":"I live in Berlin.","containerTag":"user_123"}'

curl -X POST localhost:6767/v1/add -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content":"I now live in Lisbon instead.","containerTag":"user_123"}'

curl -H "Authorization: Bearer $KEY" "localhost:6767/v1/profile?containerTag=user_123"
# -> static facts show Lisbon only; GET /v1/memories shows Berlin marked "superseded"
```

## Storage

Recall keeps its data in SQLite (WAL mode) via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3),
which ships a prebuilt native binary for common platforms (no compiler required). The REST
contract is unchanged — the storage backend sits behind `lib/storage/` and `lib/db.js` is a
thin compatibility shim.

| `STORAGE_BACKEND` | File | Notes |
|---|---|---|
| `sqlite` (default) | `data/recall.db` | Durable, transactional, single-file. |
| `json` | `data/store.json` | Legacy backend, kept for rollback. |

Environment: `DATA_DIR` (default `./data`), `SQLITE_FILE`, `STORE_FILE` override the paths.

Migration `003_documents.sql` is **additive**: it adds nullable upload-metadata columns to
`documents` (filename, media type, size, content hash, status, page count, chunk count, version
lineage, …) and a new `chunks` table. Existing rows are untouched. Uploaded files are stored as
regular files under `UPLOAD_DIR`, while their text, metadata and embeddings live in the
database. Both backends implement the same document-metadata and chunk operations, so
`STORAGE_BACKEND=json` remains a complete rollback path.

Embeddings are stored as `Float64` BLOBs with provider/model/dimension metadata. Vectors are
validated on write and never truncated or reinterpreted. If the SQLite database is empty while
a legacy JSON store still holds data, the server logs a warning and **does not migrate
automatically**.

### Migrating from the JSON store

The migration is one-way and safe: it **never deletes or overwrites** `data/store.json`, backs
it up first, validates every record, writes in a single transaction and is idempotent on reruns.

```bash
# 1. Stop the app so it is not holding the database.
# 2. Preview what would happen (writes nothing):
npm run db:migrate-json -- --dry-run

# 3. Migrate (writes data/recall.db and backs up the source under data/backups/):
npm run db:migrate-json

# 4. Start as usual — SQLite is the default backend:
npm start
```

The command reports source/target document and memory counts, per-status counts, vector
dimensions and a final verification that every source id is present. Corrupt JSON, duplicate
ids, orphan memories (`documentId` with no parent) and malformed embeddings are reported by id
and block the migration (add `--allow-partial` to skip invalid rows). Memory content is never
printed.

### Backup and rollback

- **Backup:** with the app stopped, copy `data/recall.db` (and any `-wal`/`-shm` sidecars) **and
  the `data/uploads/` directory** — the database stores documents, chunks and embeddings, but
  the original uploaded files live on disk. Losing `uploads/` does not break search (chunk text
  and vectors are in the database) but breaks exact byte-level retention. You can also use
  `sqlite3 data/recall.db ".backup data/recall-backup.db"`. The migration command additionally
  stores a timestamped copy of the source JSON under `data/backups/`.
- **Rollback to JSON:** set `STORAGE_BACKEND=json` and restart. The original `data/store.json`
  is left intact by the migration, so this restores the previous behaviour exactly.
- The JSON store is never removed automatically; delete it yourself only after you are
  satisfied the SQLite data is correct.

### Reconcile files with records

Uploaded files live on disk under `UPLOAD_DIR` while their records live in the database, so a
crash between the two, an interrupted delete, or a manual file copy can leave them out of step.
`storage:reconcile` reports both directions and (only with `--apply`) deletes files that no
record references:

```bash
npm run storage:reconcile                 # dry run: report only
npm run storage:reconcile -- --apply      # delete orphaned files
npm run storage:reconcile -- --json       # machine-readable report
```

Safety properties:

- **Records are never modified.** Only unreferenced *files* are deleted; a record whose file is
  missing is reported and left untouched so provenance is preserved.
- **A grace period (default 1 hour)** protects files newer than the window, so a concurrent
  upload that has committed its file but not yet inserted its row is never mistaken for an
  orphan. Override with `--grace-ms <n>` or `STORAGE_RECONCILE_GRACE_MS`.
- **Transient filesystem errors are not proof.** A file or directory that cannot be read is
  reported and skipped, never deleted.
- **Idempotent**, works on both backends, skips `UPLOAD_DIR/tmp`, and exits non-zero if a delete
  fails or the directory cannot be read. Stop the server first for the most accurate result.

### Embedding-space rollback

Restoring the previous **code and dependencies** is *not* sufficient on its own. The previous
embedding stack reused any non-empty stored vector, so once a reindex has written new-space
vectors (the old and new local spaces have the same dimension), the restored stack would score
those vectors against its own — silently mixing two spaces.

To roll back the embedding stack safely, invalidate the stored vectors first so the restored
stack regenerates them:

```bash
# 1. Stop the server.
# 2. Preview what would be cleared (writes nothing):
npm run embeddings:reset -- --dry-run

# 3. Clear every stored vector and the recorded space identity:
npm run embeddings:reset -- --apply

# 4. Now restore the previous code and dependencies, then start.
```

`embeddings:reset` preserves all documents, memories and chunks (text, provenance and records)
and clears only the vector fields plus the `embedding_space` bookkeeping. It works for both
`STORAGE_BACKEND=sqlite` and `STORAGE_BACKEND=json`. Run it while the newer code is still
checked out (before `git checkout` / `npm ci`), because the older checkout does not ship this
command. After the reset, the restored stack re-embeds vectors lazily on access (the older
stack has no bulk reindex command).

## Embeddings

Set `EMBEDDINGS_PROVIDER` to choose how vectors are produced:

| Value | What it uses | Keys |
|---|---|---|
| `xenova` (default) | `@huggingface/transformers` + `Xenova/bge-base-en-v1.5` (`q8`) | none |
| `openai` | `text-embedding-3-small` | `OPENAI_API_KEY` |
| `gemini` | `text-embedding-004` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `tfidf` | lexical TF-IDF (fallback path) | none |

Optional: `EMBEDDINGS_MODEL` overrides the model id for the selected provider.

**Vector-space identity.** Every stored vector records the provider, model and precision that
produced it. Before a stored vector is scored, it is checked against the current space; a vector
from a different space is re-embedded first, so a single query never compares vectors from two
spaces. For the local provider the identity also encodes the installed
`@huggingface/transformers` and `onnxruntime-node` versions (for example
`Xenova/bge-base-en-v1.5@q8~r2+tf4.3.1+ort1.30.0`), because a runtime bump can change the
numbers for identical text — so a caret dependency upgrade is detected automatically rather than
silently reusing old vectors. At startup the server compares the recorded space with the active
one and warns when they differ, then re-embeds stale vectors lazily on access. A store that
already holds vectors but records no space (a pre-Phase-A store, or one whose reindex never
completed) is reported as a **legacy/unknown** space and the space is deliberately left
unrecorded, so the warning keeps firing until a verified reindex records it; the space is only
recorded automatically for a store that is genuinely empty of vectors, and only once a provider
has actually loaded. For a controlled, whole-corpus pass (recommended after a precision change or
a local-stack upgrade):

```bash
npm run embeddings:reindex            # dry run: report what would change
npm run embeddings:reindex -- --apply # re-embed, then record the new space
```

If a stale vector cannot be re-embedded (provider error, or an empty/falsy response), that row is
never compared against a foreign vector. Ranking is **all-or-nothing**: if any row in a result set
cannot be placed in the current space — or the provider cannot load at all — the whole set is
ranked lexically (TF-IDF), so content is never silently dropped and two spaces are never mixed in
one response. A failed reindex never records the space, so the next startup keeps warning until it
is complete.

Every search response carries an authoritative `ranking` field (`dense` | `lexical` | `none`)
describing how *that* response was actually ranked, so a degraded/lexical result can never be
mistaken for semantic search; `embeddingsProvider` separately names the loaded provider. A provider
that cannot load degrades search to lexical with HTTP `200` (it does not fail the request).

**Hosted providers** (`openai`, `gemini`) record the configured model id only. If a provider
changes its server-side model behaviour without changing the id, Recall cannot detect it and the
space is treated as unchanged.

If the local model fails to load and you have not opted into a cloud provider, search falls back
to TF-IDF and the server logs that clearly.

```bash
# faster iteration while developing (needs a key)
EMBEDDINGS_PROVIDER=openai OPENAI_API_KEY=sk-... npm start
```

## Extraction

`POST /v1/add` classifies facts with an LLM when a key is present, then applies the same
slot-supersession and TTL rules as the regex path. With no key, regex runs so the app still
works offline.

| `EXTRACTION_PROVIDER` | What it uses | Keys |
|---|---|---|
| `auto` (default) | Anthropic, else OpenAI, else Gemini, else regex | first matching key |
| `openai` | `gpt-4o-mini` JSON schema | `OPENAI_API_KEY` |
| `anthropic` / `claude` | `claude-3-5-haiku-latest` tool use | `ANTHROPIC_API_KEY` |
| `gemini` | `gemini-2.0-flash` JSON schema | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `regex` | pattern rules in `lib/extract/regex.js` | none |

Optional: `EXTRACTION_MODEL` overrides the model id. If the LLM call fails, extraction falls
back to regex and logs a warning.

```bash
OPENAI_API_KEY=sk-... npm start
# or
EXTRACTION_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm start
```

## Testing and evaluations

```bash
npm test                      # storage, migration, API, auth/isolation, document ingestion, shutdown
npm run eval:search           # paraphrase retrieval check (downloads the local model on first run)
npm run eval:extract          # regex-gap + structured-schema check (live LLM skipped without a key)
npm run eval:documents        # end-to-end txt/md/pdf ingestion, attribution, dedupe, scoping, delete
```

Tests use Node's built-in runner with temporary directories and never touch the real store.
They run with `EMBEDDINGS_PROVIDER=tfidf` and `EXTRACTION_PROVIDER=regex` for speed and
determinism; live model/LLM paths are exercised separately by the eval scripts.

### Smoke test against a running instance

The suite above drives the app in-process. To check a *deployed* instance — a local
`npm start` or the container — run the smoke test against its URL:

```bash
# dev-mode instance (no key needed)
RECALL_URL=http://127.0.0.1:6767 npm run smoke
# authenticated instance
RECALL_URL=http://127.0.0.1:6767 RECALL_KEY=sm_… npm run smoke
```

It checks liveness/readiness, authentication, ingest → search → profile, a file upload with
attribution and dedupe, deletion, and that a lexical provider is never reported as dense. It
cleans up everything it creates and exits non-zero on the first failure.

To exercise the supported configurations end to end (and prove the default bind is not
reachable from a non-loopback address), run the matrix — it starts a real server per scenario:

```bash
npm run smoke:matrix              # sqlite/json, tfidf/dense/degraded, dev/authenticated
SMOKE_SKIP_DENSE=1 npm run smoke:matrix   # skip the scenarios that load the local model
```

### Runtime and platform

- **Node ≥ 22.** Declared in `package.json` (`engines`) and pinned by `.nvmrc` (`22`); `.npmrc`
  sets `engine-strict=true` so an unsupported Node fails the install instead of producing a tree
  that will not run.
- **Reproducible installs.** Dependencies resolve from `package-lock.json`; use `npm ci` (never
  `npm install` in deployment). A clean `npm ci` from the committed lockfile installs the full
  tree with **0 audit vulnerabilities** and the whole suite passes.
- **Native modules.** Local embeddings run on `onnxruntime-node` and `sharp`, which ship prebuilt
  platform binaries. `npm ls` shows a few `extraneous` / `UNMET OPTIONAL DEPENDENCY` entries for
  *other* platforms (Windows, Linux/musl variants) — this is expected npm behaviour for optional
  platform packages and `npm ci` reproduces it exactly; it is not a broken tree.
- **Model cache.** `EMBEDDINGS_CACHE_DIR` defaults inside `node_modules`, so a container must
  mount a persistent volume for it (or point it elsewhere) to avoid re-downloading the model on
  every start.
- **Cross-platform.** The suite is verified on macOS (darwin-arm64). macOS verification does not
  prove a Linux/container target; validate that explicitly with the provided container recipe
  before deployment.


The document suite (`test/documents.test.js`, `test/rank-chunks.test.js`) covers happy-path
txt/md/pdf ingestion with page/chunk attribution, every rejection path (empty, unsupported,
mismatched MIME, fake magic bytes, binary-as-text, oversize, traversal filename), the chunk and
page ceilings, dedupe, version lineage, cross-tenant read/list/search/delete isolation,
deletion of a source (document + chunks + file + only its derived memories) and persistence
across a database reopen. `test/rank-chunks.test.js` proves chunk retrieval falls back to
lexical scoring when embeddings are absent or generation fails.

The auth suite (`test/auth.test.js`) covers missing/malformed/invalid/revoked/expired keys,
cross-tenant reads/searches/profile/enumeration/deletes for **every** data route, IDOR via
known ids and forged container tags, hashing at rest, log redaction, rate limits, input
validation, the dev-mode production guard, the CLI bootstrap/revocation workflow and data
isolation after reopening the database. `test/auth-race.test.js` and a data-layer test cover
the container-claim race (see [Limitations](#limitations)).

## Operations and deployment

Recall is designed for a **private, single-instance** deployment. It ships a minimal
production container plus the pieces an operator needs to run it safely.

### Health and readiness

Two unauthenticated endpoints (a probe cannot hold an API key) expose coarse,
non-secret status only — never paths, content or tenants:

```bash
curl localhost:6767/healthz   # liveness: 200 while the process serves HTTP
curl localhost:6767/readyz    # readiness: 200 when serviceable, 503 otherwise
```

`/readyz` reports each dependency and answers `503` while **draining** or when the
**database or upload storage is unusable**. Embeddings are reported but are
deliberately *not* a readiness gate: an unavailable provider degrades to lexical
search, which still serves requests, so it must not restart-loop an otherwise
healthy instance. A dense provider that failed to load shows up as `"degraded"`:

```json
{"status":"degraded","ready":true,"degraded":true,"draining":false,"version":"0.1.0",
 "dependencies":{"database":{"ok":true,"backend":"sqlite"},"storage":{"ok":true},
 "embeddings":{"ok":true,"provider":"uninitialized","configured":"openai","dense":false,
 "space":"uninitialized"}}}
```

### Graceful shutdown

On `SIGTERM`/`SIGINT` Recall flips `/readyz` to not-ready first (so a probe-driven
router drains), stops accepting connections, terminates any in-flight PDF workers,
sweeps temp files, closes the database, and exits `0`. A hard 10-second timeout
guarantees the process can never hang. Run it under an init system or a container
init (`tini`, as in the image) so signals are delivered and zombies reaped.

### Container

```bash
docker build -t recall:0.1.0 .
cp .env.example .env      # adjust; never commit it
docker compose up --build
```

After it is up, confirm it end to end from the host: `RECALL_KEY=sm_… npm run smoke` (or open
the dashboard at `http://127.0.0.1:6767/`).

The image is `node:22` Debian slim, runs as the unprivileged `node` user, copies
only runtime files, and installs production dependencies from the lockfile. The
compose file publishes the port on **loopback only** and enforces
`AUTH_MODE=required`. To expose the service, put an authenticated, TLS-enabled
reverse proxy in front; never publish it directly.

Inside the container the process binds `0.0.0.0` (Docker cannot forward a
loopback-only listener), so in a container **port publishing is the security
boundary**: keep it on `127.0.0.1`. Direct installs still default to
`HOST=127.0.0.1`. The image deliberately does not set `UPLOAD_DIR`, so uploads
keep deriving from `DATA_DIR`; if you override `DATA_DIR`, the files follow it
onto the same volume instead of landing in the container's ephemeral layer.

Two volumes hold state:

| Volume | Mount | Contents | Backed up |
|---|---|---|---|
| `recall-data` | `/app/data` | SQLite database, `uploads/` | **Yes — required** |
| `recall-cache` | `/app/.cache/transformers` | local embedding model | No (regenerates) |

Set resource limits (the compose file sets memory/CPU caps) and watch disk usage on
`recall-data`: the database grows with content and uploads are not evicted
automatically. A full or read-only disk surfaces as `503` from `/readyz` (the
storage probe fails) rather than as silent corruption.

**Do not run more than one replica.** Correctness depends on in-process state (see
[Limitations](#limitations)): the SQLite backend keeps an in-memory mirror and the
rate limiter is per-process.

### Backup and restore

Back up the database and the upload directory together — they must be consistent as
a set. The model cache is optional (it regenerates).

```bash
# with the service stopped
tar czf "recall-backup-$(date +%F).tgz" -C /app data
```

Restore by extracting over `DATA_DIR` with the service stopped. The SQLite store is
a single `recall.db` in WAL mode; a snapshot taken while the service runs must
include `recall.db-wal`/`-shm`, or stop the service first. `npm run db:migrate-json`
migrates a legacy JSON store, and `npm run storage:reconcile` reports files not
referenced by any record (dry-run by default).

### Logs

Logs are single-line JSON events plus a few human-readable `[...]` lifecycle lines.
They never contain API keys, request bodies, document content, or absolute storage
paths: startup logs the database **basename** only, and request failures log only
the method, path, status and error class.

### Continuous integration

`.github/workflows/ci.yml` runs on Node 22 and 24 — lockfile install,
`npm audit --audit-level=high`, the full test suite, all three evaluation suites, a
real startup plus `/healthz`/`/readyz` check, and a container build that runs the
image and verifies a clean `SIGTERM` exit.

Public deployment is a separate, explicit decision; this section covers a private
instance only.

## Limitations

Recall is a single-node, self-hosted engine. Known limits, stated honestly:

- **Single-process.** The SQLite backend keeps an in-memory mirror for the existing array read
  API. It is safe within one process (writes are committed synchronously), but it is **not
  multi-process consistent and not horizontally scalable**: two server processes sharing one
  database would each hold a stale mirror. Do not run more than one server process against a
  database.
- **Rate limiting is in-memory and per-process**, not distributed.
- **Brute-force vector scoring.** Search ranks vectors in memory rather than using an indexed
  vector store; fine for this scale, not for millions of rows.
- **Document ingestion is synchronous and local-disk based.** Uploads are processed inline (no
  queue). PDF parsing is isolated in worker threads whose concurrency and queue are bounded
  (`PDF_MAX_CONCURRENT` / `PDF_MAX_QUEUE`), and each job is terminated once it exceeds
  `PDF_EXTRACT_TIMEOUT_MS`. Files are kept on the server's local disk under `UPLOAD_DIR` (not
  object storage) and must be backed up together with the database. Text extraction only:
  scanned/image-only PDFs and non-text formats (Word, audio, code) are not supported, and there
  is no OCR.
- **Local/offline trust model.** Authentication and tenant isolation are enforced, but the app
  is intended to run on a trusted host behind your own network controls. Serve it over TLS and
  keep it off the public internet unless you have deliberately reviewed the deployment.
- **`npm audit` dependencies.** Clean: `npm audit` reports **0 vulnerabilities** against the
  installed tree. Embeddings run on `@huggingface/transformers@4.3.1` (Apache-2.0), whose Node
  runtime is `onnxruntime-node@1.30.0` + `onnxruntime-common@1.30.0` and `sharp@0.35.5`.
  `onnxruntime-web@1.31.0-dev.<sha>` (a pinned prerelease) and its `protobufjs@7.6.6` are
  installed as transitive dependencies but are **never executed on Node** — the Node build
  imports `onnxruntime-node`/`onnxruntime-common`, not the web runtime — and they carry no
  advisories. The previous `@xenova/transformers@2.17.2` tree (5 advisories: 4 high, 1 critical,
  via `protobufjs@6` / `onnx-proto` / `sharp@0.32`) has been removed entirely.

  Because the ONNX runtime changed (1.14.0 → 1.30.0), int8 inference numerics changed, so the
  stored vector space changed. Existing vectors are **not** reused: they are detected as stale
  and re-embedded (lazily on access, or in bulk with `npm run embeddings:reindex -- --apply`).

## Roadmap

Product-oriented next steps, roughly in order:

- **Migrate embeddings to `@huggingface/transformers`** — *done in Phase A*: clears the
  transitive `npm audit` advisories and tracks the maintained runtime (see the note above).
- **Indexed vector search** — move scoring out of memory (e.g. `sqlite-vec` or an external
  vector store) behind the existing `lib/storage` facade.
- **File ingestion** — shipped for `.txt` / `.md` / `.pdf` (upload → extract → chunk → embed →
  search, with attribution). Next: more formats and OCR for scanned PDFs.
- **Connectors** — pull from Gmail, Drive, Notion, etc. as content sources.
- **MCP server / SDKs** — expose Recall to agents (Claude Desktop, editors) as a memory tool.
- **Shared, multi-process deployment** — a distributed rate limiter and a stateless read path
  so more than one process can serve the same database.

## Status

Functional and tested for the described scope: ingestion (raw text and `.txt`/`.md`/`.pdf`
uploads), extraction, persistence, retrieval, authentication and tenant isolation. It is
operationally ready for a **private, single-instance** deployment: liveness/readiness
endpoints, draining-aware graceful shutdown, fail-fast configuration validation, a minimal
non-root container, a smoke matrix and CI. Search reports how it actually ranked (`ranking`:
`dense` | `lexical` | `none`) so a degraded fallback is never presented as semantic search.
It is a focused engineering project, **not** a production-hardened, horizontally-scaled
service — see [Limitations](#limitations) before exposing it.

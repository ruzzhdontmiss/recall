# recall — a supermemory clone

A small, self-contained clone of the core loop in [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory):
add content → extract durable/temporary facts → build a user profile → hybrid search over memories + raw documents.

No API keys required for the default path. `npm install && npm start` and it's running.

## What's real vs. simplified

The actual supermemory is a production system: Cloudflare Workers backend, Postgres +
vector DB, LLM-based fact extraction, real embedding models, connectors (Gmail, Drive,
Notion...), file/OCR/video pipelines, an MCP server, and SDKs. This clone reproduces the
**mechanics** of the core memory loop, with cheap stand-ins for the remaining expensive parts:

| Real supermemory | This clone |
|---|---|
| LLM extracts facts from conversations | Structured LLM output when an API key is set; regex fallback otherwise |
| Embedding model (bge-base or provider API) | Local `Xenova/bge-base-en-v1.5` via Transformers.js; optional OpenAI/Gemini |
| Postgres / vector DB | One SQLite file in `data/recall.db` (WAL; vectors stored on each row) |
| Contradiction resolution via LLM | "Slot" matching — a new fact in the same slot (location, employer, editor, ...) for a user supersedes the old one |
| Automatic forgetting | Dynamic memories get a TTL based on temporal keywords (`tomorrow`, `this week`, `currently`, ...) and expire on read |

The API shapes (`add`, `search` with `searchMode`, `profile` returning `static`/`dynamic`,
`containerTag` for scoping) intentionally mirror the real API from the README.

## Run it

```bash
npm install
npm start
# open http://localhost:6767
```

Requires **Node.js >= 20** (developed and tested on Node 23.11). Data is stored in SQLite by
default (`data/recall.db`).

The first request with the default provider downloads and caches `bge-base-en-v1.5`
(~100MB). After that, search is local and key-free.

## Storage

Recall keeps its data in SQLite (WAL mode) via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3),
which shares a prebuilt native binary for common platforms (no compiler required). The REST
contract is unchanged — the storage backend sits behind `lib/storage/` and `lib/db.js` is a
thin compatibility shim.

| `STORAGE_BACKEND` | File | Notes |
|---|---|---|
| `sqlite` (default) | `data/recall.db` | Durable, transactional, single-file. |
| `json` | `data/store.json` | Legacy backend, kept for rollback. |

Environment: `DATA_DIR` (default `./data`), `SQLITE_FILE`, `STORE_FILE` override the paths.

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

- **Backup:** with the app stopped, copy `data/recall.db` (and any `-wal`/`-shm` sidecars), or
  use `sqlite3 data/recall.db ".backup data/recall-backup.db"`. The migration command also
  stores a timestamped copy of the source JSON under `data/backups/`.
- **Rollback to JSON:** set `STORAGE_BACKEND=json` and restart. The original `data/store.json`
  is left intact by the migration, so this restores the previous behaviour exactly.
- The JSON store is never removed automatically; delete it yourself only after you are
  satisfied the SQLite data is correct.

## Testing

```bash
npm test                      # storage, migration, API and shutdown regression tests
npm run eval:search           # paraphrase retrieval check (downloads the local model on first run)
npm run eval:extract          # regex-gap + structured-schema check (live LLM skipped without a key)
```

Tests use Node's built-in runner with temporary directories and never touch the real store.
They run with `EMBEDDINGS_PROVIDER=tfidf` and `EXTRACTION_PROVIDER=regex` for speed and
determinism; live model/LLM paths are exercised separately by the eval scripts.


## Embeddings

Set `EMBEDDINGS_PROVIDER` to choose how vectors are produced:

| Value | What it uses | Keys |
|---|---|---|
| `xenova` (default) | `@xenova/transformers` + `Xenova/bge-base-en-v1.5` | none |
| `openai` | `text-embedding-3-small` | `OPENAI_API_KEY` |
| `gemini` | `text-embedding-004` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `tfidf` | lexical TF-IDF (old path) | none |

Optional: `EMBEDDINGS_MODEL` overrides the model id for the selected provider.

If the local Xenova model fails to load and you have not opted into a cloud provider,
search falls back to TF-IDF and the server logs that clearly.

```bash
# faster iteration while developing (needs a key)
EMBEDDINGS_PROVIDER=openai OPENAI_API_KEY=sk-... npm start
```

Paraphrase check (downloads the local model on first run):

```bash
npm run eval:search
```

## Extraction

`POST /v1/add` classifies facts with an LLM when a key is present, then applies the same
slot-supersession and TTL rules as the regex path. With no key, regex runs so the app
still works offline.

| `EXTRACTION_PROVIDER` | What it uses | Keys |
|---|---|---|
| `auto` (default) | Anthropic, else OpenAI, else Gemini, else regex | first matching key |
| `openai` | `gpt-4o-mini` JSON schema | `OPENAI_API_KEY` |
| `anthropic` / `claude` | `claude-3-5-haiku-latest` tool use | `ANTHROPIC_API_KEY` |
| `gemini` | `gemini-2.0-flash` JSON schema | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `regex` | pattern rules in `lib/extract/regex.js` | none |

Optional: `EXTRACTION_MODEL` overrides the model id. If the LLM call fails, extraction
falls back to regex and logs a warning.

```bash
OPENAI_API_KEY=sk-... npm start
# or
EXTRACTION_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm start
```

```bash
npm run eval:extract
# live LLM cases run only when a key is set
```

## API

All endpoints take an optional `containerTag` (defaults to `demo_user`) to scope memory
to a particular user/project — same idea as the real supermemory's `containerTag`.

```bash
# Add content — facts get extracted automatically
curl -X POST localhost:6767/v1/add -H "Content-Type: application/json" \
  -d '{"content":"I am a backend engineer. I live in Berlin. I prefer Rust over Go.","containerTag":"user_123"}'

# Hybrid search (memories + documents)
curl "localhost:6767/v1/search?q=where+does+the+user+live&containerTag=user_123&searchMode=hybrid"

# User profile: static (durable) + dynamic (temporary) facts
curl "localhost:6767/v1/profile?containerTag=user_123"

# All memories, including superseded/expired ones (for transparency/debugging)
curl "localhost:6767/v1/memories?containerTag=user_123"

# Forget a memory
curl -X DELETE localhost:6767/v1/memories/<id>
```

## Try the contradiction resolution

```bash
curl -X POST localhost:6767/v1/add -H "Content-Type: application/json" \
  -d '{"content":"I live in Berlin.","containerTag":"user_123"}'

curl -X POST localhost:6767/v1/add -H "Content-Type: application/json" \
  -d '{"content":"I now live in Lisbon instead.","containerTag":"user_123"}'

curl "localhost:6767/v1/profile?containerTag=user_123"
# -> static facts show Lisbon only; GET /v1/memories shows Berlin marked "superseded"
```

## Project layout

```
server.js                 Express app, all routes (+ graceful shutdown)
lib/db.js                 compatibility shim -> lib/storage
lib/storage/index.js      backend selection + facade (STORAGE_BACKEND)
lib/storage/sqlite.js     SQLite backend (better-sqlite3, WAL, transactions)
lib/storage/json.js       legacy JSON backend (rollback)
lib/storage/migrations/   explicit SQL schema migrations
lib/storage/vectors.js    embedding encode/decode + validation
lib/extract.js            orchestrates LLM vs regex; persist slot/TTL mechanics
lib/extract/              openai / anthropic / gemini structured extractors + regex
lib/tfidf.js              TF-IDF fallback scorer
lib/embeddings/           xenova (default) / openai / gemini / tfidf
lib/search.js             hybrid ranking over stored vectors
public/                   vanilla HTML/CSS/JS web UI
data/recall.db            SQLite store (default backend) — created on first run
data/store.json           legacy JSON store (only with STORAGE_BACKEND=json)
scripts/db-migrate-json.js JSON -> SQLite migration CLI
scripts/eval-search.js    paraphrase retrieval check
scripts/eval-extract.js   regex-gap + LLM extraction check
test/                     node:test regression suite
```

## Extending it

- **Persistence**: set `STORAGE_BACKEND=json` to roll back, or extend `lib/storage/` (e.g. a
  Postgres adapter behind the same facade) and index the `embedding` BLOBs instead of scoring
  them in memory.

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
| Postgres / vector DB | One JSON file in `data/store.json` (vectors stored on each row) |
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

The first request with the default provider downloads and caches `bge-base-en-v1.5`
(~100MB). After that, search is local and key-free.

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
server.js                 Express app, all routes
lib/db.js                 zero-config JSON-file storage
lib/extract.js            orchestrates LLM vs regex; persist slot/TTL mechanics
lib/extract/              openai / anthropic / gemini structured extractors + regex
lib/tfidf.js              TF-IDF fallback scorer
lib/embeddings/           xenova (default) / openai / gemini / tfidf
lib/search.js             hybrid ranking over stored vectors
public/                   vanilla HTML/CSS/JS web UI
data/store.json           created on first run — all your data lives here
scripts/eval-search.js    paraphrase retrieval check
scripts/eval-extract.js   regex-gap + LLM extraction check
```

## Extending it

- **Persistence**: swap `lib/db.js` for SQLite/Postgres once the JSON file gets unwieldy,
  and index the existing `embedding` arrays instead of scoring them in memory.

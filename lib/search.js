const db = require("./db");
const { buildIndex } = require("./tfidf");
const embeddings = require("./embeddings");
const space = require("./embeddings/space");

// A stored vector may only be reused when it belongs to the current vector
// space. Otherwise it is re-embedded before it is ever scored, so a single query
// never compares vectors from two different spaces (e.g. across a dependency or
// precision change). Missing metadata is treated as incompatible on purpose.
function reusableEmbedding(row) {
  return space.matches(row, embeddings.describe());
}

let warnedStale = false;
function warnStaleOnce() {
  if (warnedStale) return;
  warnedStale = true;
  console.warn(
    "[embeddings] stored vectors were produced by a different vector space; " +
      "re-embedding them on access. Run `npm run embeddings:reindex` (dry-run) then " +
      "`npm run embeddings:reindex -- --apply` for a full offline pass."
  );
}

let warnedFailed = false;
function warnReembedFailedOnce(kind) {
  if (warnedFailed) return;
  warnedFailed = true;
  console.warn(
    `[embeddings] could not re-embed a stored ${kind} into the current vector space; ` +
      "it is excluded from scoring rather than compared against a foreign vector. " +
      "Run `npm run embeddings:reindex -- --apply` once the provider is healthy."
  );
}

// Mirror the freshly written provider/model/dimension onto the in-memory row so
// it is self-consistent (and reusable) within this request. The durable row is
// updated by db.updateEmbedding; this keeps the object we are about to score in
// sync with it.
function stampVectorMeta(row, vec) {
  const want = embeddings.describe();
  row.embedding = vec;
  row.embeddingProvider = want.provider;
  row.embeddingModel = want.model;
  row.embeddingDim = vec.length;
}

// Re-embed a single row into the current space. Returns a vector that is safe to
// score (a usable current-space vector) or null when the row cannot be
// re-embedded. It NEVER returns a foreign-space vector: if re-embedding throws,
// returns a falsy/invalid value, or the write fails, the stale vector is not
// handed back to the caller.
async function ensureRowEmbedding(kind, row, text) {
  await embeddings.getImpl();
  if (!embeddings.isDense()) return null;
  if (reusableEmbedding(row)) return row.embedding;
  if (row.embedding && row.embedding.length) warnStaleOnce();
  let vec = null;
  try {
    vec = await embeddings.embed(text);
  } catch {
    vec = null;
  }
  if (space.isUsableVector(vec)) {
    db.updateEmbedding(kind, row.id, vec);
    stampVectorMeta(row, vec);
    return vec;
  }
  warnReembedFailedOnce(kind);
  return null;
}

async function embedIngestTexts(texts) {
  // Best-effort embedding for newly ingested content. Returns null (rather than
  // throwing) when the provider is lexical or fails, so ingestion still
  // persists the document + memories and vectors can be backfilled lazily.
  try {
    await embeddings.getImpl();
    if (!embeddings.isDense()) return null;
    const vecs = await embeddings.embedMany(texts);
    if (!vecs || vecs.length !== texts.length) return null;
    return vecs;
  } catch (err) {
    console.warn(`[embeddings] ingest embed failed: ${err.message}`);
    return null;
  }
}

async function attachOnIngest({ document, memories }) {
  const vectors = await embedIngestTexts([document.content, ...memories.map((m) => m.text)]);
  if (!vectors) return;
  if (vectors[0]) {
    db.updateEmbedding("document", document.id, vectors[0]);
    document.embedding = vectors[0];
  }
  memories.forEach((m, i) => {
    const vec = vectors[i + 1];
    if (!vec) return;
    db.updateEmbedding("memory", m.id, vec);
    m.embedding = vec;
  });
}

function rankTfidf(query, items, textOf) {
  const idx = buildIndex(items.map((item) => ({ id: item.id, text: textOf(item) })));
  const byId = new Map(items.map((item) => [item.id, item]));
  return idx
    .score(query)
    .filter((r) => r.score > 0)
    .map((r) => ({ item: byId.get(r.id), score: r.score }));
}

// How a request's ranking was ACTUALLY produced, so the API can report the truth
// instead of the configured provider. A response is "lexical" if ANY part of it
// fell back to TF-IDF (the provider was unavailable/lexical, or a row could not
// be placed in the current space); "none" means there was nothing to rank. It is
// never claimed to be "dense" unless every scored row used a current-space vector.
function createRankingState() {
  return { modes: new Set() };
}

function noteRanking(state, mode) {
  if (state && state.modes) state.modes.add(mode);
}

function rankingMode(state) {
  if (!state || !state.modes || state.modes.size === 0) return "none";
  return state.modes.has("lexical") ? "lexical" : "dense";
}

// Score `items` densely, but ONLY when every row has a usable current-space vector
// and the query itself embeds. Returns null when a dense result cannot be produced
// safely, so the caller falls back to lexical for the WHOLE set: a foreign vector
// is never scored, and a row is never silently dropped while the response still
// claims semantic ranking.
async function denseScores(query, items, vectors) {
  if (!vectors.length || !vectors.every((v) => space.isUsableVector(v))) return null;
  let qVec = null;
  try {
    qVec = await embeddings.embed(query, { isQuery: true });
  } catch {
    qVec = null;
  }
  if (!space.isUsableVector(qVec)) return null;
  return items.map((item, i) => ({ item, score: embeddings.cosine(qVec, vectors[i]) }));
}

async function rankItems(query, items, { kind, textOf, state } = {}) {
  // Nothing to rank: report "none" rather than claiming a ranking that never ran.
  if (!items.length) return [];

  // A provider that cannot load (e.g. a hosted provider with no credentials, or a
  // local one that failed) degrades to lexical search instead of failing the
  // request.
  let loaded = true;
  try {
    await embeddings.getImpl();
  } catch {
    loaded = false;
  }
  if (!loaded || !embeddings.isDense()) {
    noteRanking(state, "lexical");
    return rankTfidf(query, items, textOf);
  }

  const vectors = [];
  for (const item of items) {
    let vec = null;
    try {
      vec = await ensureRowEmbedding(kind, item, textOf(item));
    } catch {
      vec = null;
    }
    vectors.push(vec);
  }

  const scored = await denseScores(query, items, vectors);
  if (!scored) {
    noteRanking(state, "lexical");
    return rankTfidf(query, items, textOf);
  }
  noteRanking(state, "dense");
  return scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
}

function formatDocumentHit(doc, score) {
  return {
    source: "document",
    id: doc.id,
    score: Number(score.toFixed(4)),
    text: doc.content,
    createdAt: doc.createdAt,
  };
}

function formatMemoryHit(mem, score) {
  return {
    source: "memory",
    id: mem.id,
    score: Number(score.toFixed(4)),
    text: mem.text,
    memoryType: mem.type,
    createdAt: mem.createdAt,
  };
}

// Chunk ranking. When the configured provider is lexical, or when a current-space
// vector is unavailable for the WHOLE set (generation failed / never ran / a
// stored vector is foreign), fall back to TF-IDF so uploaded content stays
// retrievable — never by scoring a mix of vector spaces.
async function ensureChunkEmbedding(chunk) {
  await embeddings.getImpl();
  if (!embeddings.isDense()) return null;
  if (reusableEmbedding(chunk)) return chunk.embedding;
  if (chunk.embedding && chunk.embedding.length) warnStaleOnce();
  let vec = null;
  try {
    vec = await embeddings.embed(chunk.text);
  } catch {
    vec = null;
  }
  if (space.isUsableVector(vec)) {
    db.updateEmbedding("chunk", chunk.id, vec);
    stampVectorMeta(chunk, vec);
    return vec;
  }
  warnReembedFailedOnce("chunk");
  return null;
}

async function rankChunks(query, chunks, state) {
  if (!chunks.length) return [];

  let loaded = true;
  try {
    await embeddings.getImpl();
  } catch {
    loaded = false;
  }
  if (!loaded || !embeddings.isDense()) {
    noteRanking(state, "lexical");
    return rankTfidf(query, chunks, (c) => c.text);
  }

  const vectors = [];
  for (const chunk of chunks) {
    let vec = null;
    try {
      vec = await ensureChunkEmbedding(chunk);
    } catch {
      /* treat a failed re-embed as "no vector"; lexical fallback still applies */
      vec = null;
    }
    vectors.push(vec);
  }

  const scored = await denseScores(query, chunks, vectors);
  if (!scored) {
    noteRanking(state, "lexical");
    return rankTfidf(query, chunks, (c) => c.text);
  }
  noteRanking(state, "dense");
  return scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
}

function formatChunkHit(chunk, doc, score) {
  return {
    source: "chunk",
    id: chunk.id,
    documentId: chunk.documentId,
    chunkIndex: chunk.chunkIndex,
    page: chunk.page,
    filename: doc ? doc.filename : null,
    mediaType: doc ? doc.mediaType : null,
    score: Number(score.toFixed(4)),
    text: chunk.text,
    createdAt: chunk.createdAt,
  };
}

async function searchChunks(q, chunks, docById = new Map(), state) {
  const ranked = await rankChunks(q, chunks, state);
  return ranked.map(({ item, score }) =>
    formatChunkHit(item, docById.get(item.documentId), score)
  );
}

async function searchDocumentsWithChunks({ q, docs, chunks = [], docById = new Map(), state }) {
  const [dHits, cHits] = await Promise.all([
    searchDocuments(q, docs, state),
    searchChunks(q, chunks, docById, state),
  ]);
  return dHits.concat(cHits).sort((a, b) => b.score - a.score);
}

async function searchDocuments(q, docs, state) {
  const ranked = await rankItems(q, docs, { kind: "document", textOf: (d) => d.content, state });
  return ranked.map(({ item, score }) => formatDocumentHit(item, score));
}

async function searchMemories(q, mems, state) {
  const ranked = await rankItems(q, mems, { kind: "memory", textOf: (m) => m.text, state });
  return ranked.map(({ item, score }) => formatMemoryHit(item, score));
}

async function searchHybrid({ q, docs, mems, chunks = [], docById = new Map(), limit = 20, state }) {
  const [dHits, mHits] = await Promise.all([
    searchDocumentsWithChunks({ q, docs, chunks, docById, state }),
    searchMemories(q, mems, state),
  ]);
  return dHits.concat(mHits).sort((a, b) => b.score - a.score).slice(0, limit);
}

async function searchProfile(q, mems, limit = 10, state) {
  const ranked = await rankItems(q, mems, { kind: "memory", textOf: (m) => m.text, state });
  return ranked.slice(0, limit).map(({ item, score }) => ({
    id: item.id,
    text: item.text,
    type: item.type,
    score: Number(score.toFixed(4)),
  }));
}

module.exports = {
  attachOnIngest,
  embedIngestTexts,
  ensureRowEmbedding,
  searchDocuments,
  searchMemories,
  searchHybrid,
  searchProfile,
  searchChunks,
  searchDocumentsWithChunks,
  rankChunks,
  createRankingState,
  rankingMode,
};

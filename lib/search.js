const db = require("./db");
const { buildIndex } = require("./tfidf");
const { slotsForQuery } = require("./query-intent");
const embeddings = require("./embeddings");
const space = require("./embeddings/space");

// Hybrid reranking: dense cosine is the primary signal, with a smaller lexical
// component that breaks near-ties on short natural-language questions. A 20%
// lexical weight is enough to surface a fact containing the query's key term
// ("work", "rotation") without letting keyword overlap override semantic
// similarity for longer paraphrases. The slot prior is a separate, small bonus
// for a memory whose extracted slot matches the question's intent.
const LEXICAL_WEIGHT = 0.2;
const SLOT_PRIOR = 0.05;

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

// Combine already-computed dense scores with lexical overlap and, for memory
// rows, an extracted-slot prior. This is intentionally a reranker over dense
// candidates: dense recall still decides what can be returned, while lexical
// evidence and explicit question intent only reorder that candidate set.
function rerankHybrid(query, scored, { textOf, slotOf, lexicalIndex } = {}) {
  if (!scored.length) return [];
  const idx =
    lexicalIndex || buildIndex(scored.map(({ item }) => ({ id: item.id, text: textOf(item) })));
  const lexical = new Map(idx.score(query).map(({ id, score }) => [id, score]));
  const wanted = slotOf ? slotsForQuery(query) : new Set();
  return scored
    .map(({ item, score }) => {
      const lex = lexical.get(item.id) || 0;
      const slot = slotOf ? slotOf(item) : null;
      const prior = slot && wanted.has(slot) ? SLOT_PRIOR : 0;
      return {
        item,
        score: (1 - LEXICAL_WEIGHT) * score + LEXICAL_WEIGHT * lex + prior,
        denseScore: score,
      };
    })
    .sort((a, b) => b.score - a.score || b.denseScore - a.denseScore);
}

// How a request's ranking was ACTUALLY produced, so the API can report the truth
// instead of the configured provider. A response is "hybrid" when every scored
// row used a current-space vector and the result was reranked with lexical and
// slot evidence. It is "lexical" if ANY part of it fell back to TF-IDF (the
// provider was unavailable/lexical, or a row could not be placed in the current
// space); "none" means there was nothing to rank. It is never claimed to be
// "dense" unless every scored row used a current-space vector and no lexical
// reranking ran.
function createRankingState() {
  return { modes: new Set() };
}

function noteRanking(state, mode) {
  if (state && state.modes) state.modes.add(mode);
}

function rankingMode(state) {
  if (!state || !state.modes || state.modes.size === 0) return "none";
  if (state.modes.has("lexical")) return "lexical";
  if (state.modes.has("hybrid")) return "hybrid";
  return "dense";
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

async function rankItems(query, items, { kind, textOf, slotOf, lexicalIndex, state } = {}) {
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
  noteRanking(state, "hybrid");
  return rerankHybrid(
    query,
    scored.filter((r) => r.score > 0),
    { textOf, slotOf, lexicalIndex }
  );
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

async function rankChunks(query, chunks, state, lexicalIndex) {
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
  noteRanking(state, "hybrid");
  return rerankHybrid(
    query,
    scored.filter((r) => r.score > 0),
    { textOf: (c) => c.text, lexicalIndex }
  );
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

async function searchChunks(q, chunks, docById = new Map(), state, lexicalIndex) {
  const ranked = await rankChunks(q, chunks, state, lexicalIndex);
  return ranked.map(({ item, score }) =>
    formatChunkHit(item, docById.get(item.documentId), score)
  );
}

async function searchDocumentsWithChunks({ q, docs, chunks = [], docById = new Map(), state, lexicalIndex }) {
  // Docs and chunks are merged into one result list, so their lexical evidence
  // must come from the same corpus/index. Otherwise a raw note is compared
  // against a 11-note vocabulary while a chunk is compared against a 3-chunk
  // vocabulary, and the two hybrid scores are not comparable.
  const idx =
    lexicalIndex ||
    buildIndex([
      ...docs.map((d) => ({ id: d.id, text: d.content })),
      ...chunks.map((c) => ({ id: c.id, text: c.text })),
    ]);
  const [dHits, cHits] = await Promise.all([
    searchDocuments(q, docs, state, idx),
    searchChunks(q, chunks, docById, state, idx),
  ]);
  return dHits.concat(cHits).sort((a, b) => b.score - a.score);
}

async function searchDocuments(q, docs, state, lexicalIndex) {
  const ranked = await rankItems(q, docs, {
    kind: "document",
    textOf: (d) => d.content,
    lexicalIndex,
    state,
  });
  return ranked.map(({ item, score }) => formatDocumentHit(item, score));
}

async function searchMemories(q, mems, state, lexicalIndex) {
  const ranked = await rankItems(q, mems, {
    kind: "memory",
    textOf: (m) => m.text,
    slotOf: (m) => m.slot,
    lexicalIndex,
    state,
  });
  return ranked.map(({ item, score }) => formatMemoryHit(item, score));
}

async function searchHybrid({ q, docs, mems, chunks = [], docById = new Map(), limit = 20, state }) {
  // One lexical index over every candidate that can be returned, so a memory,
  // a raw note and a document chunk are scored on the same terms before merge.
  const lexicalIndex = buildIndex([
    ...docs.map((d) => ({ id: d.id, text: d.content })),
    ...chunks.map((c) => ({ id: c.id, text: c.text })),
    ...mems.map((m) => ({ id: m.id, text: m.text })),
  ]);
  const [dHits, mHits] = await Promise.all([
    searchDocumentsWithChunks({ q, docs, chunks, docById, state, lexicalIndex }),
    searchMemories(q, mems, state, lexicalIndex),
  ]);
  return dHits.concat(mHits).sort((a, b) => b.score - a.score).slice(0, limit);
}

async function searchProfile(q, mems, limit = 10, state) {
  const ranked = await rankItems(q, mems, {
    kind: "memory",
    textOf: (m) => m.text,
    slotOf: (m) => m.slot,
    state,
  });
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

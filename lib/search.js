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

async function rankItems(query, items, { kind, textOf }) {
  await embeddings.getImpl();
  if (!items.length) return [];

  if (!embeddings.isDense()) {
    return rankTfidf(query, items, textOf);
  }

  const vectors = [];
  for (const item of items) {
    vectors.push(await ensureRowEmbedding(kind, item, textOf(item)));
  }

  const qVec = await embeddings.embed(query, { isQuery: true });
  if (!space.isUsableVector(qVec)) return [];

  return items
    .map((item, i) => ({
      item,
      // Score ONLY vectors that are usable and were proven to be in the current
      // space. A row whose re-embedding failed has no vector here and is
      // excluded, so a foreign vector is never compared against the query.
      score: space.isUsableVector(vectors[i]) ? embeddings.cosine(qVec, vectors[i]) : 0,
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
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

async function rankChunks(query, chunks) {
  await embeddings.getImpl();
  if (!chunks.length) return [];

  if (embeddings.isDense()) {
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
    // Dense ranking is only safe when EVERY chunk has a usable current-space
    // vector. A single foreign/unavailable vector sends the whole set to lexical
    // ranking instead of mixing two spaces in one result set.
    if (vectors.every((v) => space.isUsableVector(v))) {
      const qVec = await embeddings.embed(query, { isQuery: true });
      if (space.isUsableVector(qVec)) {
        return chunks
          .map((item, i) => ({ item, score: embeddings.cosine(qVec, vectors[i]) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score);
      }
    }
  }

  return rankTfidf(query, chunks, (c) => c.text);
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

async function searchChunks(q, chunks, docById = new Map()) {
  const ranked = await rankChunks(q, chunks);
  return ranked.map(({ item, score }) =>
    formatChunkHit(item, docById.get(item.documentId), score)
  );
}

async function searchDocumentsWithChunks({ q, docs, chunks = [], docById = new Map() }) {
  const [dHits, cHits] = await Promise.all([
    searchDocuments(q, docs),
    searchChunks(q, chunks, docById),
  ]);
  return dHits.concat(cHits).sort((a, b) => b.score - a.score);
}

async function searchDocuments(q, docs) {
  const ranked = await rankItems(q, docs, { kind: "document", textOf: (d) => d.content });
  return ranked.map(({ item, score }) => formatDocumentHit(item, score));
}

async function searchMemories(q, mems) {
  const ranked = await rankItems(q, mems, { kind: "memory", textOf: (m) => m.text });
  return ranked.map(({ item, score }) => formatMemoryHit(item, score));
}

async function searchHybrid({ q, docs, mems, chunks = [], docById = new Map(), limit = 20 }) {
  const [dHits, mHits] = await Promise.all([
    searchDocumentsWithChunks({ q, docs, chunks, docById }),
    searchMemories(q, mems),
  ]);
  return dHits.concat(mHits).sort((a, b) => b.score - a.score).slice(0, limit);
}

async function searchProfile(q, mems, limit = 10) {
  const ranked = await rankItems(q, mems, { kind: "memory", textOf: (m) => m.text });
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
};

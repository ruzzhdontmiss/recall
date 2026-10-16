const db = require("./db");
const { buildIndex } = require("./tfidf");
const embeddings = require("./embeddings");

async function ensureRowEmbedding(kind, row, text) {
  await embeddings.getImpl();
  if (!embeddings.isDense()) return null;
  if (row.embedding && row.embedding.length) return row.embedding;
  const vec = await embeddings.embed(text);
  if (vec && vec.length) {
    db.updateEmbedding(kind, row.id, vec);
    row.embedding = vec;
  }
  return row.embedding;
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

  for (const item of items) {
    await ensureRowEmbedding(kind, item, textOf(item));
  }

  const qVec = await embeddings.embed(query, { isQuery: true });
  return items
    .map((item) => ({
      item,
      score: embeddings.cosine(qVec, item.embedding),
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

// Chunk ranking. When the configured provider is lexical, or when embeddings
// are unavailable for the whole set (generation failed / never ran), fall back
// to TF-IDF so uploaded content stays retrievable.
async function ensureChunkEmbedding(chunk) {
  await embeddings.getImpl();
  if (!embeddings.isDense()) return null;
  if (chunk.embedding && chunk.embedding.length) return chunk.embedding;
  const vec = await embeddings.embed(chunk.text);
  if (vec && vec.length) {
    db.updateEmbedding("chunk", chunk.id, vec);
    chunk.embedding = vec;
  }
  return chunk.embedding;
}

async function rankChunks(query, chunks) {
  await embeddings.getImpl();
  if (!chunks.length) return [];

  if (embeddings.isDense()) {
    for (const chunk of chunks) {
      try {
        await ensureChunkEmbedding(chunk);
      } catch {
        /* leave this chunk unembedded; fallback below still applies */
      }
    }
    if (chunks.every((c) => c.embedding && c.embedding.length)) {
      const qVec = await embeddings.embed(query, { isQuery: true });
      return chunks
        .map((item) => ({ item, score: embeddings.cosine(qVec, item.embedding) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);
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

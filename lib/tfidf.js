// Lightweight stand-in for supermemory's embedding pipeline.
// Real supermemory embeds with a model (local bge-base or a provider API).
// This clone uses classic TF-IDF + cosine similarity so it runs fully
// offline with zero API keys and zero native dependencies. Swap `vectorize`
// for a real embedding call if you want true semantic search later.

const STOPWORDS = new Set(
  "a an the and or but if then else for to of in on at by with from is are was were be been being this that these those i you he she it we they my your his her its our their me him us them as it's im i'm ive i've dont don't".split(
    " "
  )
);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

// Builds an IDF table across a corpus of {id, text} items, then returns a
// scoring function that ranks the corpus against a query string.
function buildIndex(items) {
  const df = new Map(); // document frequency per term
  const docs = items.map((item) => {
    const tokens = tokenize(item.text);
    const tf = termFreq(tokens);
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
    return { id: item.id, tf, length: tokens.length || 1 };
  });

  const N = docs.length || 1;
  const idf = new Map();
  for (const [term, count] of df.entries()) {
    idf.set(term, Math.log((N + 1) / (count + 1)) + 1);
  }

  function vecFor(tf) {
    const v = new Map();
    for (const [term, freq] of tf.entries()) {
      const weight = (freq / (docs.find(() => true)?.length || 1)) * (idf.get(term) || 0);
      v.set(term, weight);
    }
    return v;
  }

  function cosine(vA, vB) {
    let dot = 0,
      magA = 0,
      magB = 0;
    for (const [term, w] of vA.entries()) {
      magA += w * w;
      if (vB.has(term)) dot += w * vB.get(term);
    }
    for (const w of vB.values()) magB += w * w;
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  const docVectors = docs.map((d) => ({ id: d.id, vec: vecFor(d.tf) }));

  return {
    score(query) {
      const qTokens = tokenize(query);
      const qTf = termFreq(qTokens);
      const qVec = vecFor(qTf);
      return docVectors
        .map((d) => ({ id: d.id, score: cosine(qVec, d.vec) }))
        .sort((a, b) => b.score - a.score);
    },
  };
}

module.exports = { buildIndex, tokenize };

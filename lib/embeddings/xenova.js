// Local BGE embeddings via Transformers.js. Dynamic import keeps the rest of
// the app on CommonJS. First call downloads/caches the model.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let extractor = null;

function modelId() {
  return process.env.EMBEDDINGS_MODEL || "Xenova/bge-base-en-v1.5";
}

async function ready() {
  if (extractor) return;
  const { pipeline } = await import("@xenova/transformers");
  extractor = await pipeline("feature-extraction", modelId());
}

async function vectorize(text, { isQuery } = {}) {
  await ready();
  const input = isQuery ? QUERY_PREFIX + text : text;
  const output = await extractor(input, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

async function embed(text, opts) {
  return vectorize(text, opts);
}

async function embedMany(texts, opts) {
  const out = [];
  for (const t of texts) out.push(await vectorize(t, opts));
  return out;
}

module.exports = { kind: "xenova", ready, embed, embedMany };

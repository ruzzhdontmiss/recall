// Local BGE embeddings via Transformers.js. Dynamic import keeps the rest of
// the app on CommonJS. First call downloads/caches the model.
//
// This provider used to load @xenova/transformers. It now loads
// @huggingface/transformers (the maintained successor) with the SAME model,
// precision, pooling and query prefix:
//
//   model   : Xenova/bge-base-en-v1.5          (unchanged)
//   dtype   : q8 -> onnx/model_quantized.onnx  (the int8 file @xenova loaded by
//             default, because @xenova defaulted quantized=true)
//   pooling : mean, normalize: true            (unchanged)
//   query   : BGE instruction prefix, queries only (unchanged)
//
// The vector space is NOT preserved, however: the library bump also moved the
// ONNX runtime (onnxruntime-node 1.14.0 -> 1.30.0) and the int8 numerics changed
// for identical token ids. Vectors from the old stack are therefore a DIFFERENT
// space and are re-embedded before use (see lib/embeddings/index.js:
// LOCAL_SPACE_REVISION plus the runtime-derived space identity).
//
// @huggingface/transformers defaults to fp32 on Node, which is yet another
// different space, so dtype is pinned (EMBEDDINGS_DTYPE) instead of left to the
// library default.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const DEFAULT_MODEL = "Xenova/bge-base-en-v1.5";
const DEFAULT_DTYPE = "q8";

let extractor = null;

function modelId() {
  return process.env.EMBEDDINGS_MODEL || DEFAULT_MODEL;
}

function dtype() {
  const d = (process.env.EMBEDDINGS_DTYPE || DEFAULT_DTYPE).toLowerCase().trim();
  return d || DEFAULT_DTYPE;
}

async function ready() {
  if (extractor) return;
  const { pipeline, env } = await import("@huggingface/transformers");

  // Cache + offline controls. The default cache lives under node_modules and is
  // wiped by `npm ci`; EMBEDDINGS_CACHE_DIR keeps it durable across reinstalls,
  // and EMBEDDINGS_OFFLINE=true forbids network fetches (fails if not cached).
  if (env) {
    if (process.env.EMBEDDINGS_CACHE_DIR) env.cacheDir = process.env.EMBEDDINGS_CACHE_DIR;
    if (process.env.EMBEDDINGS_LOCAL_MODEL_PATH) {
      env.localModelPath = process.env.EMBEDDINGS_LOCAL_MODEL_PATH;
    }
    if (String(process.env.EMBEDDINGS_OFFLINE || "").toLowerCase() === "true") {
      env.allowRemoteModels = false;
    }
  }

  extractor = await pipeline("feature-extraction", modelId(), { dtype: dtype() });
}

async function vectorize(text, { isQuery } = {}) {
  await ready();
  const input = isQuery ? QUERY_PREFIX + text : text;
  const output = await extractor(input, { pooling: "mean", normalize: true });
  const vec = Array.from(output.data);
  for (const value of vec) {
    if (!Number.isFinite(value)) throw new Error("embedding produced a non-finite value");
  }
  return vec;
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

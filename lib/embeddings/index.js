const path = require("path");
const fs = require("fs");
const { cosine } = require("./cosine");
const vectorSpace = require("./space");

let impl = null;
let initPromise = null;
let providerName = "uninitialized";
// Set once an initialization attempt has FAILED with no provider loaded (e.g. a
// hosted provider with missing credentials). It lets activeDescribe() report an
// explicit uninitialized space instead of the configured — but never loaded —
// dense provider. Cleared again when a later attempt succeeds.
let initFailed = false;

function requestedProvider() {
  return (process.env.EMBEDDINGS_PROVIDER || "xenova").toLowerCase().trim();
}

function getProviderName() {
  return providerName;
}

const DEFAULT_MODELS = {
  xenova: "Xenova/bge-base-en-v1.5",
  openai: "text-embedding-3-small",
  gemini: "text-embedding-004",
};

const DEFAULT_DTYPE = "q8";

// Revision of the LOCAL vector-producing stack. Bump it whenever a change alters
// the vector for the same input that is NOT already captured by the resolved
// runtime versions below (e.g. a change to pooling, the model file, or the query
// prefix). It is encoded into the per-row `embedding_model`, so vectors from an
// older stack are detected as stale and re-embedded rather than compared.
//
//   r1: @xenova/transformers 2.x + onnxruntime-node 1.14.0 (bare model id)
//   r2: @huggingface/transformers 4.3.1 + onnxruntime-node 1.30.0
const LOCAL_SPACE_REVISION = 2;

// Resolve the installed runtime versions that determine the local numeric space.
// A change in @huggingface/transformers or onnxruntime-node can change the vector
// for the same input even when the model and tokenizer look identical — this is
// exactly what happened across the @xenova -> @huggingface migration (identical
// token ids, different int8 numerics). Both are therefore baked into the space
// identity so a caret upgrade cannot silently reuse incompatible vectors.
//
// Resolution is best-effort, cached, and never loads the model. If a version
// cannot be read we record "?" so the identity stays deterministic.
let runtimeFingerprint = null;

function nearestPackageJson(startFile) {
  let dir = path.dirname(startFile);
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function versionAt(packageJsonPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function resolveVersion(spec, fromDir) {
  try {
    const entry = require.resolve(spec, fromDir ? { paths: [fromDir] } : undefined);
    const pkg = nearestPackageJson(entry);
    return pkg ? versionAt(pkg) : null;
  } catch {
    return null;
  }
}

function localRuntimeFingerprint() {
  if (runtimeFingerprint) return runtimeFingerprint;
  let transformers = null;
  let onnxruntime = null;
  try {
    // `require.resolve` only resolves the path; it does not load the ESM module.
    const entry = require.resolve("@huggingface/transformers");
    const pkg = nearestPackageJson(entry);
    transformers = pkg ? versionAt(pkg) : null;
    if (pkg) onnxruntime = resolveVersion("onnxruntime-node", path.dirname(pkg));
  } catch {
    /* package not installed (e.g. a tfidf-only deployment) */
  }
  runtimeFingerprint = { transformers, onnxruntime };
  return runtimeFingerprint;
}

function localDtype() {
  const d = (process.env.EMBEDDINGS_DTYPE || DEFAULT_DTYPE).toLowerCase().trim();
  return d || DEFAULT_DTYPE;
}

// Space-qualified model id recorded on every vector row. For the local provider
// it encodes precision + stack revision + resolved runtime versions; hosted
// providers keep the plain model id (their space is managed by the provider, not
// by our dependency tree).
function spaceModel(provider, base) {
  if (provider === "xenova") {
    return vectorSpace.localSpaceModel({
      base,
      dtype: localDtype(),
      revision: LOCAL_SPACE_REVISION,
      fingerprint: localRuntimeFingerprint(),
    });
  }
  return base;
}

// Provider/model metadata for the *configured* backend, without loading any
// model. Used by search to detect rows produced by a different vector space.
// `space` is the human readable identity; `provider`/`model` are the per-row
// fields that must match.
function describe() {
  const provider = requestedProvider();
  if (provider === "tfidf") return { provider: "tfidf", model: null, space: "tfidf" };
  const base = process.env.EMBEDDINGS_MODEL || DEFAULT_MODELS[provider] || null;
  const model = spaceModel(provider, base);
  return { provider, model, space: `${provider}:${model}` };
}

// Like describe(), but reflects the provider that is ACTUALLY loaded once
// initialization has run. It cannot be mistaken for a valid dense space when the
// configured provider is not usable:
//   * the local provider failed and we fell back to lexical search -> "tfidf";
//   * a hosted provider failed to initialize (e.g. no credentials) -> an
//     explicit "uninitialized" space, never the configured dense one.
// Persisted bookkeeping therefore can never claim a dense space for a run that is
// really lexical or has no provider at all. Before any initialization attempt it
// equals describe() (the configured/intended space).
function activeDescribe() {
  if (providerName === "tfidf") return { provider: "tfidf", model: null, space: "tfidf" };
  if (initFailed) return { provider: "uninitialized", model: null, space: "uninitialized" };
  return describe();
}

// True once a provider has actually loaded (dense or lexical). False while no
// provider is available — either not yet attempted, or initialization failed.
function isInitialized() {
  return providerName !== "uninitialized";
}

// The current vector-space identity. Two vectors may only be compared when both
// were produced in the same space.
function space() {
  return describe().space;
}

function activeSpace() {
  return activeDescribe().space;
}

function isDense() {
  return providerName !== "tfidf" && providerName !== "uninitialized";
}

async function createImpl() {
  const name = requestedProvider();

  if (name === "tfidf") {
    providerName = "tfidf";
    return require("./tfidf");
  }

  if (name === "openai") {
    const openai = require("./openai");
    await openai.ready();
    providerName = "openai";
    return openai;
  }

  if (name === "gemini") {
    const gemini = require("./gemini");
    await gemini.ready();
    providerName = "gemini";
    return gemini;
  }

  try {
    const xenova = require("./xenova");
    await xenova.ready();
    providerName = "xenova";
    return xenova;
  } catch (err) {
    console.warn(
      `[embeddings] xenova failed (${err.message}); falling back to tf-idf lexical search`
    );
    providerName = "tfidf";
    return require("./tfidf");
  }
}

async function getImpl() {
  if (impl) return impl;
  if (!initPromise) {
    initPromise = createImpl()
      .then((loaded) => {
        impl = loaded;
        initFailed = false;
        console.log(`[embeddings] provider=${providerName}`);
        return impl;
      })
      .catch((err) => {
        initPromise = null;
        initFailed = true;
        throw err;
      });
  }
  return initPromise;
}

async function warmup() {
  try {
    await getImpl();
  } catch (err) {
    console.warn(`[embeddings] warmup failed: ${err.message}`);
  }
}

async function embed(text, opts) {
  const provider = await getImpl();
  if (provider.kind === "tfidf") return null;
  return provider.embed(text, opts);
}

async function embedMany(texts, opts) {
  const provider = await getImpl();
  if (provider.kind === "tfidf") return (texts || []).map(() => null);
  return provider.embedMany(texts, opts);
}

module.exports = {
  embed,
  embedMany,
  cosine,
  getProviderName,
  getImpl,
  isDense,
  isInitialized,
  warmup,
  requestedProvider,
  describe,
  activeDescribe,
  space,
  activeSpace,
  localRuntimeFingerprint,
};

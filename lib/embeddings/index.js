const { cosine } = require("./cosine");

let impl = null;
let initPromise = null;
let providerName = "uninitialized";

function requestedProvider() {
  return (process.env.EMBEDDINGS_PROVIDER || "xenova").toLowerCase().trim();
}

function getProviderName() {
  return providerName;
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
        console.log(`[embeddings] provider=${providerName}`);
        return impl;
      })
      .catch((err) => {
        initPromise = null;
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
  warmup,
  requestedProvider,
};

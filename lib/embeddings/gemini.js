const DEFAULT_MODEL = "text-embedding-004";

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

function model() {
  return process.env.EMBEDDINGS_MODEL || DEFAULT_MODEL;
}

async function ready() {
  if (!apiKey()) {
    throw new Error("EMBEDDINGS_PROVIDER=gemini requires GEMINI_API_KEY or GOOGLE_API_KEY");
  }
}

async function embedOne(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model()}:embedContent?key=${encodeURIComponent(
    apiKey()
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini embeddings ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.embedding && data.embedding.values;
}

async function embed(text) {
  return embedOne(text);
}

async function embedMany(texts) {
  const out = [];
  for (const t of texts) out.push(await embedOne(t));
  return out;
}

module.exports = { kind: "gemini", ready, embed, embedMany };

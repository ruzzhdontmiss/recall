const DEFAULT_MODEL = "text-embedding-3-small";

function apiKey() {
  return process.env.OPENAI_API_KEY;
}

function model() {
  return process.env.EMBEDDINGS_MODEL || DEFAULT_MODEL;
}

async function ready() {
  if (!apiKey()) {
    throw new Error("EMBEDDINGS_PROVIDER=openai requires OPENAI_API_KEY");
  }
}

async function request(input) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: model(), input }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const sorted = (data.data || []).slice().sort((a, b) => a.index - b.index);
  return sorted.map((row) => row.embedding);
}

async function embed(text) {
  const [vec] = await request(text);
  return vec;
}

async function embedMany(texts) {
  if (!texts.length) return [];
  return request(texts);
}

module.exports = { kind: "openai", ready, embed, embedMany };

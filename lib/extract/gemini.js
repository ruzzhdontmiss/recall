const { SYSTEM_PROMPT, FACTS_SCHEMA, parseModelJson } = require("./schema");

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

function model() {
  return process.env.EXTRACTION_MODEL || process.env.GEMINI_EXTRACTION_MODEL || "gemini-2.0-flash";
}

async function extractFacts(content) {
  const key = apiKey();
  if (!key) throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model()}:generateContent?key=${encodeURIComponent(
    key
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: content }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: FACTS_SCHEMA,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini extract ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const text =
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts.map((p) => p.text || "").join("");
  return parseModelJson(text);
}

module.exports = { extractFacts };

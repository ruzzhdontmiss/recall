const { SYSTEM_PROMPT, FACTS_SCHEMA, parseModelJson } = require("./schema");

function apiKey() {
  return process.env.OPENAI_API_KEY;
}

function model() {
  return process.env.EXTRACTION_MODEL || process.env.OPENAI_EXTRACTION_MODEL || "gpt-4o-mini";
}

async function complete(content, response_format) {
  const key = apiKey();
  if (!key) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model(),
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      response_format,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI extract ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return parseModelJson(text);
}

async function extractFacts(content) {
  try {
    return await complete(content, {
      type: "json_schema",
      json_schema: {
        name: "memory_facts",
        strict: true,
        schema: FACTS_SCHEMA,
      },
    });
  } catch (err) {
    if (!/OpenAI extract 400/.test(err.message)) throw err;
    return complete(content, { type: "json_object" });
  }
}

module.exports = { extractFacts };

const { SYSTEM_PROMPT, FACTS_SCHEMA, parseModelJson } = require("./schema");

function apiKey() {
  return process.env.ANTHROPIC_API_KEY;
}

function model() {
  return process.env.EXTRACTION_MODEL || process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
}

async function extractFacts(content) {
  const key = apiKey();
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model(),
      max_tokens: 1024,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: "extract_memories",
          description: "Record structured facts extracted from the user document.",
          input_schema: FACTS_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: "extract_memories" },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic extract ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === "tool_use" && b.name === "extract_memories");
  if (block && block.input) return parseModelJson(JSON.stringify(block.input));
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (textBlock) return parseModelJson(textBlock.text);
  throw new Error("Anthropic response missing extract_memories tool use");
}

module.exports = { extractFacts };

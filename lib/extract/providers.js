const openai = require("./openai");
const anthropic = require("./anthropic");
const gemini = require("./gemini");

function hasOpenAI() {
  return Boolean(process.env.OPENAI_API_KEY);
}
function hasAnthropic() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
function hasGemini() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

function requestedName() {
  const raw = (process.env.EXTRACTION_PROVIDER || "auto").toLowerCase().trim();
  if (raw === "claude") return "anthropic";
  return raw;
}

function resolveExtractionProvider() {
  const name = requestedName();
  if (name === "regex" || name === "none") return "regex";
  if (name === "openai") {
    if (hasOpenAI()) return "openai";
    console.warn("[extract] EXTRACTION_PROVIDER=openai but OPENAI_API_KEY is missing; using regex");
    return "regex";
  }
  if (name === "anthropic") {
    if (hasAnthropic()) return "anthropic";
    console.warn("[extract] EXTRACTION_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing; using regex");
    return "regex";
  }
  if (name === "gemini") {
    if (hasGemini()) return "gemini";
    console.warn("[extract] EXTRACTION_PROVIDER=gemini but GEMINI_API_KEY is missing; using regex");
    return "regex";
  }
  if (name === "auto") {
    if (hasAnthropic()) return "anthropic";
    if (hasOpenAI()) return "openai";
    if (hasGemini()) return "gemini";
    return "regex";
  }
  console.warn(`[extract] unknown EXTRACTION_PROVIDER=${name}; using regex`);
  return "regex";
}

async function llmExtract(content, provider) {
  if (provider === "openai") return openai.extractFacts(content);
  if (provider === "anthropic") return anthropic.extractFacts(content);
  if (provider === "gemini") return gemini.extractFacts(content);
  throw new Error(`unknown extraction provider: ${provider}`);
}

function hasLlmKey() {
  return hasAnthropic() || hasOpenAI() || hasGemini();
}

module.exports = {
  resolveExtractionProvider,
  llmExtract,
  hasLlmKey,
  requestedName,
};

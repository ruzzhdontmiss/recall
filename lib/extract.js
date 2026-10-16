// Fact extraction: LLM structured output when an API key is set, regex fallback
// otherwise. Slot supersession and TTL live in persist.js and stay provider-agnostic.

const { regexFacts, splitSentences, classify, slotFor } = require("./extract/regex");
const { persistFacts, effectiveStatus } = require("./extract/persist");
const { resolveExtractionProvider, llmExtract } = require("./extract/providers");

let loggedProvider = false;

async function classifyContent(content) {
  const provider = resolveExtractionProvider();
  if (!loggedProvider) {
    loggedProvider = true;
    console.log(`[extract] provider=${provider}`);
  }
  if (provider === "regex") {
    return { facts: regexFacts(content), provider };
  }
  try {
    const facts = await llmExtract(content, provider);
    if (!facts.length) {
      console.warn("[extract] LLM returned no facts; falling back to regex");
      return { facts: regexFacts(content), provider: "regex" };
    }
    return { facts, provider };
  } catch (err) {
    console.warn(`[extract] ${provider} failed (${err.message}); falling back to regex`);
    return { facts: regexFacts(content), provider: "regex" };
  }
}

async function extractMemories({ documentId, containerTag, content, db, now = new Date() }) {
  const { facts, provider } = await classifyContent(content);
  return persistFacts({
    documentId,
    containerTag,
    facts,
    db,
    now,
    extractedBy: provider,
  });
}

module.exports = {
  extractMemories,
  classifyContent,
  persistFacts,
  effectiveStatus,
  splitSentences,
  classify,
  slotFor,
  regexFacts,
  resolveExtractionProvider,
};

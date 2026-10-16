const crypto = require("crypto");
const { ttlFromText } = require("./regex");

function persistFacts({
  documentId,
  containerTag,
  facts,
  db,
  now = new Date(),
  extractedBy = "regex",
  embeddings = null,
}) {
  const created = [];

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const type = fact.type || "note";
    const slot = type === "static" ? fact.slot || null : null;
    const slotValue = slot ? fact.slotValue || null : null;

    if (slot) {
      for (const existing of db.memories) {
        if (
          existing.containerTag === containerTag &&
          existing.slot === slot &&
          existing.status === "active"
        ) {
          existing.status = "superseded";
          existing.supersededAt = now.toISOString();
        }
      }
    }

    let ttlDays = type === "dynamic" ? fact.ttlDays : null;
    if (type === "dynamic" && (ttlDays == null || ttlDays <= 0)) {
      ttlDays = ttlFromText(fact.text, 14);
    }

    const mem = db.addMemory({
      id: crypto.randomUUID(),
      documentId,
      containerTag,
      text: fact.text,
      type,
      slot,
      slotValue,
      status: "active",
      createdAt: now.toISOString(),
      expiresAt:
        type === "dynamic" ? new Date(now.getTime() + ttlDays * 86400000).toISOString() : null,
      supersedes: null,
      extractedBy,
      // Pre-generated vectors (aligned to `facts`) are stored with the row;
      // null means "backfill later".
      embedding: embeddings ? embeddings[i] || null : null,
    });
    created.push(mem);
  }

  return created;
}

function effectiveStatus(memory, now = new Date()) {
  if (memory.status === "superseded") return "superseded";
  if (memory.status === "forgotten") return "forgotten";
  if (memory.type === "dynamic" && memory.expiresAt && new Date(memory.expiresAt) < now) {
    return "expired";
  }
  return memory.status;
}

module.exports = { persistFacts, effectiveStatus };

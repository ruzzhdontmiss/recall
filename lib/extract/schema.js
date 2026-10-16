const ALLOWED_TYPES = new Set(["static", "dynamic", "note"]);

const KNOWN_SLOTS = [
  "location",
  "employer",
  "role",
  "editor",
  "language_pref",
  "name",
  "timezone",
  "pet",
  "allergy",
  "family",
  "preference",
  "diet",
];

const FACTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["static", "dynamic", "note"] },
          text: { type: "string" },
          slot: { type: ["string", "null"] },
          slotValue: { type: ["string", "null"] },
          ttlDays: { type: ["number", "null"] },
        },
        required: ["type", "text", "slot", "slotValue", "ttlDays"],
      },
    },
  },
  required: ["facts"],
};

const SYSTEM_PROMPT = `You extract durable and temporary facts about the USER from a document (journal, chat, note).

Return JSON matching the schema. Rules:
- static: identity, home, job, tools, lasting preferences, allergies, family, pets.
- dynamic: time-bounded (today, this week, currently, on-call, shipping soon). Set ttlDays (1, 3, 7, 14, or 21).
- note: only if nothing is a fact; prefer omitting notes when there are real facts.
- slot: one of ${KNOWN_SLOTS.join(", ")} or null. Use the same slot when a later sentence contradicts an earlier one.
- If the user retracts or corrects ("ignore what I said about Berlin", "I moved"), emit ONLY the latest true fact for that slot. Do not also emit the retracted fact.
- Read the WHOLE document. Multi-clause and non-English are in scope. Write 'text' as a short English fact even if the source is another language (keep place names).
- slotValue: the canonical value (city, company, tool), else null.
- ttlDays: integer days for dynamic, else null.
- Do not invent facts that are not supported by the document.`;

function normalizeSlot(slot) {
  if (!slot || typeof slot !== "string") return null;
  const s = slot.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return s || null;
}

function normalizeFacts(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.facts) ? raw.facts : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
    const type = ALLOWED_TYPES.has(item.type) ? item.type : "note";
    let ttlDays = item.ttlDays == null || item.ttlDays === "" ? null : Number(item.ttlDays);
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) ttlDays = null;
    if (type === "dynamic" && ttlDays == null) ttlDays = 14;
    if (type !== "dynamic") ttlDays = null;
    const slot = type === "static" ? normalizeSlot(item.slot) : null;
    const slotValue =
      item.slotValue == null || item.slotValue === ""
        ? null
        : String(item.slotValue).trim().replace(/[.,]$/, "");
    out.push({
      type,
      text: item.text.trim(),
      slot,
      slotValue,
      ttlDays,
    });
  }
  return collapseSameSlot(out);
}

// If the model emits two static facts in the same slot, keep the last.
function collapseSameSlot(facts) {
  const lastIndex = new Map();
  facts.forEach((f, i) => {
    if (f.type === "static" && f.slot) lastIndex.set(f.slot, i);
  });
  return facts.filter((f, i) => {
    if (f.type === "static" && f.slot) return lastIndex.get(f.slot) === i;
    return true;
  });
}

function parseModelJson(text) {
  if (!text || typeof text !== "string") throw new Error("empty model output");
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : trimmed;
  const parsed = JSON.parse(body);
  return normalizeFacts(parsed);
}

module.exports = {
  FACTS_SCHEMA,
  SYSTEM_PROMPT,
  KNOWN_SLOTS,
  normalizeFacts,
  parseModelJson,
  normalizeSlot,
};

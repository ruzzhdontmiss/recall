// Maps a natural-language query to the extracted memory slots that answer it.
//
// This is a deliberately small, transparent prior used by hybrid reranking. An
// explicit question about a location should prefer a fact that extraction put
// in the `location` slot even when the embedding model ranks a nearby fact a
// little higher. It is keyword-based, offline, and independent of any fixture
// data; it only ever adds a small bonus to already-retrieved candidates.
//
// The patterns are heuristics, not a parser. In particular, "working on" is
// excluded from employer detection because it describes the current task, not
// who employs the user. A bare "work at" is intentionally NOT treated as an
// employer question: "How many employees work at Globex?" asks about company
// size, not about the user's employer.

const PATTERNS = [
  { slot: "employer", re: /\b(?:employer|company|companies)\b/ },
  { slot: "employer", re: /\bwho\b[^?]*\bwork(?:s|ed)?\s+for\b/ },
  { slot: "employer", re: /\bwhere\b[^?]*\bwork(?:s|ed)?\b/ },
  { slot: "role", re: /\b(?:role|title|position|job)\b/ },
  { slot: "role", re: /\bkind\s+of\s+(?:engineer|developer|designer|manager)\b/ },
  {
    slot: "location",
    re: /\b(?:live|lives|living|based|located|location|city|hometown|reside|residing)\b/,
  },
  { slot: "editor", re: /\b(?:editor|ide)\b/ },
  { slot: "language_pref", re: /\b(?:language|programming|coding)\b/ },
];

function slotsForQuery(query) {
  const q = String(query || "").toLowerCase();
  const slots = new Set();
  const workingOn = /\bworking\s+on\b/.test(q);
  for (const { slot, re } of PATTERNS) {
    if (slot === "employer" && workingOn) continue;
    if (re.test(q)) slots.add(slot);
  }
  return slots;
}

module.exports = { slotsForQuery };

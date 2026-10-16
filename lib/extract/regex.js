const SLOT_PATTERNS = [
  { slot: "location", re: /\bi(?:'m| am)?\s*(?:now\s+)?(?:live|living|based)\s+in\s+([a-z0-9\s,]+)/i },
  { slot: "employer", re: /\bi work (?:at|for)\s+([a-z0-9\s&.,]+)/i },
  { slot: "role", re: /\bi(?:'m| am)?\s*(?:work(?:ing)? as|a|an)?\s*(?:a |an )?([a-z\s]+(?:engineer|developer|designer|manager|founder|student|lawyer|doctor|writer|scientist))/i },
  { slot: "editor", re: /\bi use\s+([a-z0-9\s]+?)\s+(?:as my editor|editor)\b/i },
  { slot: "language_pref", re: /\bi prefer\s+([a-z0-9\s]+?)(?:\s+over\s+[a-z0-9\s]+)?\.?$/i },
];

const STATIC_TRIGGERS = [
  /\bi am\b/i,
  /\bi'm\b/i,
  /\bi live\b/i,
  /\bi work\b/i,
  /\bi prefer\b/i,
  /\bi like\b/i,
  /\bi love\b/i,
  /\bi hate\b/i,
  /\bi use\b/i,
  /\bmy favorite\b/i,
  /\balways\b/i,
];

const DYNAMIC_TRIGGERS = [
  { re: /\btomorrow\b/i, ttlDays: 1 },
  { re: /\btoday\b/i, ttlDays: 1 },
  { re: /\bthis week\b/i, ttlDays: 7 },
  { re: /\byesterday\b/i, ttlDays: 1 },
  { re: /\bright now\b/i, ttlDays: 3 },
  { re: /\bcurrently\b/i, ttlDays: 14 },
  { re: /\bi'm working on\b/i, ttlDays: 21 },
  { re: /\bi am working on\b/i, ttlDays: 21 },
  { re: /\bi just\b/i, ttlDays: 5 },
];

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function slotFor(sentence) {
  for (const { slot, re } of SLOT_PATTERNS) {
    const m = sentence.match(re);
    if (m) return { slot, value: m[1].trim().replace(/[.,]$/, "") };
  }
  return null;
}

function classify(sentence) {
  for (const trig of DYNAMIC_TRIGGERS) {
    if (trig.re.test(sentence)) {
      return { type: "dynamic", ttlDays: trig.ttlDays };
    }
  }
  if (slotFor(sentence)) return { type: "static" };
  for (const re of STATIC_TRIGGERS) {
    if (re.test(sentence)) {
      return { type: "static" };
    }
  }
  return { type: "note" };
}

function ttlFromText(sentence, fallback) {
  for (const trig of DYNAMIC_TRIGGERS) {
    if (trig.re.test(sentence)) return trig.ttlDays;
  }
  return fallback;
}

function regexFacts(content) {
  return splitSentences(content).map((sentence) => {
    const { type, ttlDays } = classify(sentence);
    const slotMatch = type === "static" ? slotFor(sentence) : null;
    return {
      type,
      text: sentence,
      slot: slotMatch ? slotMatch.slot : null,
      slotValue: slotMatch ? slotMatch.value : null,
      ttlDays: type === "dynamic" ? ttlDays : null,
    };
  });
}

module.exports = {
  SLOT_PATTERNS,
  STATIC_TRIGGERS,
  DYNAMIC_TRIGGERS,
  splitSentences,
  slotFor,
  classify,
  regexFacts,
  ttlFromText,
};

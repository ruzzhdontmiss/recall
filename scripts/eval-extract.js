#!/usr/bin/env node
// Phase 2: regex misses ≥20 phrasings; LLM (when keyed) extracts them;
// slot supersession still works for whole-document retractions.
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

process.env.DATA_DIR = path.join(__dirname, "..", "data", "eval-extract");

const db = require("../lib/db");
const {
  regexFacts,
  persistFacts,
  classifyContent,
  resolveExtractionProvider,
} = require("../lib/extract");
const { hasLlmKey } = require("../lib/extract/providers");
const { parseModelJson } = require("../lib/extract/schema");
const cases = require("./extract-cases");
const golden = require("./fixtures/extract-llm-json.json");

function factMatches(fact, expect) {
  if (!fact || fact.type === "note") return false;
  if (expect.type && fact.type !== expect.type) return false;
  if (expect.types && !expect.types.includes(fact.type)) return false;
  if (expect.slot && fact.slot !== expect.slot) return false;
  if (expect.valueRe) {
    const blob = `${fact.text || ""} ${fact.slotValue || ""}`;
    if (!expect.valueRe.test(blob)) return false;
  }
  return true;
}

function listMatches(facts, expect) {
  return facts.some((f) => factMatches(f, expect));
}

async function main() {
  const regexMisses = [];
  for (const c of cases) {
    const facts = regexFacts(c.content);
    const hit = listMatches(facts, c.expect);
    const bad = c.reject ? listMatches(facts, c.reject) : false;
    if (!hit || bad) regexMisses.push(c.id);
  }

  // Retraction: regex keeps Berlin; that document is the multi-clause case.
  const retract = cases.find((c) => c.id === "retract-berlin");
  const retractRegex = regexFacts(retract.content);
  const regexKeepsBerlin = retractRegex.some(
    (f) => f.slot === "location" && /berlin/i.test(`${f.text} ${f.slotValue || ""}`)
  );
  const regexHasLisbon = listMatches(retractRegex, retract.expect);

  if (regexMisses.length < 20) {
    throw new Error(`expected ≥20 regex misses, got ${regexMisses.length}: ${regexMisses.join(", ")}`);
  }
  if (!regexKeepsBerlin || regexHasLisbon) {
    // First clause is the classic "I live in Berlin" slot; second clause should not
    // replace it under regex. If this throws, the regex rules got too smart.
    throw new Error("regex retraction fixture no longer demonstrates the gap");
  }

  console.log(`regex misses ${regexMisses.length}/${cases.length} fixture phrasings (need ≥20)`);

  db.reset();
  const now = new Date();
  persistFacts({
    documentId: crypto.randomUUID(),
    containerTag: "eval_retract",
    facts: retractRegex,
    db,
    now,
    extractedBy: "regex",
  });
  persistFacts({
    documentId: crypto.randomUUID(),
    containerTag: "eval_retract",
    facts: [
      {
        type: "static",
        slot: "location",
        slotValue: "Lisbon",
        text: "Lives in Lisbon",
        ttlDays: null,
      },
    ],
    db,
    now: new Date(now.getTime() + 1000),
    extractedBy: "openai",
  });
  const loc = db.memories.filter((m) => m.containerTag === "eval_retract" && m.slot === "location");
  const activeLoc = loc.filter((m) => m.status === "active");
  const superseded = loc.filter((m) => m.status === "superseded");
  if (activeLoc.length !== 1 || !/lisbon/i.test(activeLoc[0].slotValue || activeLoc[0].text)) {
    throw new Error("persist did not supersede location with Lisbon");
  }
  if (!superseded.some((m) => /berlin/i.test(`${m.text} ${m.slotValue || ""}`))) {
    throw new Error("persist did not mark Berlin location as superseded");
  }
  console.log("PASS: slot supersession still applies after structured (LLM-shaped) facts");

  let structuredPass = 0;
  for (const c of cases) {
    if (!golden[c.id]) throw new Error(`missing golden JSON for ${c.id}`);
    const facts = parseModelJson(JSON.stringify(golden[c.id]));
    const ok = listMatches(facts, c.expect);
    const bad = c.reject ? listMatches(facts, c.reject) : false;
    if (!ok || bad) {
      throw new Error(`structured sample failed for ${c.id}: ${JSON.stringify(facts)}`);
    }
    structuredPass += 1;
  }
  console.log(
    `PASS: structured extractor schema handles ${structuredPass} regex-miss phrasings (golden LLM JSON)`
  );

  const provider = resolveExtractionProvider();
  if (!hasLlmKey() || provider === "regex") {
    console.log(
      "SKIP live LLM: set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY (and extra EXTRACTION_PROVIDER if you want a specific one)"
    );
    console.log("PASS: regex-gap + persist + structured schema (≥20 phrasings)");
    return;
  }

  console.log(`live extraction provider=${provider}`);
  let pass = 0;
  const failures = [];
  for (const c of cases) {
    db.reset();
    const { facts } = await classifyContent(c.content);
    const ok = listMatches(facts, c.expect);
    const bad = c.reject ? listMatches(facts, c.reject) : false;
    if (ok && !bad) {
      pass += 1;
      console.log(`  ok  ${c.id}`);
    } else {
      failures.push({ id: c.id, facts });
      console.log(`  FAIL ${c.id} -> ${JSON.stringify(facts)}`);
    }
  }
  console.log(`live ${pass}/${cases.length}`);
  if (pass < 20) {
    throw new Error(`LLM extraction passed ${pass}; need at least 20. Failures: ${failures.map((f) => f.id).join(", ")}`);
  }
  console.log("PASS: LLM extraction covered ≥20 regex-miss phrasings");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    db.flush();
    try {
      fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

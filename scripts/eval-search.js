#!/usr/bin/env node
// Paraphrase probe for Phase 1: "where does the user work" should rank a
// memory that never shares those keywords ("I'm employed by Acme Corp").
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

process.env.DATA_DIR = path.join(__dirname, "..", "data", "eval-run");
process.env.EXTRACTION_PROVIDER = process.env.EXTRACTION_PROVIDER || "regex";

const db = require("../lib/db");
const { extractMemories, effectiveStatus } = require("../lib/extract");
const { attachOnIngest, searchMemories } = require("../lib/search");
const embeddings = require("../lib/embeddings");

const QUERY = "where does the user work";
const CONTENT = "I'm employed by Acme Corp";

async function main() {
  db.reset();
  const now = new Date();
  const doc = db.addDocument({
    id: crypto.randomUUID(),
    containerTag: "eval_phase1",
    content: CONTENT,
    createdAt: now.toISOString(),
  });
  const memories = await extractMemories({
    documentId: doc.id,
    containerTag: "eval_phase1",
    content: doc.content,
    db,
    now,
  });
  await attachOnIngest({ document: doc, memories });

  const provider = embeddings.getProviderName();
  const active = db.memories.filter((m) => effectiveStatus(m, now) === "active");
  const hits = await searchMemories(QUERY, active);
  const top = hits[0];

  console.log(`provider: ${provider}`);
  console.log(`ingested: ${CONTENT}`);
  console.log(`query:    ${QUERY}`);
  console.log(`top hit:  ${top ? `${top.score}  ${top.text}` : "(none)"}`);

  const ok = top && /acme/i.test(top.text);
  if (provider === "tfidf") {
    throw new Error(
      "still on tf-idf (xenova did not load). Semantic paraphrase match is not expected."
    );
  }
  if (!ok) {
    throw new Error("top memory was not the Acme employment fact");
  }
  console.log("PASS: semantic paraphrase ranked the employment memory first");
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

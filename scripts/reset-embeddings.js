#!/usr/bin/env node
// Invalidate ALL stored embeddings so a restored (older) embedding stack can
// regenerate them in its own vector space.
//
// This is the safe rollback step. A plain code/dependency rollback is NOT
// sufficient: the previous code reused any non-empty stored vector, so it would
// score vectors that were produced in the NEW space (same dimension, different
// space) — silently mixing spaces. Clearing the vectors first forces the
// restored stack to regenerate them.
//
// Records, provenance and text are preserved; only vector fields and the
// recorded embedding-space identity are cleared. Dry-run by default.
//
// Usage:
//   npm run embeddings:reset                 # dry run: report what would change
//   npm run embeddings:reset -- --apply      # clear vectors + space metadata
//
// Run this BEFORE restoring the previous code/dependencies (see README,
// "Embedding-space rollback"). Stop the server first.

const db = require("../lib/db");

function parseArgs(argv) {
  const opts = { apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--dry-run") opts.apply = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function usage() {
  console.log(
    [
      "Usage: node scripts/reset-embeddings.js [options]",
      "",
      "  --dry-run   report only; write nothing (default)",
      "  --apply     clear every stored vector + the recorded space identity",
      "",
      "Stop the server before using --apply. See README (Embedding-space rollback).",
    ].join("\n")
  );
}

function hasVector(row) {
  return (
    row.embedding != null ||
    row.embeddingProvider != null ||
    row.embeddingModel != null ||
    row.embeddingDim != null
  );
}

// Count rows that carry a vector or its metadata, without writing anything.
function countEmbeddings() {
  const containers = new Set();
  let documents = 0;
  let memories = 0;
  let chunks = 0;
  for (const d of db.documents) {
    containers.add(d.containerTag);
    if (hasVector(d)) documents += 1;
  }
  for (const m of db.memories) {
    containers.add(m.containerTag);
    if (hasVector(m)) memories += 1;
  }
  for (const tag of containers) {
    for (const c of db.listChunks(tag)) if (hasVector(c)) chunks += 1;
  }
  return { documents, memories, chunks };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return void usage();

  console.log(`[reset] backend=${db.backend}`);
  const before = countEmbeddings();
  const total = before.documents + before.memories + before.chunks;
  console.log(
    `[reset] documents=${before.documents} memories=${before.memories} chunks=${before.chunks}`
  );

  if (!opts.apply) {
    console.log(`[reset] DRY RUN — ${total} rows would have their vectors cleared. No row data written.`);
    console.log(
      "[reset] note: opening the store may initialize the database/schema if it does not exist."
    );
    return;
  }

  const { cleared } = db.invalidateEmbeddings();

  // Verify from the store (fresh reads) before claiming success.
  const after = countEmbeddings();
  const remaining = after.documents + after.memories + after.chunks;
  const recorded = typeof db.getMeta === "function" ? db.getMeta("embedding_space") : null;

  console.log(`[reset] cleared=${cleared} recorded_space=${recorded || "(none)"}`);
  if (remaining !== 0) {
    console.error(`[reset] VERIFICATION FAILED: ${remaining} rows still carry vector metadata.`);
    process.exitCode = 1;
    return;
  }
  console.log("[reset] VERIFIED: no stored vectors remain; the restored stack will regenerate them.");
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch((err) => {
      console.error(`[reset] ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    });
}

module.exports = { countEmbeddings, hasVector, main };

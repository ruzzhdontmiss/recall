#!/usr/bin/env node
// Re-embed stored vectors that do not belong to the current vector space.
//
// Safety properties:
//   * dry-run by default: it only counts what WOULD change and writes nothing
//   * never prints document/memory/chunk text — only kinds, ids and counts
//   * only re-embeds rows that are provably foreign (missing embedding, or
//     provider/model metadata that does not match the current space)
//   * records the current space in the store only AFTER a fully verified --apply
//
// Usage:
//   npm run embeddings:reindex                 # dry-run (report only)
//   npm run embeddings:reindex -- --apply      # write
//
// Stop the running server before --apply so its in-memory mirror is not stale.

const db = require("../lib/db");
const embeddings = require("../lib/embeddings");
const space = require("../lib/embeddings/space");

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
      "Usage: node scripts/backfill-embeddings.js [options]",
      "",
      "  --dry-run   report only; write nothing (default)",
      "  --apply     re-embed foreign/missing vectors and record the space",
      "",
      "Stop the server before using --apply.",
    ].join("\n")
  );
}

// Collect every searchable row, per container, from the data layer.
function collectRows() {
  const containers = new Set();
  for (const d of db.documents) containers.add(d.containerTag);
  for (const m of db.memories) containers.add(m.containerTag);

  const docs = [];
  const mems = [];
  const chunks = [];
  for (const tag of containers) {
    for (const d of db.listDocuments(tag)) {
      if (d.status === "failed") continue; // empty content, never ranked
      if (!d.content || !d.content.trim()) continue;
      docs.push({ kind: "document", row: d, text: d.content });
    }
    for (const m of db.listMemories(tag)) {
      if (!m.text || !m.text.trim()) continue;
      mems.push({ kind: "memory", row: m, text: m.text });
    }
    for (const c of db.listChunks(tag)) {
      if (!c.text || !c.text.trim()) continue;
      chunks.push({ kind: "chunk", row: c, text: c.text });
    }
  }
  return { docs, mems, chunks };
}

function countStale(rows, want) {
  return rows.filter(({ row }) => !space.matches(row, want)).length;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return void usage();

  const want = embeddings.describe();
  const recorded = typeof db.getMeta === "function" ? db.getMeta("embedding_space") : null;

  console.log(`[reindex] backend=${db.backend}`);
  console.log(`[reindex] provider=${want.provider} space=${want.space}`);
  console.log(`[reindex] recorded space=${recorded || "(none)"}`);

  if (want.provider === "tfidf") {
    console.log(
      `[reindex] provider "tfidf" is lexical — stored vectors are not used. Nothing to do.`
    );
    return;
  }

  const { docs, mems, chunks } = collectRows();
  const totals = { documents: docs.length, memories: mems.length, chunks: chunks.length };
  const stale = {
    documents: countStale(docs, want),
    memories: countStale(mems, want),
    chunks: countStale(chunks, want),
  };
  const grandTotal = totals.documents + totals.memories + totals.chunks;
  const grandStale = stale.documents + stale.memories + stale.chunks;

  console.log(
    `[reindex] documents total=${totals.documents} stale=${stale.documents}`
  );
  console.log(`[reindex] memories  total=${totals.memories} stale=${stale.memories}`);
  console.log(`[reindex] chunks    total=${totals.chunks} stale=${stale.chunks}`);

  if (!opts.apply) {
    console.log(
      `[reindex] DRY RUN — ${grandStale}/${grandTotal} rows would be re-embedded. No row data written.`
    );
    console.log(
      "[reindex] note: opening the store may initialize the database/schema if it does not exist."
    );
    return;
  }

  // Load the model before touching the store so a provider failure cannot leave
  // a half-updated corpus.
  await embeddings.getImpl();
  if (!embeddings.isDense()) {
    console.error("[reindex] provider became lexical during warmup — aborting without changes.");
    process.exitCode = 1;
    return;
  }

  const all = [...docs, ...mems, ...chunks];
  let updated = 0;
  let failed = 0;
  const failures = { document: 0, memory: 0, chunk: 0 };

  for (const { kind, row, text } of all) {
    if (space.matches(row, want)) continue;
    try {
      const vec = await embeddings.embed(text);
      if (!space.isUsableVector(vec)) throw new Error("empty or invalid vector");
      // A write that affects zero rows (e.g. the row vanished) is a FAILURE, not
      // a success: the store was not actually migrated for that row.
      const written = db.updateEmbedding(kind, row.id, vec);
      if (!written) throw new Error("update affected 0 rows");
      updated += 1;
    } catch (err) {
      failed += 1;
      failures[kind] += 1;
      // Never print text; the id + code is enough to investigate.
      console.warn(`[reindex] failed ${kind} id=${row.id} code=${err.code || "embed_failed"}`);
    }
  }

  // Re-verify from the store (fresh reads) BEFORE recording anything, so a
  // failed or incomplete reindex can never mark the store as fully migrated.
  const after = collectRows();
  const remaining = {
    documents: countStale(after.docs, want),
    memories: countStale(after.mems, want),
    chunks: countStale(after.chunks, want),
  };
  const remainingTotal = remaining.documents + remaining.memories + remaining.chunks;

  console.log(
    `[reindex] updated=${updated} failed=${failed} ` +
      `(documents=${failures.document} memories=${failures.memory} chunks=${failures.chunk})`
  );
  console.log(
    `[reindex] remaining stale: documents=${remaining.documents} memories=${remaining.memories} chunks=${remaining.chunks}`
  );

  if (failed === 0 && remainingTotal === 0) {
    db.setMeta("embedding_space", want.space);
    console.log(`[reindex] recorded space=${want.space}`);
    console.log("[reindex] VERIFIED: every stored vector matches the current space.");
  } else {
    console.error(
      `[reindex] VERIFICATION FAILED: ${remainingTotal} rows still stale` +
        (failed ? `, ${failed} updates failed` : "") +
        ". NOT recording the space so the next run retries them."
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch((err) => {
      console.error(`[reindex] ${err.message}`);
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

module.exports = { collectRows, countStale, main };

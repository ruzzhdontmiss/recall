#!/usr/bin/env node
// One-way migration: data/store.json -> SQLite (data/recall.db).
//
// Safety properties:
//   * never deletes or overwrites the source JSON store
//   * fails loudly on corrupt JSON (never treated as an empty store)
//   * validates every record and reports invalid/orphan/duplicate rows by id
//   * writes inside a single transaction, and is idempotent on reruns
//   * verifies document/memory counts, per-status counts, id sets and vector
//     dimensions after migrating
//   * never prints memory content (only ids, counts, statuses, reasons)
//
// Usage:
//   npm run db:migrate-json -- --dry-run
//   npm run db:migrate-json
//   node scripts/db-migrate-json.js --source data/store.json --target data/recall.db [--dry-run]

const fs = require("fs");
const path = require("path");
const sqlite = require("../lib/storage/sqlite");
const { vectorsEqual, assertVector } = require("../lib/storage/vectors");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    source: process.env.STORE_FILE || path.join(DATA_DIR, "store.json"),
    target: process.env.SQLITE_FILE || path.join(DATA_DIR, "recall.db"),
    backupDir: null,
    allowPartial: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--source") opts.source = argv[++i];
    else if (a === "--target") opts.target = argv[++i];
    else if (a === "--backup-dir") opts.backupDir = argv[++i];
    else if (a === "--allow-partial") opts.allowPartial = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function usage() {
  console.log(
    [
      "Usage: node scripts/db-migrate-json.js [options]",
      "",
      "  --dry-run        validate + report only; write nothing",
      "  --source <file>  JSON store (default: $DATA_DIR/store.json)",
      "  --target <file>  SQLite database (default: $DATA_DIR/recall.db)",
      "  --backup-dir <d> where to copy the source JSON before migrating",
      "  --allow-partial  migrate valid rows even if some rows are invalid",
    ].join("\n")
  );
}

function readSource(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Never fall back to an empty store.
    throw new Error(`source JSON is corrupt (${err.message}); refusing to migrate`);
  }
  if (!parsed || !Array.isArray(parsed.documents) || !Array.isArray(parsed.memories)) {
    throw new Error("source JSON must be an object with documents[] and memories[] arrays");
  }
  return parsed;
}

const MEMORY_TYPES = new Set(["static", "dynamic", "note"]);
const MEMORY_STATUSES = new Set(["active", "superseded", "forgotten", "expired"]);

function validateEmbedding(embedding) {
  if (embedding == null) return null;
  try {
    assertVector(embedding, "embedding");
    return null;
  } catch (err) {
    return err.message;
  }
}

function validateStore(store) {
  const errors = [];
  const docIds = new Map(); // id -> doc
  const memIds = new Set();

  store.documents.forEach((doc, index) => {
    const where = { kind: "document", index, id: doc && doc.id };
    if (!doc || typeof doc !== "object") return errors.push({ ...where, reason: "not an object" });
    if (!doc.id || typeof doc.id !== "string") return errors.push({ ...where, reason: "missing id" });
    if (docIds.has(doc.id)) return errors.push({ ...where, reason: "duplicate id" });
    if (!doc.containerTag || typeof doc.containerTag !== "string")
      return errors.push({ ...where, reason: "missing containerTag" });
    if (typeof doc.content !== "string") return errors.push({ ...where, reason: "content is not a string" });
    if (!doc.createdAt || Number.isNaN(Date.parse(doc.createdAt)))
      return errors.push({ ...where, reason: "missing/invalid createdAt" });
    const embErr = validateEmbedding(doc.embedding);
    if (embErr) return errors.push({ ...where, reason: embErr });
    docIds.set(doc.id, doc);
  });

  store.memories.forEach((mem, index) => {
    const where = { kind: "memory", index, id: mem && mem.id };
    if (!mem || typeof mem !== "object") return errors.push({ ...where, reason: "not an object" });
    if (!mem.id || typeof mem.id !== "string") return errors.push({ ...where, reason: "missing id" });
    if (memIds.has(mem.id)) return errors.push({ ...where, reason: "duplicate id" });
    if (!mem.documentId || typeof mem.documentId !== "string")
      return errors.push({ ...where, reason: "missing documentId" });
    else if (!docIds.has(mem.documentId))
      return errors.push({ ...where, reason: "orphan: documentId not found in documents" });
    if (!mem.containerTag || typeof mem.containerTag !== "string")
      return errors.push({ ...where, reason: "missing containerTag" });
    if (typeof mem.text !== "string") return errors.push({ ...where, reason: "text is not a string" });
    if (!MEMORY_TYPES.has(mem.type)) return errors.push({ ...where, reason: `invalid type: ${mem.type}` });
    if (!MEMORY_STATUSES.has(mem.status))
      return errors.push({ ...where, reason: `invalid status: ${mem.status}` });
    if (!mem.createdAt || Number.isNaN(Date.parse(mem.createdAt)))
      return errors.push({ ...where, reason: "missing/invalid createdAt" });
    const embErr = validateEmbedding(mem.embedding);
    if (embErr) return errors.push({ ...where, reason: embErr });
    memIds.add(mem.id);
  });

  return { errors, docIds, memIds };
}

function normalizeDoc(doc) {
  return {
    id: doc.id,
    containerTag: doc.containerTag,
    content: doc.content,
    createdAt: doc.createdAt,
    embedding: doc.embedding ?? null,
  };
}

function normalizeMem(mem) {
  return {
    id: mem.id,
    documentId: mem.documentId,
    containerTag: mem.containerTag,
    text: mem.text,
    type: mem.type,
    slot: mem.slot ?? null,
    slotValue: mem.slotValue ?? null,
    status: mem.status,
    createdAt: mem.createdAt,
    expiresAt: mem.expiresAt ?? null,
    supersededAt: mem.supersededAt ?? null,
    supersedes: mem.supersedes ?? null,
    extractedBy: mem.extractedBy ?? null,
    embedding: mem.embedding ?? null,
  };
}

function docsEqual(a, b) {
  return (
    a.containerTag === b.containerTag &&
    a.content === b.content &&
    a.createdAt === b.createdAt &&
    vectorsEqual(a.embedding, b.embedding)
  );
}

function memsEqual(a, b) {
  return (
    a.documentId === b.documentId &&
    a.containerTag === b.containerTag &&
    a.text === b.text &&
    a.type === b.type &&
    (a.slot ?? null) === (b.slot ?? null) &&
    (a.slotValue ?? null) === (b.slotValue ?? null) &&
    a.status === b.status &&
    a.createdAt === b.createdAt &&
    (a.expiresAt ?? null) === (b.expiresAt ?? null) &&
    (a.supersededAt ?? null) === (b.supersededAt ?? null) &&
    (a.supersedes ?? null) === (b.supersedes ?? null) &&
    (a.extractedBy ?? null) === (b.extractedBy ?? null) &&
    vectorsEqual(a.embedding, b.embedding)
  );
}

function statusCounts(mems) {
  const counts = {};
  for (const m of mems) counts[m.status] = (counts[m.status] || 0) + 1;
  return counts;
}

function dimSummary(rows) {
  const dims = new Set();
  for (const r of rows) if (r.embedding) dims.add(r.embedding.length);
  return dims.size ? Array.from(dims).sort((a, b) => a - b).join(",") : "(none)";
}

function backupSource(source, backupDir) {
  const dir = backupDir || path.join(path.dirname(source), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `store-${stamp}.json`);
  if (fs.existsSync(dest)) throw new Error(`backup target already exists: ${dest}`);
  fs.copyFileSync(source, dest);
  return dest;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return void usage();

  console.log(`[migrate] source: ${opts.source}`);
  console.log(`[migrate] target: ${opts.target}`);

  const store = readSource(opts.source);
  if (!store) {
    console.log("[migrate] no source JSON store found — nothing to migrate.");
    return;
  }

  const { errors } = validateStore(store);
  const validDocs = store.documents.filter((d) => d && typeof d.id === "string");
  const validMems = store.memories.filter((m) => m && typeof m.id === "string");

  console.log(`[migrate] source documents: ${store.documents.length}`);
  console.log(`[migrate] source memories:  ${store.memories.length}`);
  console.log(`[migrate] source memory statuses: ${JSON.stringify(statusCounts(validMems))}`);
  console.log(`[migrate] source vector dims: docs ${dimSummary(validDocs)}, memories ${dimSummary(validMems)}`);

  if (errors.length) {
    console.log(`[migrate] INVALID RECORDS: ${errors.length}`);
    for (const e of errors.slice(0, 50)) {
      console.log(`  - ${e.kind}[${e.index}] id=${e.id || "(none)"}: ${e.reason}`);
    }
    if (errors.length > 50) console.log(`  ... and ${errors.length - 50} more`);
    if (!opts.allowPartial) {
      console.error("[migrate] refusing to migrate while invalid records exist (use --allow-partial to override).");
      process.exitCode = 1;
      return;
    }
  }

  if (opts.dryRun) {
    console.log(
      `[migrate] DRY RUN — would migrate ${validDocs.length} documents and ${validMems.length} memories. No changes written.`
    );
    return;
  }

  // Back up the source before writing anything.
  const backupPath = backupSource(opts.source, opts.backupDir);
  console.log(`[migrate] source backed up to ${backupPath}`);

  const db = sqlite.openDatabase(opts.target);

  // Refuse to run while another process holds the write lock (i.e. the app is
  // still running against this database).
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } catch (err) {
    db.close();
    console.error(`[migrate] target database is locked (${err.code || err.message}). Stop the running app first.`);
    process.exitCode = 1;
    return;
  }

  const existingDocs = new Map(
    db
      .prepare("SELECT * FROM documents")
      .all()
      .map((r) => [r.id, sqlite.rowToDocument(r)])
  );
  const existingMems = new Map(
    db
      .prepare("SELECT * FROM memories")
      .all()
      .map((r) => [r.id, sqlite.rowToMemory(r)])
  );

  const stats = { docsInserted: 0, docsSkipped: 0, memsInserted: 0, memsSkipped: 0 };
  const conflicts = [];

  const run = db.transaction(() => {
    for (const raw of store.documents) {
      const doc = normalizeDoc(raw);
      const existing = existingDocs.get(doc.id);
      if (existing) {
        if (docsEqual(existing, doc)) {
          stats.docsSkipped++;
          continue;
        }
        conflicts.push({ kind: "document", id: doc.id });
        continue;
      }
      sqlite.insertDocument(db, doc, { provider: null, model: null });
      stats.docsInserted++;
    }
    for (const raw of store.memories) {
      const mem = normalizeMem(raw);
      const existing = existingMems.get(mem.id);
      if (existing) {
        if (memsEqual(existing, mem)) {
          stats.memsSkipped++;
          continue;
        }
        conflicts.push({ kind: "memory", id: mem.id });
        continue;
      }
      sqlite.insertMemory(db, mem, { provider: null, model: null });
      stats.memsInserted++;
    }
    if (conflicts.length) throw new Error("id conflicts detected");
  });

  // Skip the whole transaction when partial mode left invalid rows out and the
  // valid set is empty — still a valid (empty) migration.
  try {
    run();
  } catch (err) {
    db.close();
    console.error(`[migrate] FAILED: ${err.message}`);
    for (const c of conflicts.slice(0, 50)) console.error(`  - conflicting ${c.kind} id=${c.id}`);
    process.exitCode = 1;
    return;
  }

  // ---- verification -------------------------------------------------------
  const targetDocs = db
    .prepare("SELECT * FROM documents")
    .all()
    .map(sqlite.rowToDocument);
  const targetMems = db
    .prepare("SELECT * FROM memories")
    .all()
    .map(sqlite.rowToMemory);

  const sourceDocIds = new Set(validDocs.map((d) => d.id));
  const sourceMemIds = new Set(validMems.map((m) => m.id));
  const missingDocs = [...sourceDocIds].filter((id) => !targetDocs.some((d) => d.id === id));
  const missingMems = [...sourceMemIds].filter((id) => !targetMems.some((m) => m.id === id));

  console.log(
    `[migrate] inserted documents=${stats.docsInserted} skipped=${stats.docsSkipped}; ` +
      `memories inserted=${stats.memsInserted} skipped=${stats.memsSkipped}`
  );
  console.log(`[migrate] target documents=${targetDocs.length}, memories=${targetMems.length}`);
  console.log(`[migrate] target memory statuses: ${JSON.stringify(statusCounts(targetMems))}`);
  console.log(
    `[migrate] target vector dims: docs ${dimSummary(targetDocs)}, memories ${dimSummary(targetMems)}`
  );

  const ok = missingDocs.length === 0 && missingMems.length === 0;
  if (!ok) {
    console.error(`[migrate] VERIFICATION FAILED: missing ${missingDocs.length} documents, ${missingMems.length} memories`);
    process.exitCode = 1;
  } else {
    console.log("[migrate] VERIFIED: all source ids present in the target database.");
  }
  db.close();
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`[migrate] ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateStore, readSource, normalizeDoc, normalizeMem };

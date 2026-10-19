#!/usr/bin/env node
// Reconcile the document records with the uploaded files on local disk.
//
//   - reports files no record references (orphans) and records whose file is
//     missing;
//   - deletes orphaned files only with an explicit --apply;
//   - never modifies records, chunks or provenance;
//   - skips files newer than a grace period so a concurrent upload is never
//     mistaken for an orphan.
//
// Dry-run by default. Repeated runs are idempotent (a second run finds nothing
// left to remove). Run with the server stopped for the most accurate result.
//
// Usage:
//   npm run storage:reconcile                 # dry-run report
//   npm run storage:reconcile -- --apply      # delete orphaned files
//   npm run storage:reconcile -- --json       # machine-readable report

const db = require("../lib/db");
const storage = require("../lib/documents/storage");
const { reconcileStorage, DEFAULT_GRACE_MS } = require("../lib/documents/reconcile");

function parseArgs(argv) {
  const opts = { apply: false, json: false, help: false, graceMs: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--dry-run") opts.apply = false;
    else if (a === "--json") opts.json = true;
    else if (a === "--grace-ms") {
      const value = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(value) || value < 0) throw new Error("--grace-ms requires a non-negative number");
      opts.graceMs = value;
    } else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function usage() {
  console.log(
    [
      "Usage: node scripts/reconcile-storage.js [options]",
      "",
      "  --dry-run        report only; delete nothing (default)",
      "  --apply          delete files no document record references",
      "  --grace-ms <n>   treat files newer than n ms as possibly in flight",
      "                   (default 3600000 = 1 hour, or STORAGE_RECONCILE_GRACE_MS)",
      "  --json           print the report as JSON",
    ].join("\n")
  );
}

function printReport(report) {
  const { documents, files } = report;
  console.log(`[reconcile] backend=${report.backend} apply=${report.apply} graceMs=${report.graceMs}`);
  console.log(
    `[reconcile] documents=${documents.total} withFile=${documents.withFile} withoutFile=${documents.withoutFile}`
  );
  console.log(
    `[reconcile] files=${files.total} referenced=${files.referenced} orphans=${files.orphans} ` +
      `recent=${files.recent} unresolved=${files.unresolved}`
  );

  if (report.dirUnreadable) {
    console.error(
      `[reconcile] cannot read the upload directory (code=${report.dirUnreadable}); nothing was changed.`
    );
  }
  if (report.missing.length) {
    console.log(`[reconcile] records with a missing file: ${report.missing.length}`);
    for (const m of report.missing) console.log(`  - document ${m.documentId}`);
  }
  if (report.unreadableRecords.length) {
    console.log(`[reconcile] records whose file could not be verified: ${report.unreadableRecords.length}`);
    for (const m of report.unreadableRecords) {
      console.log(`  - document ${m.documentId} (code=${m.code})`);
    }
  }
  if (report.unresolved.length) {
    console.log(`[reconcile] files skipped after a filesystem error: ${report.unresolved.length}`);
    for (const u of report.unresolved) console.log(`  - ${u.name} (code=${u.code})`);
  }
  if (report.recent.length) {
    console.log(`[reconcile] recent files kept (within the grace period): ${report.recent.length}`);
  }

  if (!report.apply) {
    if (report.orphans.length) {
      console.log(`[reconcile] orphan files that would be deleted: ${report.orphans.length}`);
      for (const o of report.orphans) console.log(`  - ${o.name} (${o.size} bytes, age ${o.ageMs}ms)`);
      console.log("[reconcile] DRY RUN — re-run with --apply to delete these files.");
    } else {
      console.log("[reconcile] DRY RUN — no orphan files to delete.");
    }
    return;
  }

  console.log(`[reconcile] removed=${report.removed.length} failed=${report.failedRemovals.length}`);
  for (const f of report.failedRemovals) console.log(`  - ${f.name} (code=${f.code})`);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return void usage();

  const envGrace = Number.parseInt(process.env.STORAGE_RECONCILE_GRACE_MS, 10);
  const graceMs =
    opts.graceMs !== undefined
      ? opts.graceMs
      : Number.isFinite(envGrace)
        ? envGrace
        : DEFAULT_GRACE_MS;

  const report = reconcileStorage({ db, storage, apply: opts.apply, graceMs });

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);

  // A partial failure or an unverifiable run must surface as a non-zero exit.
  if (report.failedRemovals.length || report.dirUnreadable) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch((err) => {
      console.error(`[reconcile] ${err.message}`);
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

module.exports = { main, parseArgs };

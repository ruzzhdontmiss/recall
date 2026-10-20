#!/usr/bin/env node
// Retrieval-quality evaluation for realistic memory workflows.
//
//   npm run eval:memory                 # dense (default provider)
//   EMBEDDINGS_PROVIDER=tfidf npm run eval:memory
//   node scripts/eval-memory.js --strict
//
// The dataset lives in scripts/fixtures/memory-eval.json. It is ingested through
// the real HTTP API into a throwaway DATA_DIR, then queried through /v1/search.
// No live model API is required: the local ONNX provider or the lexical
// fallback is used, and the response's own `ranking` field is reported.
//
// Metrics: top-1 accuracy and Recall@5 over answerable questions, plus:
//   * stale hits        — a superseded/obsolete value still returned
//   * missing-source    — the expected fact never made it into the corpus
//   * ranking           — the fact is in the corpus but ranked outside the cut
//   * no-answer probes  — top-1 similarity for questions with no relevant fact
//   * provenance        — document hits carry filename/chunk attribution
//   * hygiene           — no vectors, keys or filesystem paths in responses
//
// `--strict` fails the process when the measured metrics fall below the
// thresholds in the fixture, or when any stale hit is observed.

const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const dataset = require("./fixtures/memory-eval.json");
const strict = process.argv.includes("--strict");

const ownDir = !process.env.MEMORY_EVAL_DATA_DIR;
const dataDir =
  process.env.MEMORY_EVAL_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "recall-mem-eval-"));

process.env.DATA_DIR = dataDir;
process.env.EXTRACTION_PROVIDER = process.env.EXTRACTION_PROVIDER || "regex";
process.env.AUTH_MODE = "required";
// The evaluation issues many requests in a few seconds; do not trip the
// production rate limits. Authentication remains enforced.
process.env.RATE_LIMIT_PER_MIN = "100000";
process.env.RATE_LIMIT_EXPENSIVE_PER_MIN = "100000";

const { app, issueApiKey } = require(path.join(REPO, "server.js"));
const db = require(path.join(REPO, "lib/db.js"));

const ALLOWED_RESULT_KEYS = new Set([
  "source",
  "id",
  "score",
  "text",
  "createdAt",
  "memoryType",
  "documentId",
  "chunkIndex",
  "page",
  "filename",
  "mediaType",
]);

function lower(value) {
  return String(value || "").toLowerCase();
}

function pct(n, d) {
  if (!d) return "n/a";
  return `${((100 * n) / d).toFixed(1)}%`;
}

function matchesAll(text, needles) {
  const hay = lower(text);
  return needles.every((n) => hay.includes(lower(n)));
}

// Count only regular files: the upload directory also contains a `tmp/`
// subdirectory used for atomic writes.
function storedFileCount(dir) {
  const uploads = process.env.UPLOAD_DIR || path.join(dir, "uploads");
  if (!fs.existsSync(uploads)) return 0;
  return fs
    .readdirSync(uploads)
    .filter((name) => fs.statSync(path.join(uploads, name)).isFile()).length;
}

async function main() {
  const { key } = issueApiKey(db, { tenantId: "eval", containerTag: dataset.containerTag });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${key}` };

  const results = {
    httpErrors: [],
    hygiene: [],
    ingestion: [],
    questions: [],
    noAnswer: [],
    deletion: [],
  };
  const provider = (process.env.EMBEDDINGS_PROVIDER || "xenova").toLowerCase();

  async function request(method, endpoint, { body, headers = {} } = {}) {
    const res = await fetch(base + endpoint, {
      method,
      headers: { ...auth, ...headers },
      body,
    });
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* keep raw for diagnostics */
    }
    if (raw.includes(key) || raw.includes(dataDir) || /"(embedding|apiKey)"/.test(raw)) {
      results.hygiene.push(`${method} ${endpoint}: response contains a key, path or vector field`);
    }
    return { status: res.status, body: json, raw };
  }

  // ---------------------------------------------------------------- ingest --
  for (const fact of dataset.facts) {
    const r = await request("POST", "/v1/add", {
      body: JSON.stringify({ content: fact.content }),
      headers: { "content-type": "application/json" },
    });
    if (r.status !== 200) {
      results.httpErrors.push(`add ${fact.id}: HTTP ${r.status} ${r.raw.slice(0, 120)}`);
      results.ingestion.push({ id: fact.id, ok: false, reason: `HTTP ${r.status}` });
      continue;
    }
    if (!r.body.memories || r.body.memories.length === 0) {
      results.ingestion.push({ id: fact.id, ok: false, reason: "no memories extracted" });
    }
  }

  const documentIds = new Map();
  for (const doc of dataset.documents) {
    const r = await request(
      "POST",
      `/v1/documents/upload?containerTag=${encodeURIComponent(dataset.containerTag)}`,
      {
        body: doc.content,
        headers: {
          "content-type": doc.mediaType,
          "x-recall-filename": doc.filename,
        },
      }
    );
    if (r.status !== 201) {
      results.httpErrors.push(`upload ${doc.id}: HTTP ${r.status} ${r.raw.slice(0, 120)}`);
      continue;
    }
    documentIds.set(doc.id, r.body.document.id);
  }

  // Active corpus + chunk provenance, used to classify failures.
  const memRes = await request("GET", "/v1/memories");
  const activeMemories = (memRes.body.memories || [])
    .filter((m) => m.effectiveStatus === "active")
    .map((m) => m.text);
  const allMemories = memRes.body.memories || [];

  const chunkText = [];
  const chunkIndexes = [];
  for (const [docKey, docId] of documentIds) {
    const detail = await request("GET", `/v1/documents/${docId}`);
    for (const c of detail.body.chunks || []) {
      chunkText.push(c.text);
      chunkIndexes.push(c.chunkIndex);
    }
    const uploaded = detail.body.document;
    if (!uploaded || uploaded.status !== "ready") {
      results.ingestion.push({ id: docKey, ok: false, reason: "document not ready" });
    }
  }

  // -------------------------------------------------------------- questions --
  const rankingModes = new Set();
  for (const q of dataset.questions) {
    const r = await request(
      "GET",
      `/v1/search?searchMode=${encodeURIComponent(q.mode)}&q=${encodeURIComponent(q.q)}`
    );
    if (r.status !== 200) {
      results.httpErrors.push(`search ${q.id}: HTTP ${r.status} ${r.raw.slice(0, 120)}`);
      continue;
    }
    rankingModes.add(r.body.ranking);
    const hits = r.body.results || [];
    for (const hit of hits) {
      for (const k of Object.keys(hit)) {
        if (!ALLOWED_RESULT_KEYS.has(k)) results.hygiene.push(`${q.id}: unexpected field ${k}`);
      }
    }

    if (q.noAnswer) {
      results.noAnswer.push({
        id: q.id,
        q: q.q,
        topScore: hits[0] ? hits[0].score : 0,
        topText: hits[0] ? hits[0].text : null,
      });
      continue;
    }

    const matches = (hit) => matchesAll(hit.text, q.expect);
    const rank = hits.findIndex(matches);
    const top1 = rank === 0;
    const recalled = rank >= 0 && rank < 5;
    const staleHits = q.forbid
      ? hits.filter((h) => q.forbid.some((f) => lower(h.text).includes(lower(f))))
      : [];

    const corpus = q.mode === "documents" ? chunkText : activeMemories;
    const inCorpus = corpus.some((t) => matchesAll(t, q.expect));

    let provenance = null;
    if (q.provenance && rank >= 0) {
      const hit = hits[rank];
      provenance =
        hit.source === "chunk" &&
        hit.filename === q.provenance.filename &&
        typeof hit.chunkIndex === "number" &&
        Boolean(hit.documentId);
      if (!provenance) {
        results.hygiene.push(`${q.id}: expected chunk provenance, got ${JSON.stringify(hit)}`);
      }
    }

    let reason = null;
    if (!inCorpus) reason = "missing-source";
    else if (staleHits.length) reason = "stale";
    else if (!recalled) reason = "ranking (outside top 5)";
    else if (!top1) reason = `ranking (rank ${rank + 1})`;

    results.questions.push({
      id: q.id,
      category: q.category,
      q: q.q,
      top1,
      recalled,
      rank,
      inCorpus,
      provenance,
      stale: staleHits.map((h) => h.text),
      reason,
      topScore: hits[0] ? hits[0].score : 0,
      topText: hits[0] ? hits[0].text : null,
      ranking: r.body.ranking,
    });
  }

  // --------------------------------------------------------------- deletion --
  for (const docKey of dataset.deletion ? [dataset.deletion.document] : []) {
    const docId = documentIds.get(docKey);
    if (!docId) continue;
    const before = storedFileCount(dataDir);
    const del = await request("DELETE", `/v1/documents/${docId}?containerTag=${dataset.containerTag}`);
    if (del.status !== 200) {
      results.httpErrors.push(`delete ${docKey}: HTTP ${del.status}`);
      continue;
    }
    const detail = await request("GET", `/v1/documents/${docId}`);
    const after = storedFileCount(dataDir);
    for (const qid of dataset.deletion.questions || []) {
      const q = dataset.questions.find((x) => x.id === qid);
      const r = await request(
        "GET",
        `/v1/search?searchMode=${q.mode}&q=${encodeURIComponent(q.q)}`
      );
      const hits = r.body.results || [];
      const stillThere = hits.some((h) => h.documentId === docId || matchesAll(h.text, q.expect));
      results.deletion.push({
        id: qid,
        detailStatus: detail.status,
        stillThere,
        fileRemoved: after === before - 1,
        fileCountBefore: before,
        fileCountAfter: after,
      });
    }
  }

  // ----------------------------------------------------------------- report --
  const answerable = results.questions;
  const top1 = answerable.filter((q) => q.top1).length;
  const recall5 = answerable.filter((q) => q.recalled).length;
  const stale = answerable.filter((q) => q.stale.length).length;
  const missing = answerable.filter((q) => q.reason === "missing-source").length;
  const rankingMisses = answerable.filter((q) => q.reason && q.reason.startsWith("ranking")).length;
  const provenanceFails = answerable.filter((q) => q.provenance === false).length;

  console.log(`\nRecall retrieval evaluation — ${dataset.name} v${dataset.version}`);
  console.log(`provider: ${provider}   ranking modes seen: ${[...rankingModes].join(", ") || "(none)"}`);
  console.log(
    `corpus: ${activeMemories.length} active memories, ${chunkText.length} chunks in ${documentIds.size} document(s)`
  );
  console.log(
    `questions: ${dataset.questions.length} total, ${answerable.length} answerable, ${results.noAnswer.length} no-answer`
  );
  console.log("");
  console.log(`Top-1 accuracy: ${top1}/${answerable.length} (${pct(top1, answerable.length)})`);
  console.log(`Recall@5:       ${recall5}/${answerable.length} (${pct(recall5, answerable.length)})`);
  console.log(`stale hits: ${stale}   missing-source: ${missing}   ranking misses: ${rankingMisses}`);
  if (provenanceFails) console.log(`provenance failures: ${provenanceFails}`);
  if (results.hygiene.length) console.log(`hygiene violations: ${results.hygiene.length}`);

  const failures = answerable.filter((q) => !q.top1 || q.stale.length || q.provenance === false);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) {
      console.log(`  [${f.category}] ${f.id}: ${JSON.stringify(f.q)}`);
      console.log(`      top1=${JSON.stringify(f.topText)}`);
      console.log(`      reason=${f.reason || "top-1 mismatch"}${f.stale.length ? ` stale=${JSON.stringify(f.stale)}` : ""}`);
    }
  }

  if (results.noAnswer.length) {
    console.log("\nno-answer probes (no relevant fact exists):");
    for (const n of results.noAnswer) {
      console.log(`  ${n.topScore.toFixed(4)}  ${JSON.stringify(n.q)} -> ${JSON.stringify(n.topText)}`);
    }
    // Empirical relevance floor: the lowest top-1 score among CORRECT answers.
    // A no-answer probe at or above that score is indistinguishable from a real
    // match, which is a concrete ranking/UX signal rather than a guess.
    const correct = answerable.filter((q) => q.top1);
    if (correct.length) {
      const floor = Math.min(...correct.map((q) => q.topScore));
      const misleading = results.noAnswer.filter((n) => n.topScore >= floor);
      console.log(
        `  empirical floor (lowest correct top-1): ${floor.toFixed(4)}; ` +
          `${misleading.length}/${results.noAnswer.length} no-answer probe(s) at or above it`
      );
    }
  }

  if (results.deletion.length) {
    console.log("\ndeletion:");
    for (const d of results.deletion) {
      console.log(
        `  ${d.id}: detail=${d.detailStatus} stillRetrievable=${d.stillThere} fileRemoved=${d.fileRemoved}`
      );
    }
  }

  if (results.ingestion.length) {
    console.log("\ningestion problems:");
    for (const i of results.ingestion) console.log(`  ${i.id}: ${i.reason}`);
  }
  if (results.httpErrors.length) {
    console.log("\nHTTP errors:");
    for (const e of results.httpErrors) console.log(`  ${e}`);
  }
  if (results.hygiene.length) {
    console.log("\nhygiene:");
    for (const h of results.hygiene) console.log(`  ${h}`);
  }

  const thresholds = dataset.thresholds || {};
  const belowThreshold =
    (thresholds.top1 !== undefined && top1 / answerable.length < thresholds.top1) ||
    (thresholds.recall5 !== undefined && recall5 / answerable.length < thresholds.recall5);
  const deletionOk = results.deletion.every((d) => d.detailStatus === 404 && !d.stillThere && d.fileRemoved);

  if (strict) {
    const problems = [];
    if (belowThreshold) problems.push("retrieval metrics below the fixture thresholds");
    if (stale > (thresholds.stale || 0)) problems.push(`${stale} stale hit(s)`);
    if (provenanceFails) problems.push(`${provenanceFails} provenance failure(s)`);
    if (results.hygiene.length) problems.push(`${results.hygiene.length} hygiene violation(s)`);
    if (results.httpErrors.length) problems.push(`${results.httpErrors.length} HTTP error(s)`);
    if (results.ingestion.length) problems.push(`${results.ingestion.length} ingestion problem(s)`);
    if (!deletionOk) problems.push("document deletion did not fully remove data");
    if (problems.length) {
      console.error(`\nSTRICT FAIL: ${problems.join("; ")}`);
      process.exitCode = 1;
    } else {
      console.log("\nSTRICT PASS");
    }
  }

  server.close();
  db.close();
  if (ownDir) fs.rmSync(dataDir, { recursive: true, force: true });
  else console.log(`\n(kept data dir: ${dataDir})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

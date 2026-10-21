#!/usr/bin/env node
// Private smoke test: exercises a RUNNING instance end to end over HTTP.
//
// Unlike the unit/integration suite (which drives the app in-process), this
// talks to a real server — a local `npm start`, or the container — so it catches
// deployment-level problems: a bad bind, a missing key, a proxy that strips the
// Authorization header, a volume that is not writable.
//
// Usage:
//   RECALL_URL=http://127.0.0.1:6767 RECALL_KEY=sm_... node scripts/smoke.js
//   node scripts/smoke.js --url http://127.0.0.1:6767 --key sm_...
//
// Against an instance running with AUTH_MODE=dev no key is needed and HTTP is
// unauthenticated. Everything this script creates is deleted again at the end.

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE = (arg("url", process.env.RECALL_URL) || "http://127.0.0.1:6767").replace(/\/$/, "");
const KEY = arg("key", process.env.RECALL_KEY) || "";

let failures = 0;
let step = 0;

function ok(name, detail = "") {
  step += 1;
  console.log(`PASS  ${String(step).padStart(2)}. ${name}${detail ? `  (${detail})` : ""}`);
}

function fail(name, detail) {
  step += 1;
  failures += 1;
  console.error(`FAIL  ${String(step).padStart(2)}. ${name}  ${detail || ""}`);
}

function check(name, condition, detail) {
  if (condition) ok(name, detail);
  else fail(name, detail || "assertion failed");
}

async function request(method, path, { body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (KEY) h.Authorization = `Bearer ${KEY}`;
  const res = await fetch(BASE + path, { method, headers: h, body });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. an HTML error page) — kept as text for diagnostics */
  }
  return { status: res.status, headers: res.headers, json, text, raw };
}

async function main() {
  console.log(`Recall smoke test against ${BASE}${KEY ? " (scoped key)" : " (no key)"}\n`);

  // ---- liveness + readiness ------------------------------------------------
  const health = await request("GET", "/healthz");
  check("GET /healthz is 200", health.status === 200, `status=${health.status}`);
  check("liveness reports a version", health.json && typeof health.json.version === "string");

  const ready = await request("GET", "/readyz");
  check("GET /readyz is 200", ready.status === 200, `status=${ready.status}`);
  check("readiness reports database ok", ready.json?.dependencies?.database?.ok === true);
  check("readiness reports storage ok", ready.json?.dependencies?.storage?.ok === true);
  const backend = ready.json?.dependencies?.database?.backend;
  const provider = ready.json?.dependencies?.embeddings?.provider;
  const dense = ready.json?.dependencies?.embeddings?.dense;
  console.log(`      backend=${backend} embeddings=${provider} dense=${dense} ranking-status=${ready.json?.status}`);

  // ---- identity ------------------------------------------------------------
  const who = await request("GET", "/v1/whoami");
  check("GET /v1/whoami authenticates", who.status === 200, `status=${who.status}`);

  // ---- ingest + search (the core loop) -------------------------------------
  const token = `smoketest-${Date.now()}`;
  const addRes = await request("POST", "/v1/add", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: `The ${token} deployment is verified end to end.` }),
  });
  check("POST /v1/add ingests content", addRes.status === 200, `status=${addRes.status}`);
  const docId = addRes.json?.document?.id;
  const createdMemories = (addRes.json?.memories || []).map((m) => m.id);
  check("ingest returns a document id", !!docId);

  const search = await request("GET", `/v1/search?q=${encodeURIComponent(token)}`);
  check("GET /v1/search ranks a result", search.status === 200 && (search.json?.results || []).length > 0,
    `status=${search.status} results=${(search.json?.results || []).length}`);
  check("search reports an honest ranking field", ["dense", "hybrid", "lexical", "none"].includes(search.json?.ranking),
    `ranking=${search.json?.ranking}`);
  // A response must never present a lexical fallback as semantic/hybrid search.
  check("search does not claim semantic ranking for a lexical provider",
    !(["dense", "hybrid"].includes(search.json?.ranking) && search.json?.embeddingsProvider === "tfidf"));

  const profile = await request("GET", `/v1/profile?q=${encodeURIComponent(token)}`);
  check("GET /v1/profile responds", profile.status === 200, `status=${profile.status}`);

  // ---- document upload + attribution + delete -------------------------------
  const docText = `Uploaded smoke document. Unique phrase: ${token}-doc.`;
  const upload = await request("POST", "/v1/documents/upload", {
    headers: { "Content-Type": "text/plain", "X-Recall-Filename": "smoke.txt" },
    body: docText,
  });
  check("POST /v1/documents/upload accepts a text file", upload.status === 201 || upload.status === 200,
    `status=${upload.status}`);
  const uploadedId = upload.json?.document?.id;
  check("upload returns a document id", !!uploadedId);
  check("upload reports chunks", (upload.json?.chunkCount || 0) >= 1, `chunks=${upload.json?.chunkCount}`);

  const docSearch = await request("GET", `/v1/search?q=${encodeURIComponent(`${token}-doc`)}&searchMode=documents`);
  const docHit = (docSearch.json?.results || []).find((r) => r.documentId === uploadedId || r.id === uploadedId);
  check("uploaded document is retrievable with attribution", !!docHit,
    `status=${docSearch.status} results=${(docSearch.json?.results || []).length}`);

  const dup = await request("POST", "/v1/documents/upload", {
    headers: { "Content-Type": "text/plain", "X-Recall-Filename": "smoke.txt" },
    body: docText,
  });
  check("re-uploading identical bytes deduplicates", dup.status === 200 && dup.json?.duplicate === true,
    `status=${dup.status} duplicate=${dup.json?.duplicate}`);

  // ---- cleanup (and prove deletion actually removes it) ---------------------
  const delDoc = await request("DELETE", `/v1/documents/${uploadedId}`);
  check("DELETE /v1/documents/:id succeeds", delDoc.status === 200, `status=${delDoc.status}`);
  const afterDoc = await request("GET", `/v1/search?q=${encodeURIComponent(`${token}-doc`)}&searchMode=documents`);
  const stillThere = (afterDoc.json?.results || []).some((r) => r.documentId === uploadedId || r.id === uploadedId);
  check("deleted document is gone from search", !stillThere);

  for (const id of createdMemories) {
    await request("DELETE", `/v1/memories/${id}`);
  }
  if (docId) await request("DELETE", `/v1/documents/${docId}`);
  ok("cleanup completed", `removed ${createdMemories.length} memories`);

  console.log("");
  if (failures === 0) {
    console.log(`PASS: smoke test succeeded (${step} checks)`);
    process.exit(0);
  }
  console.error(`FAIL: smoke test failed (${failures} of ${step} checks)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`FAIL: smoke test crashed: ${(err && err.message) || err}`);
  process.exit(1);
});

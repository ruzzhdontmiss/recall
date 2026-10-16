const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { mkTmp, rm } = require("./_support");

// Configure an isolated, deterministic environment BEFORE requiring the app.
// Lexical embeddings + regex extraction keep the API tests fast and offline.
const DIR = mkTmp();
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";

const { app } = require("../server");
const db = require("../lib/db");
const { issueApiKey } = require("../lib/auth");

let server;
let base;
let KEY;

before(async () => {
  // A single tenant owns every container used in this file; the key is bound to
  // container "api_a". Cross-tenant isolation is covered in test/auth.test.js.
  ({ key: KEY } = issueApiKey(db, { tenantId: "api", containerTag: "api_a" }));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rm(DIR);
});

async function json(pathname, opts = {}) {
  const headers = { Authorization: `Bearer ${KEY}`, ...(opts.headers || {}) };
  const res = await fetch(base + pathname, { ...opts, headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function postAdd(content, containerTag) {
  return json("/v1/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, containerTag }),
  });
}

test("add extracts memories and returns the documented shape", async () => {
  const { status, body } = await postAdd("I am a backend engineer. I live in Berlin.", "api_a");
  assert.equal(status, 200);
  assert.ok(body.document.id);
  assert.equal(body.document.containerTag, "api_a");
  assert.ok(body.memoriesExtracted >= 2);
  assert.ok(Array.isArray(body.memories));
  assert.equal(body.extractionProvider, "regex");
});

test("profile, memories and documents are scoped to the container", async () => {
  await postAdd("I prefer Rust over Go.", "api_b");
  const profile = await json("/v1/profile?containerTag=api_b");
  assert.equal(profile.status, 200);
  assert.ok(profile.body.profile.static.length >= 1);

  const memories = await json("/v1/memories?containerTag=api_b");
  assert.ok(memories.body.memories.every((m) => m.containerTag === "api_b"));

  const docs = await json("/v1/documents?containerTag=api_b");
  assert.ok(docs.body.documents.every((d) => d.containerTag === "api_b"));

  // A container the tenant has never written to is not owned yet -> denied
  // (never silently auto-created on a read).
  const other = await json("/v1/profile?containerTag=api_does_not_exist");
  assert.equal(other.status, 403);
});

test("contradiction supersedes the previous fact", async () => {
  await postAdd("I live in Berlin.", "api_c");
  await postAdd("I now live in Lisbon instead.", "api_c");
  const { body } = await json("/v1/profile?containerTag=api_c");
  const texts = body.profile.static.map((f) => f.text.toLowerCase());
  assert.ok(texts.some((t) => t.includes("lisbon")));
  assert.ok(!texts.some((t) => t.includes("berlin")), "Berlin must be superseded");

  const all = await json("/v1/memories?containerTag=api_c");
  assert.ok(all.body.memories.some((m) => m.effectiveStatus === "superseded"));
});

test("search supports all three modes", async () => {
  await postAdd("I am a backend engineer who uses Neovim.", "api_d");
  for (const mode of ["hybrid", "memories", "documents"]) {
    const { status, body } = await json(`/v1/search?q=backend+engineer&containerTag=api_d&searchMode=${mode}`);
    assert.equal(status, 200);
    assert.equal(body.searchMode, mode);
    assert.ok(Array.isArray(body.results));
  }
});

test("cross-container deletion is blocked (IDOR regression)", async () => {
  await postAdd("I live in Berlin.", "victim");
  const victimMem = (await json("/v1/memories?containerTag=victim")).body.memories[0];

  // Claim a second, unrelated container for the same tenant so the request is
  // authorized but the id belongs to a different container.
  await postAdd("unrelated note", "attacker");

  const attack = await json(`/v1/memories/${victimMem.id}?containerTag=attacker`, { method: "DELETE" });
  assert.equal(attack.status, 404, "a cross-container delete must not succeed");

  const after = await json("/v1/memories?containerTag=victim");
  const stillThere = after.body.memories.find((m) => m.id === victimMem.id);
  assert.equal(stillThere.effectiveStatus, "active", "victim's memory must be unchanged");
});

test("valid same-container deletion works", async () => {
  await postAdd("I live in Oslo.", "owner");
  const mem = (await json("/v1/memories?containerTag=owner")).body.memories[0];
  const del = await json(`/v1/memories/${mem.id}?containerTag=owner`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true });

  const after = await json("/v1/memories?containerTag=owner");
  assert.equal(after.body.memories.find((m) => m.id === mem.id).effectiveStatus, "forgotten");
});

test("unknown id returns 404", async () => {
  const res = await json("/v1/memories/does-not-exist?containerTag=owner", { method: "DELETE" });
  assert.equal(res.status, 404);
});

test("malformed JSON returns 400 with a safe message", async () => {
  const res = await fetch(base + "/v1/add", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: '{"content":"oops',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid request body" });
});

test("oversized payload returns 413 with a safe message", async () => {
  const res = await fetch(base + "/v1/add", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ content: "x".repeat(2_200_000) }),
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "payload too large" });
});

test("missing content and missing query return 400", async () => {
  assert.equal((await json("/v1/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 400);
  assert.equal((await json("/v1/search?containerTag=api_a")).status, 400);
});

test("sensitive request content never appears in server logs", async () => {
  const MARKER = "SENSITIVE_MARKER_9f3a2b7c";
  const captured = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => captured.push(args.map(String).join(" "));
  console.warn = (...args) => captured.push(args.map(String).join(" "));
  try {
    await fetch(base + "/v1/add", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: `{"content":"${MARKER}`,
    });
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.ok(captured.length > 0, "the error should have been logged");
  const logs = captured.join("\n");
  assert.ok(!logs.includes(MARKER), "raw body content must not be logged");
  assert.ok(!logs.includes(KEY), "the API key must not be logged");
});

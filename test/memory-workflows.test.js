// Realistic memory workflows over the real HTTP surface:
//   * store facts + a document, restart the SERVER PROCESS, and verify that
//     memories, document metadata, chunks and the uploaded file all persist;
//   * delete the document and prove the content is no longer retrievable;
//   * degrade to lexical ranking when the configured provider is unusable;
//   * never leak vectors, API keys or filesystem paths in any response.
//
// The server is a child process, so "restart" is a genuine process restart,
// not a re-require in the same process.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("node:child_process");
const { mkTmp, rm, freePort, waitReady, createKey } = require("./_support");

const REPO = path.join(__dirname, "..");
const CONTAINER = "workflow";
const FACTS = [
  "I work at Globex Inc.",
  "I'm a staff engineer now.",
  "I now live in Lisbon.",
  "I use Neovim as my editor.",
];
const NOTES = [
  "# Release notes",
  "",
  "The canary rollout uses the blue-green runbook.",
  "Rollbacks require two approvals from the platform team.",
].join("\n");

let dir;
let key;
let server;
let base;
let docId;
const tempDirs = [];

function start(extraEnv = {}) {
  return (async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["server.js"], {
      cwd: REPO,
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: "",
        DATA_DIR: dir,
        PORT: String(port),
        STORAGE_BACKEND: "sqlite",
        EMBEDDINGS_PROVIDER: "tfidf",
        EXTRACTION_PROVIDER: "regex",
        AUTH_MODE: "required",
        RATE_LIMIT_PER_MIN: "100000",
        RATE_LIMIT_EXPENSIVE_PER_MIN: "100000",
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    await waitReady(port);
    return { child, base: `http://127.0.0.1:${port}` };
  })();
}

function stop(child) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGKILL" });
    }, 10000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.kill("SIGTERM");
  });
}

async function call(method, endpoint, { body, headers = {} } = {}) {
  const res = await fetch(base + endpoint, {
    method,
    headers: { authorization: `Bearer ${key}`, ...headers },
    body,
  });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { status: res.status, body: json, raw, headers: res.headers };
}

function storedFiles(d) {
  const uploads = path.join(d, "uploads");
  if (!fs.existsSync(uploads)) return [];
  return fs
    .readdirSync(uploads)
    .filter((f) => fs.statSync(path.join(uploads, f)).isFile());
}

function assertHygiene(raw, label) {
  assert.ok(!raw.includes(key), `${label}: response leaked the API key`);
  assert.ok(!raw.includes(dir), `${label}: response leaked the data directory path`);
  assert.ok(!/"(embedding|embeddingProvider|apiKey)"\s*:/.test(raw), `${label}: leaked a vector/secret field`);
  assert.ok(!/\/(Users|private|tmp)\//.test(raw), `${label}: leaked an absolute path`);
}

before(async () => {
  dir = mkTmp("recall-workflow-");
  tempDirs.push(dir);
  key = createKey(dir, { tenant: "workflow", container: CONTAINER });
  ({ child: server, base } = await start());
});

after(async () => {
  if (server) await stop(server);
  for (const d of tempDirs) rm(d);
});

test("facts and a document are stored and retrievable", async () => {
  for (const content of FACTS) {
    const r = await call("POST", "/v1/add", {
      body: JSON.stringify({ content }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(r.status, 200, `add failed: ${r.raw}`);
    assertHygiene(r.raw, "add");
  }

  const up = await call("POST", `/v1/documents/upload?containerTag=${CONTAINER}`, {
    body: NOTES,
    headers: { "content-type": "text/markdown", "x-recall-filename": "release-notes.md" },
  });
  assert.equal(up.status, 201, `upload failed: ${up.raw}`);
  assertHygiene(up.raw, "upload");
  docId = up.body.document.id;
  assert.equal(up.body.document.status, "ready");
  assert.ok(up.body.chunkCount >= 1);

  const mem = await call("GET", "/v1/memories");
  const active = mem.body.memories.filter((m) => m.effectiveStatus === "active");
  assert.ok(active.some((m) => /Globex/.test(m.text)));
  assert.ok(active.some((m) => /Neovim/.test(m.text)));
  assertHygiene(mem.raw, "memories");

  const search = await call(
    "GET",
    `/v1/search?searchMode=documents&q=${encodeURIComponent("two approvals")}`
  );
  assert.equal(search.status, 200);
  assert.equal(search.body.ranking, "lexical");
  assert.ok(
    search.body.results.some((h) => h.filename === "release-notes.md"),
    "the uploaded document must be searchable with provenance"
  );

  assert.equal(storedFiles(dir).length, 1, "exactly one stored file expected");
});

test("a real process restart preserves memories, metadata and files", async () => {
  const stopped = await stop(server);
  assert.equal(stopped.code, 0, "SIGTERM must exit 0");
  server = null;

  assert.equal(storedFiles(dir).length, 1, "the uploaded file must survive shutdown");

  ({ child: server, base } = await start());

  const who = await call("GET", "/v1/whoami");
  assert.equal(who.status, 200, "the API key must survive a restart");
  assert.equal(who.body.containerTag, CONTAINER);

  const mem = await call("GET", "/v1/memories");
  assert.ok(
    mem.body.memories.some((m) => /Globex/.test(m.text)),
    "memories must survive a restart"
  );

  const detail = await call("GET", `/v1/documents/${docId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.document.status, "ready");
  assert.ok(detail.body.chunks.length >= 1, "chunks must survive a restart");

  const search = await call("GET", `/v1/search?q=${encodeURIComponent("Globex")}`);
  assert.equal(search.status, 200);
  assert.ok(
    search.body.results.some((h) => /Globex/.test(h.text)),
    "memory search must work after a restart"
  );

  const docSearch = await call(
    "GET",
    `/v1/search?searchMode=documents&q=${encodeURIComponent("blue-green runbook")}`
  );
  assert.ok(
    docSearch.body.results.some((h) => h.documentId === docId),
    "document search must work after a restart"
  );
});

test("deleting a document removes its content, chunks and stored file", async () => {
  const del = await call("DELETE", `/v1/documents/${docId}?containerTag=${CONTAINER}`);
  assert.equal(del.status, 200);

  const detail = await call("GET", `/v1/documents/${docId}`);
  assert.equal(detail.status, 404);

  const search = await call(
    "GET",
    `/v1/search?q=${encodeURIComponent("blue-green runbook approvals")}`
  );
  assert.ok(
    !search.body.results.some((h) => h.documentId === docId),
    "deleted content must not be retrievable"
  );

  assert.equal(storedFiles(dir).length, 0, "the stored file must be removed");

  // Unrelated memories are untouched by a document delete.
  const mem = await call("GET", "/v1/memories");
  assert.ok(mem.body.memories.some((m) => /Neovim/.test(m.text)));
});

test("an unusable embedding provider degrades to lexical search, not 5xx", async (t) => {
  if (server) await stop(server);
  server = null;
  const other = mkTmp("recall-workflow-dense-");
  tempDirs.push(other);
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: other,
      PORT: String(port),
      STORAGE_BACKEND: "sqlite",
      EMBEDDINGS_PROVIDER: "openai",
      OPENAI_API_KEY: "",
      EXTRACTION_PROVIDER: "regex",
      AUTH_MODE: "required",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await waitReady(port);
    base = `http://127.0.0.1:${port}`;
    key = createKey(other, { tenant: "degraded", container: "degraded" });

    const add = await call("POST", "/v1/add", {
      body: JSON.stringify({ content: "I work at Globex Inc." }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(add.status, 200, "ingestion must not fail when embeddings are unavailable");

    const search = await call("GET", `/v1/search?q=${encodeURIComponent("where does the user work")}`);
    assert.equal(search.status, 200, "search must not return 5xx");
    assert.equal(search.body.ranking, "lexical", "must report the real ranking mode");
    assert.equal(search.body.embeddingsProvider, "uninitialized");
    assert.ok(search.body.results.length >= 1, "lexical search must still return the stored fact");

    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    const body = await ready.json();
    assert.equal(ready.status, 200, "readiness must not gate on embeddings");
    assert.equal(body.dependencies.embeddings.dense, false);
  } finally {
    await stop(child);
  }
});

test("queries and error responses stay clean", async () => {
  // Restore a normal server for the hygiene checks.
  if (!server) {
    dir = mkTmp("recall-workflow-final-");
    tempDirs.push(dir);
    key = createKey(dir, { tenant: "workflow", container: CONTAINER });
    ({ child: server, base } = await start());
  }

  const empty = await call("GET", "/v1/search?q=");
  assert.equal(empty.status, 400);
  assertHygiene(empty.raw, "empty query");

  const long = await call("GET", `/v1/search?q=${"x".repeat(5000)}`);
  assert.equal(long.status, 400);
  assertHygiene(long.raw, "long query");

  const missing = await call("GET", "/v1/documents/does-not-exist");
  assert.equal(missing.status, 404);
  assertHygiene(missing.raw, "invalid id");

  const unknown = await call("GET", "/v1/nope");
  assert.equal(unknown.status, 404);
  assertHygiene(unknown.raw, "unknown route");

  const profile = await call("GET", "/v1/profile");
  assert.equal(profile.status, 200);
  assertHygiene(profile.raw, "profile");
});

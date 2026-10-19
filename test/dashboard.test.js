// Stage 4: the browser dashboard is served and exposes only public data.
//
// Verifies the static assets are reachable and that no browser-facing response
// leaks embedding vectors, provider/model bookkeeping or server-side paths.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { mkTmp, rm } = require("./_support");

const DIR = mkTmp("recall-dash-");
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

const FORBIDDEN = ["embedding", "embeddingProvider", "embeddingModel", "embeddingDim", "storageKey"];

function assertNoLeak(value, where) {
  const json = JSON.stringify(value);
  for (const key of FORBIDDEN) {
    assert.ok(!json.includes(`"${key}"`), `${where} must not expose "${key}"`);
  }
}

before(async () => {
  ({ key: KEY } = issueApiKey(db, { tenantId: "dash", containerTag: "dash" }));
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

async function authed(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${KEY}`, ...(opts.headers || {}) },
  });
  return res;
}

test("the dashboard and its assets are served", async () => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /recall/i);
  assert.match(html, /\/app\.js/);

  for (const asset of ["/app.js", "/style.css"]) {
    const res = await fetch(base + asset);
    assert.equal(res.status, 200, `${asset} must be served`);
  }
});

test("every element id app.js looks up exists in the page", async () => {
  const html = await (await fetch(base + "/")).text();
  const js = await (await fetch(base + "/app.js")).text();
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // app.js also creates elements dynamically (e.g. the document inspector).
  const createdInJs = new Set([...js.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const lookups = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(lookups.length > 0, "app.js should look up DOM elements");
  for (const id of lookups) {
    assert.ok(
      ids.has(id) || createdInJs.has(id),
      `app.js references #${id}, which is neither in the page nor created by app.js`
    );
  }
  assert.match(html, /id="docDetail"/, "the document inspector must exist");
});

test("browser-facing responses never include internal embedding or path fields", async () => {
  // Create a memory and an uploaded document, then inspect every read surface the
  // dashboard uses.
  await authed("/v1/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "I am a dashboards engineer in Quito.", containerTag: "dash" }),
  });
  const up = await authed("/v1/documents/upload?containerTag=dash", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Recall-Filename": "note.txt" },
    body: "A private note mentioning anteaters and oysters.",
  });
  const uploaded = await up.json();
  assert.equal(uploaded.document.status, "ready");

  const surfaces = [
    "/v1/whoami",
    "/v1/memories?containerTag=dash",
    "/v1/profile?containerTag=dash",
    "/v1/documents?containerTag=dash",
    `/v1/documents/${uploaded.document.id}?containerTag=dash`,
    "/v1/search?q=anteaters&containerTag=dash",
    "/v1/search?q=engineer&containerTag=dash&searchMode=memories",
    "/v1/containers",
  ];
  for (const pathname of surfaces) {
    const res = await authed(pathname);
    assert.equal(res.status, 200, `${pathname} should succeed`);
    assertNoLeak(await res.json(), pathname);
  }
});

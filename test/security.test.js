// Stage 5: network exposure, headers and isolation.
//
// Verifies the always-on hardening: loopback-by-default binding, strict browser
// headers, the JSON 404 (no framework fingerprint), that every /v1 route needs a
// bearer key (so a cross-site form cannot act), and that containers stay isolated.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { mkTmp, rm } = require("./_support");

const DIR = mkTmp("recall-sec-");
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";

const { app, readConfig } = require("../server");
const db = require("../lib/db");
const { issueApiKey } = require("../lib/auth");

let server;
let base;
let KEY;
let OTHER_KEY;

before(async () => {
  ({ key: KEY } = issueApiKey(db, { tenantId: "sec", containerTag: "sec_a" }));
  ({ key: OTHER_KEY } = issueApiKey(db, { tenantId: "other", containerTag: "other_a" }));
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

// --------------------------------------------------------------- config ----

test("the default bind address is loopback (not reachable from other machines)", () => {
  const prev = { HOST: process.env.HOST, NODE_ENV: process.env.NODE_ENV };
  delete process.env.HOST;
  try {
    assert.equal(readConfig().host, "127.0.0.1");
    assert.equal(readConfig({ HOST: " 0.0.0.0 " }).host, "0.0.0.0");
    assert.equal(readConfig({ HOST: "::1" }).host, "::1");
  } finally {
    if (prev.HOST !== undefined) process.env.HOST = prev.HOST;
    if (prev.NODE_ENV !== undefined) process.env.NODE_ENV = prev.NODE_ENV;
  }
});

test("dev auth is refused in production and unknown modes are rejected", () => {
  assert.throws(() => readConfig({ AUTH_MODE: "dev", NODE_ENV: "production" }), /production/);
  assert.throws(() => readConfig({ AUTH_MODE: "open" }), /AUTH_MODE/);
  assert.equal(readConfig({ AUTH_MODE: "dev" }).authMode, "dev");
});

// -------------------------------------------------------------- headers ----

test("every response carries strict, self-only browser headers", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null, "must not advertise the framework");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");

  const csp = res.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.ok(!/unsafe-inline/.test(csp), "CSP must not allow inline scripts/styles");
  assert.ok(!/\*/.test(csp), "CSP must not contain a wildcard");
});

test("the API responses carry the same headers", async () => {
  const res = await fetch(base + "/v1/whoami", { headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.ok(res.headers.get("content-security-policy"));
});

// ----------------------------------------------------------------- auth ----

test("every /v1 route rejects a request with no bearer key", async () => {
  const calls = [
    ["GET", "/v1/whoami"],
    ["GET", "/v1/memories"],
    ["GET", "/v1/profile"],
    ["GET", "/v1/documents"],
    ["GET", "/v1/search?q=hello"],
    ["GET", "/v1/containers"],
    ["POST", "/v1/add"],
    ["POST", "/v1/documents/upload"],
  ];
  for (const [method, pathname] of calls) {
    const res = await fetch(base + pathname, { method });
    assert.equal(res.status, 401, `${method} ${pathname} must require authentication`);
  }
});

test("a cross-site form POST cannot act (headers are the only credential)", async () => {
  // A browser <form> can send these but cannot add an Authorization header, so it
  // must be unauthenticated even with a plausible body/content-type.
  const res = await fetch(base + "/v1/documents/upload", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "content=hello",
  });
  assert.equal(res.status, 401);
});

test("a valid key cannot reach another tenant's container", async () => {
  const res = await fetch(base + "/v1/memories?containerTag=other_a", {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  assert.equal(res.status, 403);
});

// ------------------------------------------------------------ surfaces -----

test("unknown API paths return JSON, never the framework page", async () => {
  const res = await fetch(base + "/v1/does-not-exist", {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  const body = await res.json();
  assert.equal(body.error, "not found");
  assert.ok(!JSON.stringify(body).includes("Express"));
});

test("the dashboard page is public but contains no data or secrets", async () => {
  const res = await fetch(base + "/");
  const html = await res.text();
  assert.equal(res.status, 200);
  // No embedded credentials, tenant data, or server paths.
  assert.ok(!/sm_[A-Za-z0-9_-]{20,}/.test(html), "no API key in the page");
  assert.ok(!html.includes(DIR), "no server paths in the page");
});

test("the other tenant's key cannot read this tenant's containers", async () => {
  const mine = await (
    await fetch(base + "/v1/containers", { headers: { Authorization: `Bearer ${KEY}` } })
  ).json();
  assert.deepEqual(mine.containerTags, ["sec_a"]);
  const theirs = await (
    await fetch(base + "/v1/containers", { headers: { Authorization: `Bearer ${OTHER_KEY}` } })
  ).json();
  assert.deepEqual(theirs.containerTags, ["other_a"]);
});

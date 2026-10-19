// Stage 8: operational endpoints.
//
// Liveness and readiness must be reachable without a key (a probe cannot hold
// one), expose no paths/secrets/tenant data, carry the standard security headers,
// and report honestly: not-ready while draining or when a hard dependency is
// unusable.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { mkTmp, rm } = require("./_support");

const DIR = mkTmp("recall-health-");
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";

const { app, createApp } = require("../server");
const db = require("../lib/db");

let server;
let base;

before(async () => {
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

async function listen(appInstance) {
  const srv = appInstance.listen(0);
  await new Promise((resolve) => srv.once("listening", resolve));
  return srv;
}

test("/healthz is unauthenticated and reports process liveness only", async () => {
  const res = await fetch(base + "/healthz");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "recall");
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.uptimeSeconds, "number");
  // Liveness touches no dependency, so an outage cannot cause a restart loop.
  assert.equal(body.dependencies, undefined);
});

test("/readyz is unauthenticated and reports per-dependency status", async () => {
  const res = await fetch(base + "/readyz");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ready, true);
  assert.equal(body.draining, false);
  assert.deepEqual(Object.keys(body.dependencies).sort(), ["database", "embeddings", "storage"]);
  assert.equal(body.dependencies.database.ok, true);
  assert.equal(body.dependencies.database.backend, "sqlite");
  assert.equal(body.dependencies.storage.ok, true);
  assert.equal(body.dependencies.embeddings.ok, true);
  assert.equal(typeof body.dependencies.embeddings.dense, "boolean");
});

test("health responses carry the standard security headers", async () => {
  for (const path of ["/healthz", "/readyz"]) {
    const res = await fetch(base + path);
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.ok(res.headers.get("content-security-policy"), `${path} must set a CSP`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  }
});

test("health responses expose no paths, secrets or tenant data", async () => {
  for (const path of ["/healthz", "/readyz"]) {
    const text = await (await fetch(base + path)).text();
    assert.ok(!text.includes(DIR), `${path} must not leak the data directory`);
    assert.ok(!/sm_[A-Za-z0-9_-]{20,}/.test(text), `${path} must not leak an API key`);
    assert.ok(!/embedding"\s*:\s*\[/.test(text), `${path} must not leak vectors`);
  }
});

test("a draining instance reports not-ready with 503", async () => {
  const drainApp = createApp();
  drainApp.beginDraining();
  const srv = await listen(drainApp);
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/readyz`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ready, false);
    assert.equal(body.draining, true);
    assert.equal(body.status, "unavailable");
    // Liveness is unaffected by draining.
    const live = await fetch(`http://127.0.0.1:${srv.address().port}/healthz`);
    assert.equal(live.status, 200);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("readiness returns 503 when the database is unusable", async () => {
  const failApp = createApp();
  const original = db.ping;
  db.ping = () => {
    const err = new Error("database unavailable");
    err.code = "EIO";
    throw err;
  };
  const srv = await listen(failApp);
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/readyz`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ready, false);
    assert.equal(body.dependencies.database.ok, false);
    assert.equal(body.dependencies.database.code, "EIO");
  } finally {
    db.ping = original;
    await new Promise((resolve) => srv.close(resolve));
  }
});

// Stage 9: the smoke script must pass against a real server process.
//
// This keeps the operator smoke test itself honest: it is executed here against a
// freshly spawned instance, so a change that breaks the deployed HTTP surface
// fails the suite, not just the manual step.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawn, spawnSync } = require("node:child_process");
const { mkTmp, rm, freePort, waitReady } = require("./_support");

const REPO = path.join(__dirname, "..");
const SMOKE = path.join(REPO, "scripts", "smoke.js");

let dir;
let server;
let base;

before(async () => {
  dir = mkTmp("recall-smoke-");
  const port = await freePort();
  server = spawn(process.execPath, ["server.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: String(port),
      STORAGE_BACKEND: "sqlite",
      EMBEDDINGS_PROVIDER: "tfidf",
      EXTRACTION_PROVIDER: "regex",
      AUTH_MODE: "dev",
      DEV_TENANT: "smoke_tenant",
      DEV_CONTAINER: "smoke_space",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitReady(port);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) server.kill("SIGKILL");
  rm(dir);
});

test("scripts/smoke.js passes against a running instance", () => {
  const res = spawnSync(process.execPath, [SMOKE], {
    cwd: REPO,
    env: { ...process.env, RECALL_URL: base, RECALL_KEY: "" },
    encoding: "utf-8",
  });
  assert.equal(res.status, 0, `smoke exited ${res.status}\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /smoke test succeeded/);
  assert.ok(!/FAIL/.test(res.stdout), "no FAIL lines expected");
});

test("scripts/smoke.js fails against a dead endpoint", () => {
  const res = spawnSync(process.execPath, [SMOKE], {
    cwd: REPO,
    env: { ...process.env, RECALL_URL: "http://127.0.0.1:1", RECALL_KEY: "" },
    encoding: "utf-8",
  });
  assert.notEqual(res.status, 0, "an unreachable instance must fail the smoke test");
});

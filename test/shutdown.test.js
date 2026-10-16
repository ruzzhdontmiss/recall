const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawn } = require("node:child_process");
const { mkTmp, rm, freePort, waitReady, createKey } = require("./_support");

const SERVER = path.join(__dirname, "..", "server.js");

function start(env) {
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function add(port, key, content, tag) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ content, containerTag: tag }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function lifecycle(t, backend) {
  const dir = mkTmp();
  t.after(() => rm(dir));
  const port = await freePort();
  const baseEnv = {
    DATA_DIR: dir,
    STORAGE_BACKEND: backend,
    EMBEDDINGS_PROVIDER: "tfidf",
    EXTRACTION_PROVIDER: "regex",
    PORT: String(port),
  };

  // Bootstrap a key offline (there is no unauthenticated admin endpoint).
  const key = createKey(dir, { tenant: "shutdown", container: "shutdown_user", backend });

  // First run: write data, then SIGTERM.
  const first = start(baseEnv);
  await waitReady(port);
  await add(port, key, "I live in Berlin.", "shutdown_user");
  const firstExit = await new Promise((resolve) => {
    first.once("exit", (code) => resolve(code));
    first.kill("SIGTERM");
  });
  assert.equal(firstExit, 0, "graceful SIGTERM should exit 0");

  // Second run: the data (and the key) must still be there.
  const second = start(baseEnv);
  await waitReady(port);
  const whoami = await fetch(`http://127.0.0.1:${port}/v1/whoami`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(whoami.status, 200, "the API key must survive restart");

  const mems = await fetch(`http://127.0.0.1:${port}/v1/memories?containerTag=shutdown_user`, {
    headers: { Authorization: `Bearer ${key}` },
  }).then((r) => r.json());
  assert.ok(mems.memories.length >= 1, "data must survive SIGTERM + restart");
  assert.ok(mems.memories.every((m) => typeof m.text === "string"));

  // SIGINT keeps working too.
  const secondExit = await new Promise((resolve) => {
    second.once("exit", (code) => resolve(code));
    second.kill("SIGINT");
  });
  assert.equal(secondExit, 0, "graceful SIGINT should exit 0");
}

test("SQLite: writes survive SIGTERM and restart", async (t) => {
  await lifecycle(t, "sqlite");
});

test("JSON (legacy) mode: buffered writes flush on SIGTERM", async (t) => {
  await lifecycle(t, "json");
});

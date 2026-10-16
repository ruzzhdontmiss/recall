// Shared test helpers. This file has no top-level side effects, so it is safe
// for the test runner to load it even if it is picked up as a test file.

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawnSync } = require("node:child_process");

const KEY_CLI = path.join(__dirname, "..", "scripts", "key-cli.js");

function mkTmp(prefix = "recall-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rm(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      // Any HTTP response means the server is up; 401 is expected without a key.
      await fetch(`http://127.0.0.1:${port}/v1/whoami`);
      return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`server on port ${port} did not become ready`);
}

// Run the offline key CLI against a directory, returning its parsed --json output.
function runKeyCli(dir, args, { backend = "sqlite" } = {}) {
  const res = spawnSync(process.execPath, [KEY_CLI, ...args], {
    env: { ...process.env, DATA_DIR: dir, STORAGE_BACKEND: backend },
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`key-cli ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function createKey(dir, { tenant, container = null, name = null, backend = "sqlite" } = {}) {
  const args = ["create", "--tenant", tenant, "--json"];
  if (container) args.push("--container", container);
  if (name) args.push("--name", name);
  return JSON.parse(runKeyCli(dir, args, { backend })).key;
}

module.exports = { mkTmp, rm, sleep, freePort, waitReady, runKeyCli, createKey, KEY_CLI };

// Shared test helpers. This file has no top-level side effects, so it is safe
// for the test runner to load it even if it is picked up as a test file.

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

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
      const res = await fetch(`http://127.0.0.1:${port}/v1/containers`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`server on port ${port} did not become ready`);
}

module.exports = { mkTmp, rm, sleep, freePort, waitReady };

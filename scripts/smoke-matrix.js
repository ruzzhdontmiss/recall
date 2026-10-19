#!/usr/bin/env node
// Private-deployment smoke matrix.
//
// Starts a REAL server process for each supported configuration, runs the
// end-to-end smoke test (scripts/smoke.js) against it, and — for the default
// configuration — proves the process is not reachable from a non-loopback
// address. This is the "is my private instance actually working and actually
// private?" check.
//
//   npm run smoke:matrix                 # all scenarios
//   SMOKE_SKIP_DENSE=1 npm run smoke:matrix   # skip the scenarios that load the
//                                             # local model (offline / no cache)
//
// Exit code is non-zero if any scenario fails.

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { spawn, spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const SERVER = path.join(REPO, "server.js");
const SMOKE = path.join(REPO, "scripts", "smoke.js");
const KEY_CLI = path.join(REPO, "scripts", "key-cli.js");

const SKIP_DENSE = process.env.SMOKE_SKIP_DENSE === "1";
const READY_TIMEOUT_MS = 60000;
const SMOKE_TIMEOUT_MS = 180000;

function log(msg) {
  process.stdout.write(msg + "\n");
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitReady(port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

function mintKey(env, tenant, container) {
  const res = spawnSync(
    process.execPath,
    [KEY_CLI, "create", "--tenant", tenant, "--container", container, "--json"],
    { cwd: REPO, env: { ...process.env, ...env }, encoding: "utf-8" }
  );
  if (res.status !== 0) throw new Error(`key-cli failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout.trim()).key;
}

function runSmoke(base, key) {
  const res = spawnSync(process.execPath, [SMOKE], {
    cwd: REPO,
    env: { ...process.env, RECALL_URL: base, RECALL_KEY: key || "" },
    encoding: "utf-8",
    timeout: SMOKE_TIMEOUT_MS,
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

// A non-internal IPv4, if the host has one (loopback-only hosts skip this).
function nonLoopbackIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

// Prove the default bind is loopback-only: the port must NOT answer on any
// non-loopback address of this host.
async function assertNotPubliclyReachable(port, lanIp) {
  if (!lanIp) return "skipped (no non-loopback IPv4 on this host)";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`http://${lanIp}:${port}/healthz`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) throw new Error(`reachable at http://${lanIp}:${port} — expected loopback-only`);
    return `only refused with HTTP ${res.status} on ${lanIp}`;
  } catch (err) {
    clearTimeout(timer);
    if (String(err.message).includes("expected loopback-only")) throw err;
    const code = (err.cause && err.cause.code) || err.code || err.name;
    return `connection refused on ${lanIp} (${code})`;
  }
}

const scenarios = [
  {
    name: "sqlite + tfidf, dev auth",
    env: { STORAGE_BACKEND: "sqlite", EMBEDDINGS_PROVIDER: "tfidf", AUTH_MODE: "dev" },
    checkBind: true,
  },
  {
    name: "json + tfidf, dev auth",
    env: { STORAGE_BACKEND: "json", EMBEDDINGS_PROVIDER: "tfidf", AUTH_MODE: "dev" },
    checkBind: true,
  },
  {
    name: "sqlite + tfidf, authenticated (real key)",
    env: { STORAGE_BACKEND: "sqlite", EMBEDDINGS_PROVIDER: "tfidf", AUTH_MODE: "required" },
    key: { tenant: "smoke_tenant", container: "smoke_space" },
  },
  {
    name: "sqlite + xenova (dense), dev auth",
    env: { STORAGE_BACKEND: "sqlite", EMBEDDINGS_PROVIDER: "xenova", AUTH_MODE: "dev" },
    dense: true,
  },
  {
    name: "sqlite + unusable dense provider (openai, no key)",
    env: { STORAGE_BACKEND: "sqlite", EMBEDDINGS_PROVIDER: "openai", OPENAI_API_KEY: "", AUTH_MODE: "dev" },
    allowDegraded: true,
  },
];

async function runScenario(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-matrix-"));
  const port = await freePort();
  const env = {
    ...process.env,
    ...scenario.env,
    DATA_DIR: dir,
    PORT: String(port),
    EXTRACTION_PROVIDER: "regex",
  };

  let key = scenario.key ? mintKey(env, scenario.key.tenant, scenario.key.container) : "";
  const server = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverErr = "";
  server.stderr.on("data", (d) => {
    serverErr += d.toString();
  });

  try {
    const ready = await waitReady(port);
    if (!ready) {
      return { ok: false, detail: `server did not become ready\n${serverErr}` };
    }

    const base = `http://127.0.0.1:${port}`;
    const smoke = runSmoke(base, key);
    if (smoke.status !== 0) {
      return { ok: false, detail: `smoke exited ${smoke.status}\n${smoke.stdout}\n${smoke.stderr}` };
    }

    // The degraded scenario must still report usable results (lexical), which the
    // smoke test already asserts; nothing extra to do here.
    if (scenario.checkBind) {
      const reach = await assertNotPubliclyReachable(port, nonLoopbackIPv4());
      if (String(reach).includes("expected loopback-only")) {
        return { ok: false, detail: reach };
      }
      return { ok: true, detail: `not publicly reachable: ${reach}` };
    }

    if (scenario.dense) {
      const res = await fetch(base + "/readyz");
      const body = await res.json();
      if (!body.dependencies.embeddings.dense) {
        return { ok: false, detail: `expected a dense provider, got ${JSON.stringify(body.dependencies.embeddings)}` };
      }
      return { ok: true, detail: `dense provider loaded (${body.dependencies.embeddings.space})` };
    }

    return { ok: true, detail: "smoke passed" };
  } catch (err) {
    return { ok: false, detail: (err && err.stack) || String(err) };
  } finally {
    server.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  log("Recall private smoke matrix\n");
  const results = [];
  for (const scenario of scenarios) {
    if (scenario.dense && SKIP_DENSE) {
      log(`SKIP  ${scenario.name} (SMOKE_SKIP_DENSE=1)`);
      results.push({ name: scenario.name, skipped: true });
      continue;
    }
    process.stdout.write(`RUN   ${scenario.name} … `);
    const result = await runScenario(scenario);
    log(result.ok ? "PASS" : "FAIL");
    if (result.ok && result.detail) log(`      ${result.detail}`);
    if (!result.ok) log(`      ${String(result.detail).split("\n").join("\n      ")}`);
    results.push({ name: scenario.name, ...result });
  }

  const failed = results.filter((r) => !r.skipped && !r.ok);
  const passed = results.filter((r) => r.ok);
  const skipped = results.filter((r) => r.skipped);
  log("");
  log(`matrix: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`matrix crashed: ${(err && err.stack) || err}`);
  process.exit(1);
});

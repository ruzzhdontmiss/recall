const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawn } = require("node:child_process");
const { mkTmp, rm, KEY_CLI } = require("./_support");
const { openDatabase } = require("../lib/storage/sqlite");

function runCli(dir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [KEY_CLI, ...args], {
      env: { ...process.env, DATA_DIR: dir, STORAGE_BACKEND: "sqlite" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

test("many tenants racing for one container: exactly one wins, no overwrite", async (t) => {
  const dir = mkTmp();
  t.after(() => rm(dir));
  const file = path.join(dir, "recall.db");

  // Apply migrations up front so the race is only about the container claim.
  openDatabase(file).close();

  const CONTAINER = "contested_tag";
  const tenants = ["t1", "t2", "t3", "t4", "t5"];
  const results = await Promise.all(
    tenants.map((tenant) => runCli(dir, ["create", "--tenant", tenant, "--container", CONTAINER, "--json"]))
  );

  const successes = results.filter((r) => r.code === 0);
  const failures = results.filter((r) => r.code !== 0);
  assert.equal(successes.length, 1, "exactly one tenant may claim the container");
  assert.equal(failures.length, tenants.length - 1, "every other tenant must be rejected");
  for (const f of failures) {
    assert.ok(!/sm_/.test(f.out + f.err), "no secret may be printed on failure");
    assert.match(f.err, /error: /, "the failure must be a handled error message");
    assert.ok(
      !/SqliteError|SQLITE_CONSTRAINT|at .*\(\/.*:\d+:\d+\)/.test(f.err + f.out),
      "the loser must not crash with an unhandled SQLite error"
    );
  }

  const winner = JSON.parse(successes[0].out);

  const db = openDatabase(file);
  try {
    const owner = db
      .prepare("SELECT tenant_id FROM containers WHERE container_tag = ?")
      .get(CONTAINER);
    assert.equal(owner.tenant_id, winner.tenantId, "the container is owned by the winner only");

    const containers = db.prepare("SELECT COUNT(*) AS n FROM containers").get();
    assert.equal(containers.n, 1, "a container must never be duplicated or reassigned");

    for (const tenant of tenants) {
      const keys = db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ?").get(tenant);
      assert.equal(keys.n, tenant === winner.tenantId ? 1 : 0, `tenant ${tenant} key count`);
    }
  } finally {
    db.close();
  }
});

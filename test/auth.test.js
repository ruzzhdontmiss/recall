const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { mkTmp, rm, runKeyCli, createKey } = require("./_support");

// Isolated, deterministic environment set BEFORE the app is required.
const DIR = mkTmp();
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";

const { app, createApp, readConfig } = require("../server");
const db = require("../lib/db");
const { issueApiKey, hashApiKey } = require("../lib/auth");

const TENANT_A = "tenant_a";
const TENANT_B = "tenant_b";

let server;
let base;
let keyA;
let keyB;
let recA;

before(async () => {
  ({ key: keyA, record: recA } = issueApiKey(db, { tenantId: TENANT_A, containerTag: "alpha" }));
  ({ key: keyB } = issueApiKey(db, { tenantId: TENANT_B, containerTag: "beta" }));
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

async function req(pathname, { key, method = "GET", body, authHeader } = {}) {
  const headers = {};
  if (authHeader !== undefined) headers.Authorization = authHeader;
  else if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed, headers: res.headers };
}

const add = (key, content, containerTag) =>
  req("/v1/add", { key, method: "POST", body: { content, containerTag } });

// ---------------------------------------------------------------- auth -----

test("every data-bearing route rejects a missing key with 401", async () => {
  const routes = [
    ["GET", "/v1/whoami", undefined],
    ["GET", "/v1/containers", undefined],
    ["GET", "/v1/memories", undefined],
    ["GET", "/v1/profile", undefined],
    ["GET", "/v1/documents", undefined],
    ["GET", "/v1/search?q=anything", undefined],
    ["POST", "/v1/add", { content: "hello" }],
    ["DELETE", "/v1/memories/abc", undefined],
  ];
  for (const [method, pathname, body] of routes) {
    const res = await req(pathname, { method, body });
    assert.equal(res.status, 401, `${method} ${pathname} must require a key`);
    assert.deepEqual(res.body, { error: "unauthorized" });
  }
});

test("malformed, wrong-scheme and unknown keys are all rejected with 401", async () => {
  const badHeaders = [
    "Basic dXNlcjpwYXNz",
    "Bearer",
    "Bearer    ",
    "Token sm_abcdef",
    "sm_abcdef", // no scheme
    `xx_${keyA.slice(3)}`, // right shape, wrong prefix
    "sm_thisisnotarealkey000000000000000000000000",
  ];
  for (const header of badHeaders) {
    const res = await req("/v1/whoami", { authHeader: header });
    assert.equal(res.status, 401, `header "${header}" must be rejected`);
    assert.deepEqual(res.body, { error: "unauthorized" });
  }
});

test("a valid key authenticates and identifies its tenant", async () => {
  const res = await req("/v1/whoami", { key: keyA });
  assert.equal(res.status, 200);
  assert.equal(res.body.tenantId, TENANT_A);
  assert.equal(res.body.containerTag, "alpha");
  assert.equal(res.body.keyId, recA.id);
});

test("a revoked key is rejected; the original key stays valid until revoked", async () => {
  const { key: doomed, record } = issueApiKey(db, { tenantId: TENANT_A, containerTag: "alpha" });
  assert.equal((await req("/v1/whoami", { key: doomed })).status, 200);
  assert.equal(db.revokeApiKey(record.id, TENANT_A, new Date().toISOString()), 1);
  assert.equal((await req("/v1/whoami", { key: doomed })).status, 401);
  // Revoking again is a no-op (already revoked).
  assert.equal(db.revokeApiKey(record.id, TENANT_A, new Date().toISOString()), 0);
});

test("a key can only be revoked by its own tenant", async () => {
  const { key: k, record } = issueApiKey(db, { tenantId: TENANT_A, containerTag: "alpha" });
  assert.equal(db.revokeApiKey(record.id, TENANT_B, new Date().toISOString()), 0);
  assert.equal((await req("/v1/whoami", { key: k })).status, 200, "cross-tenant revoke must be denied");
});

test("an expired key is rejected", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const { key: expired } = issueApiKey(db, { tenantId: TENANT_A, containerTag: "alpha", expiresAt: past });
  assert.equal((await req("/v1/whoami", { key: expired })).status, 401);
});

// ------------------------------------------------------- tenant isolation --

test("a tenant can add to and read its own container", async () => {
  const res = await add(keyA, "I am a backend engineer. I live in Berlin.", "alpha");
  assert.equal(res.status, 200);
  const mems = await req("/v1/memories?containerTag=alpha", { key: keyA });
  assert.equal(mems.status, 200);
  assert.ok(mems.body.memories.length >= 1);
});

test("cross-tenant reads across every read route are denied with 403", async () => {
  const routes = [
    "/v1/memories?containerTag=alpha",
    "/v1/documents?containerTag=alpha",
    "/v1/profile?containerTag=alpha",
    "/v1/profile?containerTag=alpha&q=berlin",
    "/v1/search?q=berlin&containerTag=alpha",
    "/v1/search?q=berlin&containerTag=alpha&searchMode=memories",
  ];
  for (const pathname of routes) {
    const res = await req(pathname, { key: keyB });
    assert.equal(res.status, 403, `tenant B must not read ${pathname}`);
    assert.deepEqual(res.body, { error: "forbidden" });
  }
});

test("container enumeration only ever lists the caller's containers", async () => {
  const a = await req("/v1/containers", { key: keyA });
  assert.deepEqual(a.body.containerTags, ["alpha"]);
  const b = await req("/v1/containers", { key: keyB });
  assert.deepEqual(b.body.containerTags, ["beta"]);
  assert.ok(!b.body.containerTags.includes("alpha"));
});

test("a tenant cannot delete another tenant's memory via a known id", async () => {
  const victim = await req("/v1/memories?containerTag=alpha", { key: keyA });
  const memId = victim.body.memories[0].id;

  // Forged container tag belonging to another tenant -> denied.
  const forged = await req(`/v1/memories/${memId}?containerTag=alpha`, { key: keyB, method: "DELETE" });
  assert.equal(forged.status, 403);

  // Own container -> authorized, but the id does not exist there -> 404.
  const ownContainer = await req(`/v1/memories/${memId}?containerTag=beta`, { key: keyB, method: "DELETE" });
  assert.equal(ownContainer.status, 404);

  // The victim's memory is untouched.
  const after = await req("/v1/memories?containerTag=alpha", { key: keyA });
  const still = after.body.memories.find((m) => m.id === memId);
  assert.ok(still, "victim memory must still exist");
  assert.notEqual(still.effectiveStatus, "forgotten");
});

test("a tenant cannot claim a container owned by another tenant", async () => {
  const before = await req("/v1/documents?containerTag=alpha", { key: keyA });
  const forged = await add(keyB, "injected content", "alpha");
  assert.equal(forged.status, 403);
  assert.deepEqual(forged.body, { error: "forbidden" });

  const after = await req("/v1/documents?containerTag=alpha", { key: keyA });
  assert.equal(after.body.documents.length, before.body.documents.length, "no data may be injected");
  assert.ok(
    !after.body.documents.some((d) => d.content.includes("injected content")),
    "the injected document must not appear"
  );
});

// ----------------------------------------------------------- secret safety --

test("keys are hashed at rest, never stored or listed raw", () => {
  const record = db.getApiKeyByHash(hashApiKey(keyA));
  assert.ok(record, "the key is found by its hash");
  assert.equal(record.keyHash, hashApiKey(keyA));
  assert.notEqual(record.keyHash, keyA);
  assert.equal(record.tenantId, TENANT_A);

  const listed = db.listApiKeys(TENANT_A);
  assert.ok(listed.length >= 1);
  assert.ok(listed.every((k) => !("keyHash" in k)), "listing must not expose hashes");
  assert.ok(listed.every((k) => JSON.stringify(k) !== keyA));

  // Read every stored column value through a second, read-only connection and
  // confirm the raw secret appears nowhere in the database (only its hash does).
  const Database = require("better-sqlite3");
  const raw = new Database(path.join(DIR, "recall.db"), { readonly: true });
  try {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_"));
    let sawHash = false;
    for (const table of tables) {
      for (const row of raw.prepare(`SELECT * FROM "${table}"`).all()) {
        for (const value of Object.values(row)) {
          if (typeof value !== "string") continue;
          assert.ok(!value.includes(keyA), `the raw key must not appear in ${table}`);
          if (value === hashApiKey(keyA)) sawHash = true;
        }
      }
    }
    assert.ok(sawHash, "the key hash must be stored");
  } finally {
    raw.close();
  }
});

test("request bodies, headers and keys never appear in logs", async () => {
  const KEY_MARKER = keyA;
  const BODY_MARKER = "PRIVATE_DOCUMENT_CONTENT_7c1f";
  const captured = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...a) => captured.push(a.map(String).join(" "));
  console.warn = (...a) => captured.push(a.map(String).join(" "));
  try {
    // Malformed JSON with both the key and private content in the request.
    await fetch(base + "/v1/add", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${keyA}` },
      body: `{"content":"${BODY_MARKER}`,
    });
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  const logs = captured.join("\n");
  assert.ok(captured.length > 0, "the failure should be logged");
  assert.ok(!logs.includes(KEY_MARKER), "the API key must never be logged");
  assert.ok(!logs.includes(BODY_MARKER), "raw content must never be logged");
  assert.ok(!logs.includes("authorization") && !logs.includes("Authorization"), "headers must not be logged");
});

// ---------------------------------------------------------- rate limits ----

test("per-key general rate limit returns 429 with a Retry-After header", async (t) => {
  const prev = process.env.RATE_LIMIT_PER_MIN;
  process.env.RATE_LIMIT_PER_MIN = "3";
  const limited = createApp();
  const srv = await new Promise((resolve) => {
    const s = limited.listen(0, () => resolve(s));
  });
  t.after(() => {
    srv.close();
    if (prev === undefined) delete process.env.RATE_LIMIT_PER_MIN;
    else process.env.RATE_LIMIT_PER_MIN = prev;
  });
  const lbase = `http://127.0.0.1:${srv.address().port}`;
  const call = (p) => fetch(lbase + p, { headers: { Authorization: `Bearer ${keyA}` } });

  assert.equal((await call("/v1/whoami")).status, 200);
  assert.equal((await call("/v1/whoami")).status, 200);
  assert.equal((await call("/v1/whoami")).status, 200);
  const limitedRes = await call("/v1/whoami");
  assert.equal(limitedRes.status, 429);
  assert.deepEqual(await limitedRes.json(), { error: "rate limit exceeded" });
  assert.ok(Number(limitedRes.headers.get("retry-after")) >= 1);
});

test("the stricter expensive limit applies to search and add", async (t) => {
  const prevGeneral = process.env.RATE_LIMIT_PER_MIN;
  const prevExpensive = process.env.RATE_LIMIT_EXPENSIVE_PER_MIN;
  process.env.RATE_LIMIT_PER_MIN = "100";
  process.env.RATE_LIMIT_EXPENSIVE_PER_MIN = "1";
  const limited = createApp();
  const srv = await new Promise((resolve) => {
    const s = limited.listen(0, () => resolve(s));
  });
  t.after(() => {
    srv.close();
    if (prevGeneral === undefined) delete process.env.RATE_LIMIT_PER_MIN;
    else process.env.RATE_LIMIT_PER_MIN = prevGeneral;
    if (prevExpensive === undefined) delete process.env.RATE_LIMIT_EXPENSIVE_PER_MIN;
    else process.env.RATE_LIMIT_EXPENSIVE_PER_MIN = prevExpensive;
  });
  const lbase = `http://127.0.0.1:${srv.address().port}`;
  const call = (p) => fetch(lbase + p, { headers: { Authorization: `Bearer ${keyA}` } });

  assert.equal((await call("/v1/search?q=berlin&containerTag=alpha")).status, 200);
  assert.equal((await call("/v1/search?q=berlin&containerTag=alpha")).status, 429);

  assert.equal(
    (
      await fetch(`${lbase}/v1/add`, {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello", containerTag: "alpha" }),
      })
    ).status,
    429
  );
});

// ----------------------------------------------------------- validation ----

test("identifiers, container selectors, modes and sizes are validated", async () => {
  assert.equal((await add(keyA, "x", "bad tag!")).status, 400);
  assert.equal((await req("/v1/search?q=hi&searchMode=bogus&containerTag=alpha", { key: keyA })).status, 400);
  assert.equal((await req("/v1/memories/not..a..valid..id", { key: keyA, method: "DELETE" })).status, 400);
  assert.equal((await add(keyA, "", "alpha")).status, 400);
  assert.equal((await req("/v1/search?containerTag=alpha", { key: keyA })).status, 400);
  assert.equal((await add(keyA, "x".repeat(200_001), "alpha")).status, 413);
});

// -------------------------------------------------------- dev mode guard ---

test("explicit dev mode authenticates anonymously; production refuses it", async (t) => {
  assert.throws(() => readConfig({ AUTH_MODE: "dev", NODE_ENV: "production" }), /production/);
  assert.throws(() => readConfig({ AUTH_MODE: "nonsense" }), /AUTH_MODE/);

  const devConfig = {
    authMode: "dev",
    devTenant: "devt",
    devContainer: "devc",
    generalMax: 1000,
    expensiveMax: 1000,
    corsOrigins: [],
  };
  const devApp = createApp(devConfig);
  const srv = await new Promise((resolve) => {
    const s = devApp.listen(0, () => resolve(s));
  });
  t.after(() => srv.close());
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/v1/whoami`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tenantId, "devt");
  assert.equal(body.containerTag, "devc");
  assert.equal(body.authMode, "dev");
});

// ------------------------------------------------- bootstrap / lifecycle ---

test("the offline CLI bootstraps a usable key and can revoke it", async () => {
  const cliKey = createKey(DIR, { tenant: "cli_tenant", container: "cli_container" });
  assert.ok(cliKey.startsWith("sm_"));

  const ok = await req("/v1/whoami", { key: cliKey });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tenantId, "cli_tenant");
  assert.equal(ok.body.containerTag, "cli_container");

  const out = JSON.parse(runKeyCli(DIR, ["revoke", "--tenant", "cli_tenant", "--key", cliKey, "--json"]));
  assert.equal(out.ok, true);

  assert.equal((await req("/v1/whoami", { key: cliKey })).status, 401);
});

test("pre-existing (migrated) container data can be adopted by a new tenant key", async () => {
  // Simulate rows migrated from the JSON store: documents/memories exist but no
  // ownership row yet (the migration never invents tenants).
  const sqlite = require("../lib/storage/sqlite");
  const raw = sqlite.openDatabase(path.join(DIR, "recall.db"));
  try {
    sqlite.insertDocument(raw, {
      id: "legacy-doc",
      containerTag: "legacy_tag",
      content: "I have a cat named Pixel.",
      createdAt: new Date().toISOString(),
    });
    sqlite.insertMemory(raw, {
      id: "legacy-mem",
      documentId: "legacy-doc",
      containerTag: "legacy_tag",
      text: "I have a cat named Pixel.",
      type: "static",
      slot: "pet",
      slotValue: "Pixel",
      status: "active",
      createdAt: new Date().toISOString(),
    });
  } finally {
    raw.close();
  }

  // Adopting the tag via key creation grants ownership and access.
  const legacyKey = createKey(DIR, { tenant: "legacy_tenant", container: "legacy_tag" });
  const res = await req("/v1/profile?containerTag=legacy_tag", { key: legacyKey });
  assert.equal(res.status, 200);
  assert.ok(res.body.profile.static.some((f) => f.text.includes("Pixel")));

  // No other tenant can reach it.
  assert.equal((await req("/v1/profile?containerTag=legacy_tag", { key: keyB })).status, 403);
});

// ------------------------------------------------------------ durability ---

test("keys, ownership and isolated data survive reopening the database", async () => {
  const { create } = require("../lib/storage/sqlite");
  const store = create({ file: path.join(DIR, "recall.db") });
  try {
    assert.ok(store.getApiKeyByHash(hashApiKey(keyA)), "key persists");
    assert.ok(store.isContainerOwned("alpha", TENANT_A), "alpha owned by A");
    assert.ok(!store.isContainerOwned("alpha", TENANT_B), "alpha not owned by B");
    assert.ok(store.listMemories("alpha").length >= 1, "A's data persists");

    const betaDocs = store.listDocuments("beta");
    assert.ok(
      !betaDocs.some((d) => String(d.content).includes("backend engineer")),
      "B's container must not contain A's data"
    );
  } finally {
    store.close();
  }
});

// Stage 8: configuration validation.
//
// Every setting has a safe default; an explicitly-set invalid value fails fast at
// startup with the variable named, instead of being silently ignored.

const { test } = require("node:test");
const assert = require("node:assert");
const { readServerConfig, posIntEnv } = require("../lib/config");
const { readConfig: readDocConfig } = require("../lib/documents/config");

test("server config defaults are safe", () => {
  const c = readServerConfig({});
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 6767);
  assert.equal(c.authMode, "required");
  assert.equal(c.devTenant, "dev");
  assert.equal(c.devContainer, "dev");
  assert.equal(c.generalMax, 120);
  assert.equal(c.expensiveMax, 30);
  assert.deepEqual(c.corsOrigins, []);
});

test("explicit valid values are used and parsed as numbers", () => {
  const c = readServerConfig({
    HOST: "0.0.0.0",
    PORT: "7000",
    AUTH_MODE: "dev",
    RATE_LIMIT_PER_MIN: "10",
    RATE_LIMIT_EXPENSIVE_PER_MIN: "5",
    CORS_ORIGINS: "https://a.example.com, http://localhost:3000",
  });
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.port, 7000);
  assert.equal(c.authMode, "dev");
  assert.equal(c.generalMax, 10);
  assert.equal(c.expensiveMax, 5);
  assert.deepEqual(c.corsOrigins, ["https://a.example.com", "http://localhost:3000"]);
});

test("invalid server config fails fast with the variable named", () => {
  const cases = [
    [{ AUTH_MODE: "open" }, /AUTH_MODE/],
    [{ PORT: "abc" }, /PORT/],
    [{ PORT: "0" }, /PORT/],
    [{ PORT: "70000" }, /PORT/],
    [{ PORT: "6767.5" }, /PORT/],
    [{ RATE_LIMIT_PER_MIN: "-1" }, /RATE_LIMIT_PER_MIN/],
    [{ RATE_LIMIT_EXPENSIVE_PER_MIN: "many" }, /RATE_LIMIT_EXPENSIVE_PER_MIN/],
    [{ HOST: "http://x" }, /HOST/],
    [{ HOST: "a b" }, /HOST/],
    [{ HOST: "host/path" }, /HOST/],
    [{ CORS_ORIGINS: "*" }, /CORS_ORIGINS/],
    [{ CORS_ORIGINS: "https://a.example.com/path" }, /CORS_ORIGINS/],
  ];
  for (const [env, re] of cases) {
    assert.throws(() => readServerConfig(env), re, `expected ${JSON.stringify(env)} to throw`);
  }
});

test("empty/whitespace values fall back to the default rather than throwing", () => {
  const c = readServerConfig({ PORT: "", HOST: "  ", RATE_LIMIT_PER_MIN: "" });
  assert.equal(c.port, 6767);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.generalMax, 120);
});

test("AUTH_MODE=dev is refused in production only", () => {
  assert.throws(() => readServerConfig({ AUTH_MODE: "dev", NODE_ENV: "production" }), /production/);
  assert.equal(readServerConfig({ AUTH_MODE: "dev", NODE_ENV: "staging" }).authMode, "dev");
});

test("an IPv6 loopback host is accepted", () => {
  assert.equal(readServerConfig({ HOST: "::1" }).host, "::1");
});

test("posIntEnv accepts zero only when min allows it", () => {
  assert.equal(posIntEnv({ X: "0" }, "X", 5, { min: 0 }), 0);
  assert.throws(() => posIntEnv({ X: "0" }, "X", 5), /X/);
  assert.equal(posIntEnv({}, "X", 5), 5);
  assert.equal(posIntEnv({ X: " 7 " }, "X", 5), 7);
});

test("document limits default correctly and validate when set", () => {
  const d = readDocConfig({});
  assert.equal(d.maxUploadBytes, 10 * 1024 * 1024);
  assert.equal(d.maxPdfPages, 500);
  assert.equal(d.pdfTimeoutMs, 20000);
  assert.equal(d.pdfMaxConcurrent, 2);
  assert.equal(d.pdfMaxQueue, 64);
  assert.equal(d.pdfWorkerHeapMb, 0); // 0 is valid (Node default heap)
  assert.equal(d.chunkOverlap, 200);

  assert.equal(readDocConfig({ MAX_UPLOAD_BYTES: "1024" }).maxUploadBytes, 1024);
  assert.equal(readDocConfig({ PDF_WORKER_HEAP_MB: "0" }).pdfWorkerHeapMb, 0);
  assert.equal(readDocConfig({ CHUNK_OVERLAP: "0" }).chunkOverlap, 0);
});

test("invalid document limits fail fast with the variable named", () => {
  const positives = [
    "MAX_UPLOAD_BYTES",
    "MAX_PDF_PAGES",
    "PDF_EXTRACT_TIMEOUT_MS",
    "PDF_MAX_CONCURRENT",
    "PDF_MAX_QUEUE",
    "MAX_EXTRACTED_CHARS",
    "CHUNK_SIZE",
    "MAX_CHUNKS",
    "EMBED_BATCH_SIZE",
  ];
  for (const name of positives) {
    assert.throws(() => readDocConfig({ [name]: "nope" }), new RegExp(name), `${name} must validate text`);
    assert.throws(() => readDocConfig({ [name]: "0" }), new RegExp(name), `${name}=0 must be rejected`);
    assert.throws(() => readDocConfig({ [name]: "-3" }), new RegExp(name), `${name}<0 must be rejected`);
  }
  // Zero-allowed limits still reject negatives and non-numbers.
  assert.throws(() => readDocConfig({ PDF_WORKER_HEAP_MB: "-1" }), /PDF_WORKER_HEAP_MB/);
  assert.throws(() => readDocConfig({ CHUNK_OVERLAP: "x" }), /CHUNK_OVERLAP/);
});

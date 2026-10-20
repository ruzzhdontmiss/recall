// Regression coverage for slot extraction and supersession.
//
// Two user-visible bugs motivated these tests:
//   1. "I now work at Globex Inc." produced no employer slot, so the previous
//      employer stayed current and outranked the new one in search.
//   2. "My favorite database is ..." produced no slot at all, so an updated
//      preference left both values active and searchable ("simultaneously true").

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { mkTmp, rm } = require("./_support");
const { regexFacts } = require("../lib/extract/regex");

// ------------------------------------------------------------ unit: slots --
function oneFact(text) {
  const facts = regexFacts(text);
  assert.equal(facts.length, 1, `expected one sentence, got ${facts.length}`);
  return facts[0];
}

test("an employer update phrased 'I now work at ...' gets the employer slot", () => {
  const updated = oneFact("I now work at Globex Inc.");
  assert.equal(updated.type, "static");
  assert.equal(updated.slot, "employer");
  assert.equal(updated.slotValue, "Globex Inc");

  // The original phrasing is unchanged.
  const original = oneFact("I work at Acme Corp.");
  assert.equal(original.slot, "employer");
  assert.equal(original.slotValue, "Acme Corp");
});

test("favorite facts are keyed by the thing they describe", () => {
  const db = oneFact("My favorite database is PostgreSQL.");
  assert.equal(db.type, "static");
  assert.equal(db.slot, "favorite:database");
  assert.equal(db.slotValue, "PostgreSQL");

  const food = oneFact("My favorite food is pizza.");
  assert.equal(food.slot, "favorite:food");
  assert.equal(food.slotValue, "pizza");
});

// ------------------------------------------------------------- api: flow ---
const DIR = mkTmp("recall-slots-");
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf";
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";

const { app } = require("../server");
const db = require("../lib/db");
const { issueApiKey } = require("../lib/auth");

let server;
let base;
let KEY;

before(async () => {
  ({ key: KEY } = issueApiKey(db, { tenantId: "slots", containerTag: "slots" }));
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

async function json(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${KEY}`, ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function postAdd(content, containerTag) {
  return json("/v1/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, containerTag }),
  });
}

test("a new employer supersedes the old one in profile and search", async () => {
  await postAdd("I work at Acme Corp.", "employer_case");
  await postAdd("I now work at Globex Inc.", "employer_case");

  const profile = await json("/v1/profile?containerTag=employer_case");
  const texts = profile.body.profile.static.map((f) => f.text.toLowerCase());
  assert.ok(texts.some((t) => t.includes("globex")), "the new employer must be current");
  assert.ok(!texts.some((t) => t.includes("acme")), "the old employer must not be current");

  const all = await json("/v1/memories?containerTag=employer_case");
  const acme = all.body.memories.find((m) => /Acme/.test(m.text));
  const globex = all.body.memories.find((m) => /Globex/.test(m.text));
  assert.equal(acme.effectiveStatus, "superseded");
  assert.equal(globex.effectiveStatus, "active");

  // Search must not present the obsolete employer as a current fact.
  const search = await json("/v1/search?searchMode=memories&q=where+does+the+user+work&containerTag=employer_case");
  assert.equal(search.status, 200);
  assert.ok(!search.body.results.some((h) => /Acme/.test(h.text)), "Acme must not be retrievable");
});

test("a new favorite database supersedes only the old favorite database", async () => {
  await postAdd("My favorite database is PostgreSQL.", "favorite_case");
  await postAdd("My favorite food is pizza.", "favorite_case");
  await postAdd("My favorite database is SQLite.", "favorite_case");

  const all = await json("/v1/memories?containerTag=favorite_case");
  const pg = all.body.memories.find((m) => /PostgreSQL/.test(m.text));
  const sqlite = all.body.memories.find((m) => /SQLite/.test(m.text));
  const pizza = all.body.memories.find((m) => /pizza/.test(m.text));

  assert.equal(pg.effectiveStatus, "superseded", "the old favorite must be superseded");
  assert.equal(sqlite.effectiveStatus, "active");
  assert.equal(pizza.effectiveStatus, "active", "a different favorite thing must be untouched");

  const profile = await json("/v1/profile?containerTag=favorite_case");
  const texts = profile.body.profile.static.map((f) => f.text.toLowerCase());
  assert.ok(texts.some((t) => t.includes("sqlite")));
  assert.ok(!texts.some((t) => t.includes("postgresql")));
  assert.ok(texts.some((t) => t.includes("pizza")));

  const search = await json(
    "/v1/search?searchMode=memories&q=what+is+the+user%27s+favorite+database&containerTag=favorite_case"
  );
  assert.ok(!search.body.results.some((h) => /PostgreSQL/.test(h.text)));
});

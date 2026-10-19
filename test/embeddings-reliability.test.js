// Stage 6: embedding/search reliability re-audit.
//
// Findings fixed here:
//   A. A provider that could not be loaded made every search return HTTP 500
//      instead of degrading. Search must fall back to lexical.
//   B. A search response reported the *configured* provider even when ranking had
//      actually fallen back to lexical, so a lexical result could be mistaken for
//      a semantic one. Responses now carry an authoritative `ranking` field.
//   C. A row that could not be placed in the current space was silently dropped
//      while the response still claimed dense ranking. Ranking is now
//      all-or-nothing: any row without a usable current-space vector sends the
//      whole set to lexical, so content is never silently lost and spaces are
//      never mixed.
//
// The real ranking functions AND the real HTTP route are exercised, so either a
// regression to 500s or a false "dense" claim fails these tests.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { mkTmp, rm } = require("./_support");

const DIR = mkTmp("recall-rel-");
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf"; // lexical by default; env is switched per test
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";

const REPO = path.join(__dirname, "..");
const db = require("../lib/db");
const embeddings = require("../lib/embeddings");
const search = require("../lib/search");
const space = require("../lib/embeddings/space");
const { buildIndex } = require("../lib/tfidf");
const { app } = require("../server");
const { issueApiKey } = require("../lib/auth");

const NOW = "2024-01-01T00:00:00.000Z";
// cos([1,1,0],[1,0,0]) — what a wrongly-scored foreign vector would score.
const QVEC = [1, 0, 0];
const DENSE_LEAK = Math.SQRT1_2;

let server;
let base;
let KEY;

before(async () => {
  ({ key: KEY } = issueApiKey(db, { tenantId: "rel", containerTag: "rel" }));
  // A lexical document in the key's own container, so the HTTP search has
  // something to rank.
  db.addDocument({
    id: "rel-http-1",
    containerTag: "rel",
    content: "alpha memories live in the rel container",
    createdAt: NOW,
    embedding: null,
  });
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

function patchEmbeddings(overrides) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = embeddings[key];
    embeddings[key] = overrides[key];
  }
  return () => {
    for (const key of Object.keys(overrides)) embeddings[key] = saved[key];
  };
}

let seq = 0;
function seedDoc(tag, content, extra = {}) {
  const id = `rel-doc-${seq++}`;
  db.addDocument({ id, containerTag: tag, content, createdAt: NOW, embedding: null, ...extra });
  return db.listDocuments(tag).find((d) => d.id === id);
}

// Seed a row whose recorded metadata belongs to a DIFFERENT space than the local
// provider used at search time. The foreign provider/model is set explicitly (the
// env switch is unreliable once a real provider has already loaded for this
// process, because `activeDescribe()` then reports the loaded space).
function seedForeignDoc(tag, content, embedding = [1, 1, 0]) {
  const id = `rel-foreign-${seq++}`;
  db.addDocument(
    { id, containerTag: tag, content, createdAt: NOW, embedding },
    { provider: "openai", model: "text-embedding-3-small" }
  );
  return db.listDocuments(tag).find((d) => d.id === id);
}

// -------------------------------------------------------------- reporting --

test("rankingMode is 'none' until a real ranking happened", () => {
  assert.equal(search.rankingMode(undefined), "none");
  assert.equal(search.rankingMode(search.createRankingState()), "none");
});

test("a lexical provider reports ranking 'lexical' (never 'dense')", async () => {
  const tag = "rel-tfidf";
  const doc = seedDoc(tag, "alpha beta gamma");
  const state = search.createRankingState();
  const hits = await search.searchDocuments("alpha", [doc], state);
  assert.equal(hits.length, 1, "lexical retrieval finds the row");
  assert.equal(search.rankingMode(state), "lexical");
});

// ---------------------------------------------------------- degradation ----

test("a provider that cannot load degrades to lexical instead of failing", async () => {
  const tag = "rel-down";
  const doc = seedDoc(tag, "alpha beta gamma");
  const mem = {
    id: "rel-mem-down",
    text: "alpha delta",
    type: "note",
    createdAt: NOW,
  };
  const restore = patchEmbeddings({
    getImpl: async () => {
      throw new Error("provider down");
    },
    isDense: () => true,
    embed: async () => {
      throw new Error("provider down");
    },
  });
  try {
    const state = search.createRankingState();
    const hits = await search.searchDocuments("alpha", [doc], state);
    assert.equal(hits.length, 1, "search must still return a lexical result, not throw");
    assert.equal(search.rankingMode(state), "lexical");

    const state2 = search.createRankingState();
    const memHits = await search.searchMemories("alpha", [mem], state2);
    assert.equal(memHits.length, 1);
    assert.equal(search.rankingMode(state2), "lexical");
  } finally {
    restore();
  }
});

test("an unembeddable query degrades to lexical rather than an empty result", async () => {
  const tag = "rel-qfail";
  const doc = seedDoc(tag, "alpha beta");
  const restore = patchEmbeddings({
    getImpl: async () => ({ kind: "xenova" }),
    isDense: () => true,
    embed: async (text, opts) => {
      if (opts && opts.isQuery) throw new Error("query embed down");
      return [1, 0, 0];
    },
  });
  try {
    const state = search.createRankingState();
    const hits = await search.searchDocuments("alpha", [doc], state);
    assert.equal(hits.length, 1, "a failed query embedding must not hide the content");
    assert.equal(search.rankingMode(state), "lexical");
  } finally {
    restore();
  }
});

// -------------------------------------------------------- all-or-nothing ---

test("a row that cannot be placed in the current space sends the WHOLE set to lexical", async () => {
  const tag = "rel-mixed";
  // One row is already in the current (tfidf) space and would score 1.0 densely.
  const good = seedDoc(tag, "alpha beta gamma", { embedding: [1, 0, 0] });
  // The other is foreign and cannot be re-embedded.
  const foreign = seedForeignDoc(tag, "alpha omega");

  const restore = patchEmbeddings({
    getImpl: async () => ({ kind: "xenova" }),
    isDense: () => true,
    embed: async (text, opts) => {
      if (opts && opts.isQuery) return QVEC;
      throw new Error("provider down");
    },
  });
  try {
    const state = search.createRankingState();
    const hits = await search.searchDocuments("alpha", [good, foreign], state);
    // All-or-nothing: the current-space row is NOT scored densely alongside a
    // foreign sibling, so dense scoring (score ~1.0) must not appear.
    assert.ok(
      !hits.some((h) => h.score > 0.99),
      "no row may be dense-scored when a sibling is not in the current space"
    );
    assert.ok(
      !hits.some((h) => Math.abs(h.score - DENSE_LEAK) < 1e-9),
      "the foreign vector must never receive a dense score"
    );
    // Both rows stay retrievable via lexical ranking.
    assert.equal(hits.length, 2, "both rows must remain retrievable");
    const expected = buildIndex([
      { id: good.id, text: good.content },
      { id: foreign.id, text: foreign.content },
    ])
      .score("alpha")
      .find((r) => r.id === good.id);
    const goodHit = hits.find((h) => h.id === good.id);
    assert.ok(
      Math.abs(goodHit.score - Number(expected.score.toFixed(4))) < 1e-9,
      "score must be the (rounded) lexical score"
    );
    assert.equal(search.rankingMode(state), "lexical");
  } finally {
    restore();
  }
});

test("a fully current-space corpus still ranks densely", async () => {
  const tag = "rel-dense";
  const doc = seedDoc(tag, "alpha beta gamma");
  const restore = patchEmbeddings({
    getImpl: async () => ({ kind: "xenova" }),
    isDense: () => true,
    embed: async () => [1, 0, 0],
  });
  try {
    const state = search.createRankingState();
    const hits = await search.searchDocuments("alpha", [doc], state);
    assert.equal(hits.length, 1);
    assert.ok(hits[0].score > 0.99, "identical vectors must score ~1");
    assert.equal(search.rankingMode(state), "dense");
  } finally {
    restore();
  }
});

// -------------------------------------------------- vectors / dimensions ---

test("empty, non-finite and dimension-mismatched vectors are never reused", () => {
  const want = { provider: "openai", model: "text-embedding-3-small" };
  const base = { embeddingProvider: "openai", embeddingModel: "text-embedding-3-small" };

  assert.equal(space.isUsableVector([]), false);
  assert.equal(space.isUsableVector([1, NaN]), false);
  assert.equal(space.isUsableVector([1, Infinity]), false);
  assert.equal(space.isUsableVector(["1", 2]), false);
  assert.equal(space.isUsableVector([1, 2, 3]), true);

  assert.equal(space.matches({ ...base, embedding: [], embeddingDim: 0 }, want), false);
  assert.equal(
    space.matches({ ...base, embedding: [1, 2, 3], embeddingDim: 768 }, want),
    false,
    "a recorded dimension that disagrees with the vector length is foreign"
  );
  assert.equal(
    space.matches({ ...base, embedding: [1, 2, 3] }, want),
    true,
    "matching provider/model and a usable vector is reusable"
  );
  assert.equal(
    space.matches({ ...base, embedding: [1, 2, 3], embeddingProvider: "xenova" }, want),
    false,
    "a different provider is foreign"
  );
});

// ----------------------------------------------------------- HTTP route ----

test("GET /v1/search still works and reports the effective ranking", async () => {
  const res = await fetch(base + "/v1/search?containerTag=rel&q=alpha", {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ranking, "lexical", "tfidf provider must report lexical ranking");
  assert.ok(Array.isArray(body.results) && body.results.length >= 1, "the document must be found");
});

test("a search with no matches still reports the ranking that ran", async () => {
  const res = await fetch(base + "/v1/search?containerTag=rel&q=zzzznotpresent", {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 0);
  assert.equal(body.ranking, "lexical", "the corpus was ranked lexically even though nothing matched");
});

test("ranking an empty candidate set reports 'none', not a ranking that never ran", async () => {
  const state = search.createRankingState();
  const hits = await search.searchDocuments("alpha", [], state);
  assert.equal(hits.length, 0);
  assert.equal(search.rankingMode(state), "none");
});

function allKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      allKeys(child, out);
    }
  }
  return out;
}

const INTERNAL_KEYS = ["embedding", "storageKey", "embeddingProvider", "embeddingModel", "embeddingDim"];

test("the search response leaks no vectors or internal metadata", async () => {
  const res = await fetch(base + "/v1/search?containerTag=rel&q=alpha", {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const body = await res.json();
  const keys = allKeys(body);
  for (const forbidden of INTERNAL_KEYS) {
    assert.ok(!keys.includes(forbidden), `response must not contain a "${forbidden}" field`);
  }
});

test("a provider that cannot load no longer turns search into a 500", () => {
  const script = path.join(__dirname, "fixtures", "reliability-degraded-http.js");
  const res = spawnSync(process.execPath, [script], {
    cwd: REPO,
    encoding: "utf-8",
    env: {
      ...process.env,
      DATA_DIR: mkTmp("recall-deg-"),
      STORAGE_BACKEND: "sqlite",
      EMBEDDINGS_PROVIDER: "openai",
      EMBEDDINGS_MODEL: undefined,
      OPENAI_API_KEY: undefined,
      EXTRACTION_PROVIDER: "regex",
      AUTH_MODE: "required",
    },
  });
  const line = (res.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `no RESULT from child: ${res.stdout}\n${res.stderr}`);
  const { status, body } = JSON.parse(line.slice("RESULT ".length));
  assert.equal(status, 200, "search must degrade, not fail");
  const parsed = JSON.parse(body);
  assert.equal(parsed.ranking, "lexical");
  assert.equal(parsed.embeddingsProvider, "uninitialized");
  assert.ok(parsed.results.length >= 1, "the lexical content must still be retrievable");
  const keys = allKeys(parsed);
  for (const forbidden of INTERNAL_KEYS) {
    assert.ok(!keys.includes(forbidden), `response must not contain a "${forbidden}" field`);
  }
});

// --------------------------------------------------------- JSON backend ----

test("the legacy JSON backend degrades and reports identically", () => {
  const script = path.join(__dirname, "fixtures", "reliability-json-backend.js");
  const res = spawnSync(process.execPath, [script], {
    cwd: REPO,
    encoding: "utf-8",
    env: {
      ...process.env,
      DATA_DIR: mkTmp("recall-json-rel-"),
      STORAGE_BACKEND: "json",
      EMBEDDINGS_PROVIDER: "tfidf",
      EXTRACTION_PROVIDER: "regex",
    },
  });
  const line = (res.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `no RESULT from child: ${res.stdout}\n${res.stderr}`);
  const out = JSON.parse(line.slice("RESULT ".length));
  assert.equal(out.hits, 1, "JSON backend must still retrieve the row");
  assert.equal(out.ranking, "lexical");
});

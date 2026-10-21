const { test, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { mkTmp, rm } = require("./_support");

const DIR = mkTmp();
process.env.DATA_DIR = DIR;
process.env.STORAGE_BACKEND = "sqlite";
process.env.EMBEDDINGS_PROVIDER = "tfidf"; // no model loading in this file
process.env.EXTRACTION_PROVIDER = "regex";
process.env.AUTH_MODE = "required";

const embeddings = require("../lib/embeddings");
const space = require("../lib/embeddings/space");
const jsonStore = require("../lib/storage/json");
const db = require("../lib/db");
const backfill = require("../scripts/backfill-embeddings");

after(() => {
  db.close();
  rm(DIR);
});

function withEnv(patch, fn) {
  const prev = {};
  for (const k of Object.keys(patch)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("space.matches requires positive proof of compatibility", () => {
  const want = { provider: "xenova", model: "m@q8~r2" };
  const ok = { embedding: [1, 0], embeddingProvider: "xenova", embeddingModel: "m@q8~r2", embeddingDim: 2 };
  assert.equal(space.matches(ok, want), true);
  assert.equal(
    space.matches({ ...ok, embeddingModel: "m" }, want),
    false,
    "an older model/space id must not match"
  );
  assert.equal(space.matches({ ...ok, embeddingProvider: "openai" }, want), false, "provider must match");
  assert.equal(space.matches({ embedding: [1, 0] }, want), false, "missing metadata is not proof");
  assert.equal(space.matches({ ...ok, embedding: null }, want), false, "no vector");
  assert.equal(space.matches({ ...ok, embedding: [] }, want), false, "empty vector");
  assert.equal(space.matches({ ...ok, embedding: [1, NaN] }, want), false, "non-finite is unusable");
  assert.equal(space.matches({ ...ok, embedding: [1, "x"] }, want), false, "non-number is unusable");
  assert.equal(space.matches({ ...ok, embeddingDim: 3 }, want), false, "dim mismatch");
  assert.equal(space.matches(ok, null), false);
  assert.equal(space.matches(null, want), false);
});

test("local space identity encodes precision + stack revision + runtime versions", () => {
  withEnv({ EMBEDDINGS_PROVIDER: "xenova", EMBEDDINGS_DTYPE: undefined }, () => {
    const d = embeddings.describe();
    assert.equal(d.provider, "xenova");
    assert.match(
      d.model,
      /^Xenova\/bge-base-en-v1\.5@q8~r\d+\+tf(\d+\.\d+\.\d+|\?)\+ort(\d+\.\d+\.\d+|\?)$/
    );
    assert.equal(d.space, `xenova:${d.model}`);
    assert.equal(embeddings.space(), d.space);
  });

  withEnv({ EMBEDDINGS_PROVIDER: "xenova", EMBEDDINGS_DTYPE: "fp32" }, () => {
    const d = embeddings.describe();
    assert.match(d.model, /@fp32~r\d+\+tf/);
    assert.notEqual(d.model, "Xenova/bge-base-en-v1.5@q8~r2", "a dtype change must change the space");
  });
});

test("local space identity changes when the runtime versions or revision change", () => {
  const base = { base: "Xenova/bge-base-en-v1.5", dtype: "q8", revision: 2 };
  const fp = (transformers, onnxruntime) => ({ transformers, onnxruntime });
  const a = space.localSpaceModel({ ...base, fingerprint: fp("4.3.1", "1.30.0") });
  const b = space.localSpaceModel({ ...base, fingerprint: fp("4.4.0", "1.30.0") });
  const c = space.localSpaceModel({ ...base, fingerprint: fp("4.3.1", "1.31.0") });
  const d = space.localSpaceModel({ ...base, revision: 3, fingerprint: fp("4.3.1", "1.30.0") });
  const e = space.localSpaceModel({ ...base, dtype: "fp32", fingerprint: fp("4.3.1", "1.30.0") });
  const f = space.localSpaceModel({ ...base, fingerprint: fp(null, null) });
  assert.equal(
    new Set([a, b, c, d, e, f]).size,
    6,
    "each version/revision/dtype change must produce a distinct space identity"
  );
  assert.notEqual(a, b, "a transformers version change must change the space");
  assert.notEqual(a, c, "an onnxruntime version change must change the space");
  assert.notEqual(a, d, "a stack revision bump must change the space");
});

test("tfidf reports a lexical space", () => {
  withEnv({ EMBEDDINGS_PROVIDER: "tfidf" }, () => {
    assert.deepEqual(embeddings.describe(), { provider: "tfidf", model: null, space: "tfidf" });
  });
});

test("public projections never expose embedding metadata", () => {
  const doc = {
    id: "d1",
    containerTag: "t",
    content: "x",
    createdAt: "2024-01-01T00:00:00.000Z",
    embedding: [1, 2],
    embeddingProvider: "xenova",
    embeddingModel: "m@q8~r2",
    embeddingDim: 2,
    storageKey: "rel/path",
  };
  const pub = db.publicDocument(doc);
  for (const key of ["embedding", "embeddingProvider", "embeddingModel", "embeddingDim", "storageKey"]) {
    assert.ok(!(key in pub), `${key} must not be exposed`);
  }
  assert.equal(pub.id, "d1");

  const pubMem = db.publicMemory({ ...doc, id: "m1", text: "x" });
  for (const key of ["embedding", "embeddingProvider", "embeddingModel", "embeddingDim"]) {
    assert.ok(!(key in pubMem), `${key} must not be exposed`);
  }
});

test("sqlite: meta bookkeeping round-trips", () => {
  assert.equal(db.getMeta("embedding_space"), null);
  db.setMeta("embedding_space", "xenova:m@q8~r2");
  assert.equal(db.getMeta("embedding_space"), "xenova:m@q8~r2");
  db.setMeta("embedding_space", "xenova:other@q8~r2");
  assert.equal(db.getMeta("embedding_space"), "xenova:other@q8~r2");
});

test("sqlite: rows carry the producing space and become stale after a change", () => {
  withEnv({ EMBEDDINGS_PROVIDER: "xenova", EMBEDDINGS_DTYPE: undefined }, () => {
    db.addDocument({
      id: "space-doc",
      containerTag: "space-t",
      content: "hello world",
      createdAt: "2024-01-01T00:00:00.000Z",
      embedding: [1, 0],
    });
    const want = embeddings.describe();
    const got = db.getDocument("space-doc", "space-t");
    assert.equal(got.embeddingProvider, want.provider);
    assert.equal(got.embeddingModel, want.model);
    assert.equal(got.embeddingDim, 2);
    assert.equal(space.matches(got, want), true, "freshly stamped vector must match");

    // A precision change is a different space: the stored vector must not be reused.
    process.env.EMBEDDINGS_DTYPE = "fp32";
    assert.equal(space.matches(got, embeddings.describe()), false);
    delete process.env.EMBEDDINGS_DTYPE;
  });
});

test("json backend: meta + embedding metadata parity with sqlite", (t) => {
  const dir = mkTmp();
  const store = jsonStore.create({ file: path.join(dir, "store.json") });
  t.after(() => rm(dir));
  assert.equal(store.getMeta("embedding_space"), null);
  store.setMeta("embedding_space", "json:m@q8~r2");
  assert.equal(store.getMeta("embedding_space"), "json:m@q8~r2");

  store.addDocument({
    id: "jd",
    containerTag: "jt",
    content: "x",
    createdAt: "2024-01-01T00:00:00.000Z",
    embedding: [1, 2, 3],
  });
  assert.equal(store.documents[0].embeddingDim, 3);
  assert.equal(store.documents[0].embeddingModel, null); // tfidf provider in this process
  store.updateEmbedding("document", "jd", [4, 5]);
  assert.equal(store.documents[0].embeddingDim, 2);
  store.close();
});

test("backfill countStale counts foreign and missing vectors", () => {
  const want = { provider: "xenova", model: "m@q8~r2" };
  const rows = [
    { row: { embedding: [1], embeddingProvider: "xenova", embeddingModel: "m@q8~r2" } },
    { row: { embedding: [1], embeddingProvider: "xenova", embeddingModel: "m" } },
    { row: { embedding: null } },
  ];
  assert.equal(backfill.countStale(rows, want), 2);
});

test("a failed local provider reports the lexical active space, not the configured dense one", () => {
  // Isolated child process: force xenova to fail (offline + missing model) and
  // prove the persisted-space signal (activeSpace/activeDescribe) reflects the
  // lexical fallback, so startup bookkeeping cannot record a dense space for a
  // run that is really lexical. describe() may still report the configured space.
  const { spawnSync } = require("node:child_process");
  const script = [
    'const e = require("./lib/embeddings");',
    "e.getImpl().then(() => {",
    '  process.stdout.write("RESULT " + JSON.stringify({',
    "    providerName: e.getProviderName(),",
    "    isDense: e.isDense(),",
    "    describeSpace: e.describe().space,",
    "    activeDescribeSpace: e.activeDescribe().space,",
    "    activeSpace: e.activeSpace(),",
    '  }) + "\\n");',
    "}).catch((err) => { console.error(err.message); process.exit(1); });",
  ].join("\n");

  const res = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      EMBEDDINGS_PROVIDER: "xenova",
      EMBEDDINGS_OFFLINE: "true",
      EMBEDDINGS_MODEL: "Xenova/does-not-exist-xyz",
    },
    encoding: "utf-8",
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `child produced no RESULT line: ${res.stdout}`);
  const out = JSON.parse(line.slice("RESULT ".length));

  assert.equal(out.providerName, "tfidf", "the local provider must have failed over");
  assert.equal(out.isDense, false);
  assert.equal(out.activeSpace, "tfidf", "the active space must be lexical");
  assert.equal(out.activeDescribeSpace, "tfidf");
  assert.match(out.describeSpace, /^xenova:/, "describe() still reports the configured space");
  assert.notEqual(out.describeSpace, out.activeSpace);
});

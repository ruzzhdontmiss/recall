const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("node:child_process");
const sqlite = require("../lib/storage/sqlite");
const { mkTmp, rm } = require("./_support");

const CLI = path.join(__dirname, "..", "scripts", "db-migrate-json.js");

function setup(t) {
  const dir = mkTmp();
  t.after(() => rm(dir));
  return {
    dir,
    jsonPath: path.join(dir, "store.json"),
    dbPath: path.join(dir, "recall.db"),
    writeStore(store) {
      fs.writeFileSync(this.jsonPath, JSON.stringify(store, null, 2));
    },
  };
}

function runCli(dir, extra = []) {
  return spawnSync(process.execPath, [CLI, ...extra], {
    env: { ...process.env, DATA_DIR: dir },
    encoding: "utf8",
  });
}

function readTarget(dbPath) {
  const db = sqlite.openDatabase(dbPath);
  const docs = db.prepare("SELECT * FROM documents").all().map(sqlite.rowToDocument);
  const mems = db.prepare("SELECT * FROM memories").all().map(sqlite.rowToMemory);
  db.close();
  return { docs, mems };
}

const RICH = {
  documents: [
    {
      id: "doc-α", // unicode id
      containerTag: "user_né",
      content: "I live in São Paulo. ☕",
      createdAt: "2024-03-01T10:00:00.000Z",
      embedding: null, // null embedding must be preserved
    },
    {
      id: "doc-2",
      containerTag: "user_né",
      content: "I prefer Rust",
      createdAt: "2024-03-02T10:00:00.000Z",
      embedding: [0.1, 0.2, 0.3],
    },
  ],
  memories: [
    {
      id: "m-active",
      documentId: "doc-α",
      containerTag: "user_né",
      text: "Lives in São Paulo",
      type: "static",
      slot: "location",
      slotValue: "São Paulo",
      status: "active",
      createdAt: "2024-03-01T10:00:00.000Z",
      expiresAt: null,
      supersedes: null,
      extractedBy: "regex",
      embedding: [1, 2, 3, 4],
    },
    {
      id: "m-superseded",
      documentId: "doc-α",
      containerTag: "user_né",
      text: "Lived in Berlin",
      type: "static",
      slot: "location",
      slotValue: "Berlin",
      status: "superseded",
      createdAt: "2024-02-01T10:00:00.000Z",
      expiresAt: null,
      supersededAt: "2024-03-01T10:00:00.000Z",
      supersedes: null,
      extractedBy: "regex",
      embedding: null,
    },
    {
      id: "m-forgotten",
      documentId: "doc-2",
      containerTag: "user_né",
      text: "Secret",
      type: "note",
      slot: null,
      slotValue: null,
      status: "forgotten",
      createdAt: "2024-03-02T10:00:00.000Z",
      expiresAt: null,
      supersedes: null,
      extractedBy: "regex",
      embedding: null,
    },
    {
      // minimal object: several optional fields omitted entirely
      id: "m-dynamic",
      documentId: "doc-2",
      containerTag: "user_né",
      text: "Shipping soon",
      type: "dynamic",
      status: "active",
      createdAt: "2024-03-02T10:00:00.000Z",
      expiresAt: "2024-09-01T00:00:00.000Z",
    },
  ],
};

test("dry-run writes nothing and reports counts", (t) => {
  const s = setup(t);
  s.writeStore(RICH);
  const res = runCli(s.dir, ["--dry-run"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN/);
  assert.match(res.stdout, /would migrate 2 documents and 4 memories/);
  assert.ok(!fs.existsSync(s.dbPath), "no database should be created in dry-run");
});

test("migrates a rich store losslessly and verifies", (t) => {
  const s = setup(t);
  s.writeStore(RICH);
  const res = runCli(s.dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /VERIFIED/);

  const { docs, mems } = readTarget(s.dbPath);
  assert.equal(docs.length, 2);
  assert.equal(mems.length, 4);

  const unicode = docs.find((d) => d.id === "doc-α");
  assert.equal(unicode.content, "I live in São Paulo. ☕");
  assert.equal(unicode.containerTag, "user_né");
  assert.equal(unicode.embedding, null);

  const active = mems.find((m) => m.id === "m-active");
  assert.deepEqual(active.embedding, [1, 2, 3, 4]);
  assert.equal(active.slotValue, "São Paulo");

  const superseded = mems.find((m) => m.id === "m-superseded");
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersededAt, "2024-03-01T10:00:00.000Z");

  assert.equal(mems.find((m) => m.id === "m-forgotten").status, "forgotten");
  const dyn = mems.find((m) => m.id === "m-dynamic");
  assert.equal(dyn.type, "dynamic");
  assert.equal(dyn.expiresAt, "2024-09-01T00:00:00.000Z");
  assert.equal(dyn.slot, null);
});

test("rerun is idempotent and inserts nothing new", (t) => {
  const s = setup(t);
  s.writeStore(RICH);
  assert.equal(runCli(s.dir).status, 0);
  const second = runCli(s.dir);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /inserted documents=0 skipped=2/);
  assert.match(second.stdout, /memories inserted=0 skipped=4/);
  const { docs, mems } = readTarget(s.dbPath);
  assert.equal(docs.length, 2);
  assert.equal(mems.length, 4);
});

test("source JSON is never deleted and a backup is created", (t) => {
  const s = setup(t);
  s.writeStore(RICH);
  assert.equal(runCli(s.dir).status, 0);
  assert.ok(fs.existsSync(s.jsonPath), "source JSON must remain");
  const backups = fs.readdirSync(path.join(s.dir, "backups"));
  assert.ok(backups.length >= 1, "a backup of the source should exist");
  const backup = JSON.parse(fs.readFileSync(path.join(s.dir, "backups", backups[0]), "utf8"));
  assert.equal(backup.documents.length, 2);
});

test("empty store migrates cleanly", (t) => {
  const s = setup(t);
  s.writeStore({ documents: [], memories: [] });
  const res = runCli(s.dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readTarget(s.dbPath).docs.length, 0);
});

test("missing source is reported, not treated as corrupt", (t) => {
  const s = setup(t);
  const res = runCli(s.dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no source JSON store found/);
});

test("corrupt JSON is refused and never treated as empty", (t) => {
  const s = setup(t);
  fs.writeFileSync(s.jsonPath, "{ this is not json ");
  const res = runCli(s.dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /corrupt/);
  assert.ok(fs.existsSync(s.jsonPath), "corrupt source must be left untouched");
  assert.ok(!fs.existsSync(s.dbPath), "no database should be written on failure");
});

test("duplicate ids are reported and block migration", (t) => {
  const s = setup(t);
  s.writeStore({
    documents: [
      { id: "dup", containerTag: "u", content: "a", createdAt: "2024-01-01T00:00:00.000Z", embedding: null },
      { id: "dup", containerTag: "u", content: "b", createdAt: "2024-01-01T00:00:00.000Z", embedding: null },
    ],
    memories: [],
  });
  const res = runCli(s.dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /duplicate id/);
});

test("orphan memories are reported and block migration", (t) => {
  const s = setup(t);
  s.writeStore({
    documents: [],
    memories: [
      { id: "m", documentId: "missing", containerTag: "u", text: "x", type: "note", status: "active", createdAt: "2024-01-01T00:00:00.000Z" },
    ],
  });
  const res = runCli(s.dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /orphan/);
});

test("malformed embedding values are reported", (t) => {
  const s = setup(t);
  s.writeStore({
    documents: [
      { id: "d", containerTag: "u", content: "a", createdAt: "2024-01-01T00:00:00.000Z", embedding: ["nope"] },
    ],
    memories: [],
  });
  const res = runCli(s.dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /finite/);
});

test("migration does not print private memory content", (t) => {
  const s = setup(t);
  s.writeStore({
    documents: [{ id: "d", containerTag: "u", content: "TOP_SECRET_DOC_BODY", createdAt: "2024-01-01T00:00:00.000Z", embedding: null }],
    memories: [
      { id: "m", documentId: "d", containerTag: "u", text: "TOP_SECRET_MEMORY_BODY", type: "static", status: "active", createdAt: "2024-01-01T00:00:00.000Z", embedding: null },
    ],
  });
  const res = runCli(s.dir);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!res.stdout.includes("TOP_SECRET"), "stdout must not leak content");
  assert.ok(!res.stderr.includes("TOP_SECRET"), "stderr must not leak content");
});

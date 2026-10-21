// Stage 4: the administration CLI drives the real HTTP API end to end.
//
// A real server process is started in dev-auth mode (no key needed) and every CLI
// command is exercised against it, including the destructive-confirmation and
// non-zero-exit contracts.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("node:child_process");
const { mkTmp, rm, freePort, waitReady } = require("./_support");

const REPO = path.join(__dirname, "..");
const CLI = path.join(REPO, "scripts", "recall-cli.js");

let dir;
let server;
let base;

before(async () => {
  dir = mkTmp("recall-cli-");
  const port = await freePort();
  server = spawn(process.execPath, ["server.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: String(port),
      STORAGE_BACKEND: "sqlite",
      EMBEDDINGS_PROVIDER: "tfidf",
      EXTRACTION_PROVIDER: "regex",
      AUTH_MODE: "dev",
      DEV_TENANT: "cli_tenant",
      DEV_CONTAINER: "cli_space",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitReady(port);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) server.kill("SIGKILL");
  rm(dir);
});

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, RECALL_URL: base },
    encoding: "utf-8",
  });
}

test("whoami reports the dev identity", () => {
  const res = cli(["whoami"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /cli_tenant/);
  assert.match(res.stdout, /cli_space/);
});

test("add -> memories -> search -> profile round-trips", () => {
  const add = cli(["add", "I am a backend engineer who uses Neovim."]);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /added document/);

  const memories = cli(["memories"]);
  assert.equal(memories.status, 0, memories.stderr);
  assert.match(memories.stdout, /Neovim|backend/i);

  const search = cli(["search", "backend engineer"]);
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, /mode: hybrid/);
  assert.match(search.stdout, /backend engineer/i);

  const profile = cli(["profile"]);
  assert.equal(profile.status, 0, profile.stderr);
  assert.match(profile.stdout, /static:/);
});

test("add --file reads content from disk", () => {
  const file = path.join(dir, "note.txt");
  fs.writeFileSync(file, "I keep a garden with tomatoes and basil.");
  const res = cli(["add", "--file", file]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /added document/);
});

test("upload -> documents -> document -> delete round-trips", () => {
  const file = path.join(dir, "report.txt");
  fs.writeFileSync(file, "Quarterly numbers about falcons and revenue growth.");

  const up = cli(["upload", file, "--json"]);
  assert.equal(up.status, 0, up.stderr);
  const upJson = JSON.parse(up.stdout);
  assert.equal(upJson.document.status, "ready");
  const docId = upJson.document.id;
  assert.ok(docId);

  const list = cli(["documents"]);
  assert.equal(list.status, 0);
  assert.match(list.stdout, new RegExp(docId));

  const one = cli(["document", docId]);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /report\.txt/);
  assert.match(one.stdout, /chunks:/);

  // Destructive delete requires confirmation.
  const refused = cli(["delete", docId]);
  assert.equal(refused.status, 2, "missing --yes must be a non-zero exit");
  assert.match(refused.stdout, /refusing to delete/);
  assert.equal(cli(["document", docId]).status, 0, "document must still exist");

  const deleted = cli(["delete", docId, "--yes"]);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(cli(["document", docId]).status, 1, "deleted document is now a 404");
});

test("a failed PDF upload exits non-zero", () => {
  const file = path.join(dir, "broken.pdf");
  fs.writeFileSync(file, "%PDF-1.4 not really a pdf");
  const res = cli(["upload", file]);
  assert.equal(res.status, 1, "a failed ingestion must be a non-zero exit");
  assert.match(res.stdout + res.stderr, /ingestion failed|failed/i);
});

test("forget requires --yes and then removes the memory", () => {
  cli(["add", "I live in Reykjavik and own a kayak."]);
  const json = cli(["memories", "--json"]);
  assert.equal(json.status, 0);
  const memories = JSON.parse(json.stdout).memories;
  const target = memories.find((m) => /kayak|Reykjavik/i.test(m.text));
  assert.ok(target, "the added memory should be present");

  const refused = cli(["forget", target.id]);
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, /refusing to forget/);

  const done = cli(["forget", target.id, "--yes"]);
  assert.equal(done.status, 0, done.stderr);

  const after = JSON.parse(cli(["memories", "--json"]).stdout).memories;
  const found = after.find((m) => m.id === target.id);
  assert.equal(found.effectiveStatus, "forgotten");
});

test("unknown command and unknown option exit 2 with usage", () => {
  const bad = cli(["frobnicate"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown command/);
  const badOpt = cli(["whoami", "--wat"]);
  assert.equal(badOpt.status, 2);
  assert.match(badOpt.stderr, /unknown option/);
});

test("a connection error is reported with a non-zero exit", () => {
  const res = spawnSync(process.execPath, [CLI, "whoami"], {
    cwd: REPO,
    env: { ...process.env, RECALL_URL: "http://127.0.0.1:1" },
    encoding: "utf-8",
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /\[recall\]/);
});

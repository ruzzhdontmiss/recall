#!/usr/bin/env node
// Recall administration CLI.
//
// Talks to a *running* Recall server over HTTP (so it works against a local or
// private remote instance) using an API key. Intended for routine administration
// from a terminal or a script.
//
//   node scripts/recall-cli.js <command> [args] [options]
//
// Destructive commands (`forget`, `delete`) require an explicit --yes and exit
// non-zero without it. Failed operations (bad input, HTTP errors, a failed
// ingestion) exit non-zero so scripts can detect them.

const fs = require("fs");
const path = require("path");
const { UPLOAD_TYPES, extensionOf } = require("../lib/validate");

const DEFAULT_URL = "http://127.0.0.1:6767";
const VALUE_FLAGS = new Set(["container", "key", "url", "mode", "file", "limit"]);

function parseArgs(argv) {
  const opts = { _: [], json: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!VALUE_FLAGS.has(name)) throw new Error(`unknown option: ${a}`);
      const value = argv[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      opts[name] = value;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function usage() {
  return [
    "Usage: node scripts/recall-cli.js <command> [args] [options]",
    "",
    "Commands:",
    "  whoami                 Show the key's tenant and default container.",
    "  containers             List containers owned by this tenant.",
    "  add <text…>            Store content (also: --file <path>).",
    "  search <query>         Search (--mode hybrid|memories|documents).",
    "  memories               List memories (including forgotten/superseded).",
    "  forget <memoryId>      Forget one memory (requires --yes).",
    "  profile                Show the static + dynamic profile.",
    "  documents              List documents (including failed uploads).",
    "  document <id>          Show one document and its chunks.",
    "  upload <path>          Upload a .txt / .md / .pdf file.",
    "  delete <documentId>    Delete a document (requires --yes).",
    "",
    "Options:",
    "  --container <tag>      Target container (default: the key's container).",
    "  --key <key>            API key (default: RECALL_API_KEY).",
    "  --url <base>           Server base URL (default: RECALL_URL or " + DEFAULT_URL + ").",
    "  --mode <mode>          Search mode: hybrid | memories | documents.",
    "  --file <path>          Read add content from a file.",
    "  --limit <n>            Max rows to print for list commands (default 20).",
    "  --json                 Print the raw JSON response.",
    "  --yes                  Confirm a destructive operation.",
  ].join("\n");
}

function makeClient(opts, env) {
  const base = (opts.url || env.RECALL_URL || DEFAULT_URL).replace(/\/+$/, "");
  const key = opts.key || env.RECALL_API_KEY || "";

  async function request(method, pathname, { body, headers } = {}) {
    const h = { ...(headers || {}) };
    if (key) h.Authorization = `Bearer ${key}`;
    const res = await fetch(base + pathname, { method, headers: h, body });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const message = (parsed && parsed.error) || res.statusText || "request failed";
      const err = new Error(`HTTP ${res.status} — ${message}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  return { base, key, request };
}

const oneLine = (s, n = 120) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

function containerQuery(opts, extra = {}) {
  const params = new URLSearchParams(extra);
  if (opts.container) params.set("containerTag", opts.container);
  const s = params.toString();
  return s ? `?${s}` : "";
}

const limitOf = (opts) => {
  const n = Number.parseInt(opts.limit, 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
};

// ------------------------------------------------------------- commands -----

const commands = {
  async whoami({ request, opts, print }) {
    const me = await request("GET", "/v1/whoami");
    if (opts.json) return print(me);
    print(`tenant:    ${me.tenantId}`);
    print(`container: ${me.containerTag}`);
    print(`authMode:  ${me.authMode}`);
  },

  async containers({ request, opts, print }) {
    const { containerTags } = await request("GET", "/v1/containers");
    if (opts.json) return print({ containerTags });
    if (!containerTags.length) return print("(no containers)");
    for (const tag of containerTags) print(tag);
  },

  async add({ request, opts, args, print }) {
    let content = args.join(" ").trim();
    if (opts.file) content = fs.readFileSync(opts.file, "utf-8");
    if (!content) throw new Error("nothing to add: pass text or --file <path>");
    const payload = { content };
    if (opts.container) payload.containerTag = opts.container;
    const res = await request("POST", "/v1/add", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (opts.json) return print(res);
    print(`added document ${res.document.id} (${res.memoriesExtracted} memories)`);
  },

  async search({ request, opts, args, print }) {
    const query = args.join(" ").trim();
    if (!query) throw new Error("a search query is required");
    const mode = opts.mode || "hybrid";
    const res = await request(
      "GET",
      `/v1/search${containerQuery(opts, { q: query, searchMode: mode })}`
    );
    if (opts.json) return print(res);
    print(`mode: ${res.searchMode} · container: ${res.containerTag} · provider: ${res.embeddingsProvider}`);
    if (!res.results.length) return print("(no results)");
    for (const r of res.results.slice(0, limitOf(opts))) {
      const where = r.source === "chunk" && r.page ? ` p${r.page}` : "";
      print(`  [${r.source}${where}] ${r.score}  ${oneLine(r.text)}`);
    }
  },

  async memories({ request, opts, print }) {
    const { memories } = await request("GET", `/v1/memories${containerQuery(opts)}`);
    if (opts.json) return print({ memories });
    if (!memories.length) return print("(no memories)");
    for (const m of memories.slice(0, limitOf(opts))) {
      print(`  ${m.id}  ${m.effectiveStatus}  ${m.type}  ${oneLine(m.text)}`);
    }
  },

  async forget({ request, opts, args, print }) {
    const id = args[0];
    if (!id) throw new Error("a memory id is required");
    if (!opts.yes) {
      print("refusing to forget without --yes");
      return 2;
    }
    const res = await request("DELETE", `/v1/memories/${encodeURIComponent(id)}${containerQuery(opts)}`);
    if (opts.json) return print(res);
    print(`forgotten ${id}`);
  },

  async profile({ request, opts, print }) {
    const { containerTag, profile } = await request("GET", `/v1/profile${containerQuery(opts)}`);
    if (opts.json) return print({ containerTag, profile });
    print(`container: ${containerTag}`);
    print("static:");
    for (const f of profile.static) print(`  ${f.slot || "-"}  ${oneLine(f.text)}`);
    print("dynamic:");
    for (const f of profile.dynamic) print(`  ${f.expiresAt || "-"}  ${oneLine(f.text)}`);
    if (!profile.static.length && !profile.dynamic.length) print("  (nothing learned yet)");
  },

  async documents({ request, opts, print }) {
    const { documents } = await request("GET", `/v1/documents${containerQuery(opts)}`);
    if (opts.json) return print({ documents });
    if (!documents.length) return print("(no documents)");
    for (const d of documents.slice(0, limitOf(opts))) {
      const label = d.filename || oneLine(d.content, 40);
      print(`  ${d.id}  ${d.status}  ${label}  chunks=${d.chunkCount}`);
    }
  },

  async document({ request, opts, args, print }) {
    const id = args[0];
    if (!id) throw new Error("a document id is required");
    const { document: doc, chunks } = await request(
      "GET",
      `/v1/documents/${encodeURIComponent(id)}${containerQuery(opts)}`
    );
    if (opts.json) return print({ document: doc, chunks });
    print(`document ${doc.id}`);
    print(`  status:   ${doc.status}`);
    if (doc.filename) print(`  filename: ${doc.filename}`);
    if (doc.errorCode) print(`  error:    ${doc.errorCode}`);
    print(`  chunks:   ${doc.chunkCount}`);
    for (const c of chunks.slice(0, limitOf(opts))) {
      print(`  - [${c.chunkIndex}${c.page ? ` p${c.page}` : ""}] ${oneLine(c.text)}`);
    }
  },

  async upload({ request, opts, args, print, err }) {
    const file = opts.file || args[0];
    if (!file) throw new Error("a file path is required");
    const buffer = fs.readFileSync(file);
    const name = path.basename(file);
    const type = UPLOAD_TYPES[extensionOf(name)];
    if (!type) throw new Error(`unsupported file type: ${name} (expected .txt, .md or .pdf)`);
    let res;
    try {
      res = await request("POST", `/v1/documents/upload${containerQuery(opts)}`, {
        headers: { "Content-Type": type.mediaType, "X-Recall-Filename": name },
        body: buffer,
      });
    } catch (e) {
      // A rejected upload still returns a failed-document record; surface it and
      // fail loudly rather than reporting a bare HTTP error.
      if (e.body && e.body.status === "failed") {
        const id = e.body.documentId ? ` (document ${e.body.documentId})` : "";
        err(`[recall] ingestion failed${id}: ${e.body.error}`);
        return 1;
      }
      throw e;
    }
    if (opts.json) {
      print(res);
      return 0;
    }
    print(`uploaded ${res.document.id} (status=${res.document.status}, chunks=${res.chunkCount})`);
    if (res.document.status === "failed") {
      err(`[recall] ingestion failed: ${res.document.errorCode || "unknown error"}`);
      return 1;
    }
    return 0;
  },

  async delete({ request, opts, args, print }) {
    const id = args[0];
    if (!id) throw new Error("a document id is required");
    if (!opts.yes) {
      print("refusing to delete without --yes");
      return 2;
    }
    const res = await request("DELETE", `/v1/documents/${encodeURIComponent(id)}${containerQuery(opts)}`);
    if (opts.json) return print(res);
    print(`deleted ${id}`);
  },
};

async function main(argv, env = process.env, io) {
  const out = (io && io.out) || ((s) => console.log(s));
  const err = (io && io.err) || ((s) => console.error(s));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`[recall] ${e.message}`);
    err(usage());
    return 2;
  }

  const [command, ...args] = opts._;
  if (opts.help || !command || command === "help") {
    out(usage());
    return 0;
  }

  const handler = commands[command];
  if (!handler) {
    err(`[recall] unknown command: ${command}`);
    err(usage());
    return 2;
  }

  const print = (value) => out(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  const client = makeClient(opts, env);

  try {
    const code = await handler({ ...client, opts, args, print, err });
    return typeof code === "number" ? code : 0;
  } catch (e) {
    err(`[recall] ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`[recall] ${e.message}`);
      process.exitCode = 1;
    });
}

module.exports = { main, parseArgs, usage };

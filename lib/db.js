// Zero-config storage. Mirrors real supermemory's "everything lives in one
// directory" philosophy, just with a JSON file instead of an embedded graph db.
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

function emptyStore() {
  return { documents: [], memories: [] };
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(emptyStore(), null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return emptyStore();
  }
}

let store = load();
let dirty = false;

function persist() {
  if (!dirty) return;
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  dirty = false;
}

// Debounce disk writes slightly so bursts of adds don't thrash the disk.
let saveTimer = null;
function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    persist();
    saveTimer = null;
  }, 50);
}

function stripEmbedding(row) {
  if (!row) return row;
  const { embedding, ...rest } = row;
  return rest;
}

module.exports = {
  get documents() {
    return store.documents;
  },
  get memories() {
    return store.memories;
  },
  addDocument(doc) {
    if (doc.embedding === undefined) doc.embedding = null;
    store.documents.push(doc);
    scheduleSave();
    return doc;
  },
  addMemory(mem) {
    if (mem.embedding === undefined) mem.embedding = null;
    store.memories.push(mem);
    scheduleSave();
    return mem;
  },
  updateEmbedding(kind, id, vec) {
    const list = kind === "document" ? store.documents : store.memories;
    const row = list.find((x) => x.id === id);
    if (!row) return null;
    row.embedding = vec;
    scheduleSave();
    return row;
  },
  publicDocument: stripEmbedding,
  publicMemory: stripEmbedding,
  touch: scheduleSave,
  flush: persist,
  reset() {
    store = emptyStore();
    persist();
  },
};

process.on("exit", persist);
process.on("SIGINT", () => {
  persist();
  process.exit(0);
});

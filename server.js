const express = require("express");
const crypto = require("crypto");
const path = require("path");
const db = require("./lib/db");
const { extractMemories, effectiveStatus, resolveExtractionProvider } = require("./lib/extract");
const embeddings = require("./lib/embeddings");
const { attachOnIngest, searchDocuments, searchMemories, searchHybrid, searchProfile } = require("./lib/search");

const app = express();
const PORT = process.env.PORT || 6767;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DEFAULT_TAG = "demo_user";

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ---------------------------------------------------------------- add -----
// POST /v1/add  { content, containerTag? }
app.post(
  "/v1/add",
  asyncRoute(async (req, res) => {
    const { content, containerTag } = req.body || {};
    if (!content || typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "content is required" });
    }
    const tag = containerTag || DEFAULT_TAG;
    const now = new Date();

    const doc = db.addDocument({
      id: crypto.randomUUID(),
      containerTag: tag,
      content: content.trim(),
      createdAt: now.toISOString(),
    });

    const memories = await extractMemories({
      documentId: doc.id,
      containerTag: tag,
      content: doc.content,
      db,
      now,
    });

    await attachOnIngest({ document: doc, memories });

    res.json({
      document: db.publicDocument(doc),
      memoriesExtracted: memories.filter((m) => m.type !== "note").length,
      memories: memories.map(db.publicMemory),
      extractionProvider: (memories[0] && memories[0].extractedBy) || resolveExtractionProvider(),
    });
  })
);

// -------------------------------------------------------------- search ----
// GET /v1/search?q=...&containerTag=...&searchMode=hybrid|memories|documents
app.get(
  "/v1/search",
  asyncRoute(async (req, res) => {
    const { q } = req.query;
    const tag = req.query.containerTag || DEFAULT_TAG;
    const mode = req.query.searchMode || "hybrid";
    if (!q) return res.status(400).json({ error: "q is required" });

    const now = new Date();
    let results = [];

    const docs = db.documents.filter((d) => d.containerTag === tag);
    const mems = db.memories.filter(
      (m) => m.containerTag === tag && effectiveStatus(m, now) === "active"
    );

    if (mode === "documents") {
      results = await searchDocuments(q, docs);
    } else if (mode === "memories") {
      results = await searchMemories(q, mems);
    } else {
      results = await searchHybrid({ q, docs, mems });
    }

    res.json({
      results: results.slice(0, 20),
      searchMode: mode,
      containerTag: tag,
      embeddingsProvider: embeddings.getProviderName(),
    });
  })
);

// ------------------------------------------------------------- profile ----
// GET /v1/profile?containerTag=...&q=optional
app.get(
  "/v1/profile",
  asyncRoute(async (req, res) => {
    const tag = req.query.containerTag || DEFAULT_TAG;
    const now = new Date();

    const mems = db.memories.filter((m) => m.containerTag === tag);
    const staticFacts = mems.filter(
      (m) => m.type === "static" && effectiveStatus(m, now) === "active"
    );
    const dynamicFacts = mems.filter(
      (m) => m.type === "dynamic" && effectiveStatus(m, now) === "active"
    );

    const profile = {
      static: staticFacts
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((m) => ({ id: m.id, text: m.text, slot: m.slot })),
      dynamic: dynamicFacts
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((m) => ({ id: m.id, text: m.text, expiresAt: m.expiresAt })),
    };

    let searchResults = undefined;
    if (req.query.q) {
      const active = mems.filter((m) => effectiveStatus(m, now) === "active");
      searchResults = await searchProfile(req.query.q, active);
    }

    res.json({ containerTag: tag, profile, searchResults });
  })
);

// ------------------------------------------------------------- memories ---
// GET /v1/memories?containerTag=...  (includes superseded/expired, for transparency)
app.get("/v1/memories", (req, res) => {
  const tag = req.query.containerTag || DEFAULT_TAG;
  const now = new Date();
  const mems = db.memories
    .filter((m) => m.containerTag === tag)
    .map((m) => ({ ...db.publicMemory(m), effectiveStatus: effectiveStatus(m, now) }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ containerTag: tag, memories: mems });
});

// DELETE /v1/memories/:id  -- "forget"
app.delete("/v1/memories/:id", (req, res) => {
  const mem = db.memories.find((m) => m.id === req.params.id);
  if (!mem) return res.status(404).json({ error: "not found" });
  mem.status = "forgotten";
  db.touch();
  res.json({ ok: true });
});

// ------------------------------------------------------------ documents ---
app.get("/v1/documents", (req, res) => {
  const tag = req.query.containerTag || DEFAULT_TAG;
  const docs = db.documents
    .filter((d) => d.containerTag === tag)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(db.publicDocument);
  res.json({ containerTag: tag, documents: docs });
});

app.get("/v1/containers", (_req, res) => {
  const tags = new Set(db.documents.map((d) => d.containerTag));
  res.json({ containerTags: Array.from(tags) });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "internal error" });
});

app.listen(PORT, () => {
  console.log(`supermemory-clone running at http://localhost:${PORT}`);
  embeddings.warmup();
});

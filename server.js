const express = require("express");
const crypto = require("crypto");
const path = require("path");
const db = require("./lib/db");
const { classifyContent, persistFacts, effectiveStatus } = require("./lib/extract");
const embeddings = require("./lib/embeddings");
const { issueApiKey, createAuthMiddleware, authorizeContainer } = require("./lib/auth");
const { createLimiter, createRateLimitMiddleware } = require("./lib/ratelimit");
const {
  validateContent,
  validateQuery,
  isValidContainerTag,
  isValidId,
  isValidSearchMode,
} = require("./lib/validate");
const {
  embedIngestTexts,
  searchMemories,
  searchHybrid,
  searchProfile,
  searchDocumentsWithChunks,
} = require("./lib/search");
const { ingestUpload } = require("./lib/documents/ingest");
const fileStore = require("./lib/documents/storage");
const { readConfig: readDocConfig } = require("./lib/documents/config");

const PORT = process.env.PORT || 6767;

function toPosInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Configuration is read per createApp() call so tests can build isolated apps
// with different auth/limit settings.
function readConfig(env = process.env) {
  const authMode = (env.AUTH_MODE || "required").toLowerCase().trim();
  if (authMode !== "required" && authMode !== "dev") {
    throw new Error(`unknown AUTH_MODE=${authMode} (expected "required" or "dev")`);
  }
  if (authMode === "dev" && env.NODE_ENV === "production") {
    throw new Error("AUTH_MODE=dev is not allowed when NODE_ENV=production");
  }
  return {
    authMode,
    devTenant: env.DEV_TENANT || "dev",
    devContainer: env.DEV_CONTAINER || "dev",
    generalMax: toPosInt(env.RATE_LIMIT_PER_MIN, 120),
    expensiveMax: toPosInt(env.RATE_LIMIT_EXPENSIVE_PER_MIN, 30),
    corsOrigins: String(env.CORS_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function createApp(config = readConfig()) {
  const app = express();

  // -------------------------------------------------------- hardening -----
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // CORS is off by default (same-origin dashboard). An explicit allowlist can be
  // opted into with CORS_ORIGINS; there is never a wildcard with credentials.
  if (config.corsOrigins.length) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && config.corsOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
      }
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
  }

  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  // ----------------------------------------------------------- auth ------
  if (config.authMode === "dev") {
    // Provision the dev container so local reads work without an explicit add.
    db.claimContainer(config.devContainer, config.devTenant);
    console.warn(
      `[auth] WARNING: AUTH_MODE=dev — all /v1 requests are treated as tenant ` +
        `"${config.devTenant}" container "${config.devContainer}". Never use this in production.`
    );
  }

  const auth = createAuthMiddleware({
    db,
    mode: config.authMode,
    devTenant: config.devTenant,
    devContainer: config.devContainer,
  });

  const identify = (req) =>
    req.auth && req.auth.keyId ? `key:${req.auth.keyId}` : `ip:${req.ip || "unknown"}`;
  const ipLimiter = createRateLimitMiddleware({
    limiter: createLimiter({ max: config.generalMax * 4 }),
    identify: (req) => `ip:${req.ip || "unknown"}`,
  });
  const generalLimiter = createRateLimitMiddleware({
    limiter: createLimiter({ max: config.generalMax }),
    identify,
  });
  const expensiveLimiter = createRateLimitMiddleware({
    limiter: createLimiter({ max: config.expensiveMax }),
    identify,
  });
  // /v1/profile only embeds (an expensive operation) when `q` is present, so it
  // is charged to the expensive budget only then.
  const expensiveIfQuery = (req, res, next) =>
    req.query && req.query.q ? expensiveLimiter(req, res, next) : next();

  const docConfig = readDocConfig();
  // Raw-body uploads only: the global JSON parser ignores these content types,
  // so this route reads the file bytes itself under a strict size limit.
  const rawUpload = express.raw({ type: () => true, limit: docConfig.maxUploadBytes });

  // Remove any temp files left behind by a crash mid-upload.
  fileStore.sweepTemps();

  app.use("/v1", ipLimiter, auth, generalLimiter);

  // Resolve and authorize the request's container against the authenticated
  // tenant. Returns the container tag, or null after sending 400/403.
  function resolveTag(req, res, { claim = false } = {}) {
    const requested =
      (req.query && req.query.containerTag) ||
      (req.body && req.body.containerTag) ||
      null;
    const result = authorizeContainer(db, req.auth, requested, { claim });
    if (!result.ok) {
      if (result.reason === "invalid") {
        res.status(400).json({ error: "invalid containerTag" });
      } else {
        res.status(403).json({ error: "forbidden" });
      }
      return null;
    }
    return result.tag;
  }

  // -------------------------------------------------------------- add -----
  // POST /v1/add  { content, containerTag? }
  app.post(
    "/v1/add",
    expensiveLimiter,
    asyncRoute(async (req, res) => {
      const { content } = req.body || {};
      const invalid = validateContent(content);
      if (invalid) return res.status(invalid.status).json({ error: invalid.error });

      const tag = resolveTag(req, res, { claim: true });
      if (!tag) return;
      const now = new Date();

      const draft = {
        id: crypto.randomUUID(),
        containerTag: tag,
        content: content.trim(),
        createdAt: now.toISOString(),
        embedding: null,
      };

      // Extract first (async, may call an LLM), then persist the document,
      // its memories and their embeddings in a single transaction.
      const { facts, provider } = await classifyContent(draft.content);
      const vectors = await embedIngestTexts([draft.content, ...facts.map((f) => f.text)]);

      const { doc, memories } = db.transaction(() => {
        const savedDoc = db.addDocument({
          ...draft,
          embedding: vectors ? vectors[0] || null : null,
        });
        const savedMemories = persistFacts({
          documentId: savedDoc.id,
          containerTag: tag,
          facts,
          db,
          now,
          extractedBy: provider,
          embeddings: vectors ? vectors.slice(1) : null,
        });
        return { doc: savedDoc, memories: savedMemories };
      });

      res.json({
        document: db.publicDocument(doc),
        memoriesExtracted: memories.filter((m) => m.type !== "note").length,
        memories: memories.map(db.publicMemory),
        extractionProvider: (memories[0] && memories[0].extractedBy) || provider,
      });
    })
  );

  // ---------------------------------------------------- documents:upload --
  // POST /v1/documents/upload
  // Raw file body. Media type comes from Content-Type; the original name comes
  // from `X-Recall-Filename` (or `?filename=`) and is stored as metadata only —
  // it is never used to build a filesystem path.
  app.post(
    "/v1/documents/upload",
    expensiveLimiter,
    rawUpload,
    asyncRoute(async (req, res) => {
      const tag = resolveTag(req, res, { claim: true });
      if (!tag) return;

      const filename = req.get("x-recall-filename") || req.query.filename || null;
      const declaredMime = req.get("content-type") || null;
      const extractFacts = String(req.query.extractFacts || "").toLowerCase() === "true";
      // A body this route can't interpret as raw bytes (e.g. a JSON content
      // type already consumed upstream) is treated as empty and rejected.
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      try {
        const result = await ingestUpload({
          db,
          containerTag: tag,
          filename,
          declaredMime,
          buffer,
          extractFacts,
        });
        return res.status(result.duplicate ? 200 : 201).json({
          duplicate: result.duplicate,
          document: db.publicDocument(result.document),
          chunkCount: result.chunks.length,
          memoriesExtracted: result.derivedMemories.length,
        });
      } catch (err) {
        const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
        const body = { error: status >= 500 ? "internal error" : err.message };
        if (err.document && err.document.id) {
          body.documentId = err.document.id;
          body.status = "failed";
        }
        return res.status(status).json(body);
      }
    })
  );

  // ------------------------------------------------------------ search ----
  // GET /v1/search?q=...&containerTag=...&searchMode=hybrid|memories|documents
  app.get(
    "/v1/search",
    expensiveLimiter,
    asyncRoute(async (req, res) => {
      const { q, searchMode } = req.query;
      const qError = validateQuery(q);
      if (qError) return res.status(qError.status).json({ error: qError.error });

      const mode = searchMode || "hybrid";
      if (!isValidSearchMode(mode)) {
        return res.status(400).json({ error: "invalid searchMode" });
      }

      const tag = resolveTag(req, res, { claim: false });
      if (!tag) return;

      const now = new Date();
      const docs = db.listDocuments(tag);
      const mems = db.listMemories(tag).filter((m) => effectiveStatus(m, now) === "active");

      let results = [];
      if (mode === "memories") {
        results = await searchMemories(q, mems);
      } else {
        // Uploaded files are searchable at chunk granularity; raw-text documents
        // (which have no chunks) keep the original document-level ranking. Failed
        // uploads are never ranked or embedded (they have empty content and would
        // otherwise surface as empty hits, or break a provider that rejects empty
        // input).
        const chunks = db.listChunks(tag);
        const docById = new Map(docs.map((d) => [d.id, d]));
        const plainDocs = docs.filter((d) => d.status !== "failed" && !d.chunkCount);
        if (mode === "documents") {
          results = await searchDocumentsWithChunks({ q, docs: plainDocs, chunks, docById });
        } else {
          results = await searchHybrid({ q, docs: plainDocs, mems, chunks, docById });
        }
      }

      res.json({
        results: results.slice(0, 20),
        searchMode: mode,
        containerTag: tag,
        embeddingsProvider: embeddings.getProviderName(),
      });
    })
  );

  // ----------------------------------------------------------- profile ----
  // GET /v1/profile?containerTag=...&q=optional
  app.get(
    "/v1/profile",
    expensiveIfQuery,
    asyncRoute(async (req, res) => {
      const tag = resolveTag(req, res, { claim: false });
      if (!tag) return;
      if (req.query.q !== undefined) {
        const qError = validateQuery(req.query.q);
        if (qError) return res.status(qError.status).json({ error: qError.error });
      }
      const now = new Date();

      const mems = db.listMemories(tag);
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

  // ----------------------------------------------------------- memories ---
  // GET /v1/memories?containerTag=...  (includes superseded/expired, for transparency)
  app.get("/v1/memories", (req, res) => {
    const tag = resolveTag(req, res, { claim: false });
    if (!tag) return;
    const now = new Date();
    const mems = db
      .listMemories(tag)
      .map((m) => ({ ...db.publicMemory(m), effectiveStatus: effectiveStatus(m, now) }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ containerTag: tag, memories: mems });
  });

  // DELETE /v1/memories/:id?containerTag=...  -- "forget"
  // Ownership is enforced at the data-access boundary: a memory can only be
  // forgotten when its containerTag matches the authenticated container.
  app.delete("/v1/memories/:id", (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const tag = resolveTag(req, res, { claim: false });
    if (!tag) return;
    const mem = db.forgetMemory(req.params.id, tag);
    if (!mem) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------- documents ---
  app.get("/v1/documents", (req, res) => {
    const tag = resolveTag(req, res, { claim: false });
    if (!tag) return;
    const docs = db
      .listDocuments(tag)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(db.publicDocument);
    res.json({ containerTag: tag, documents: docs });
  });

  // GET /v1/documents/:id — metadata + chunk list (source attribution).
  app.get("/v1/documents/:id", (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: "invalid id" });
    const tag = resolveTag(req, res, { claim: false });
    if (!tag) return;
    const doc = db.getDocument(req.params.id, tag);
    if (!doc) return res.status(404).json({ error: "not found" });
    const chunks = db.listChunksByDocument(doc.id, tag).map((c) => ({
      id: c.id,
      chunkIndex: c.chunkIndex,
      page: c.page,
      text: c.text,
    }));
    res.json({ document: db.publicDocument(doc), chunks });
  });

  // DELETE /v1/documents/:id — removes the source, its chunks, its stored file
  // and only the memories derived from it. Ownership is enforced in the data
  // layer; a missing file is tolerated and a DB error leaves the record intact.
  app.delete("/v1/documents/:id", (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: "invalid id" });
    const tag = resolveTag(req, res, { claim: false });
    if (!tag) return;
    const doc = db.deleteDocument(req.params.id, tag);
    if (!doc) return res.status(404).json({ error: "not found" });
    if (doc.storageKey) {
      try {
        fileStore.remove(doc.storageKey);
      } catch (cleanupErr) {
        // Log a safe code only: a filesystem error message can embed an absolute
        // path, and we must not leak server paths (or the file name) into logs.
        console.warn(
          `[documents] stored file cleanup failed (code=${(cleanupErr && cleanupErr.code) || "unknown"})`
        );
      }
    }
    res.json({ ok: true });
  });

  // --------------------------------------------------------- containers ---
  // Authenticated, and only ever returns containers owned by the caller.
  app.get("/v1/containers", (req, res) => {
    const tags = db.listContainers(req.auth.tenantId).map((c) => c.containerTag);
    res.json({ containerTags: tags });
  });

  // ------------------------------------------------------------ whoami ----
  // Small authenticated self-description, handy for verifying bootstrap.
  app.get("/v1/whoami", (req, res) => {
    res.json({
      tenantId: req.auth.tenantId,
      keyId: req.auth.keyId,
      containerTag: req.auth.defaultContainer,
      authMode: config.authMode,
    });
  });

  // ------------------------------------------------------------- errors ---
  // Structured, redacted error handling. Never logs request bodies, headers,
  // secrets or stack traces; never returns internal detail to the client.
  app.use((err, req, res, next) => {
    const raw = err && (err.status || err.statusCode);
    const status = raw >= 400 && raw < 600 ? raw : 500;
    const event = {
      level: status >= 500 ? "error" : "warn",
      event: "request_failed",
      method: req.method,
      path: req.path,
      status,
      error: (err && err.name) || "Error",
    };
    if (err && err.code) event.code = err.code;
    const write = status >= 500 ? console.error : console.warn;
    write(JSON.stringify(event));

    if (res.headersSent) return next(err);
    const messages = {
      400: "invalid request body",
      413: "payload too large",
      415: "unsupported media type",
    };
    const message = messages[status] || (status >= 500 ? "internal error" : "bad request");
    res.status(status).json({ error: message });
  });

  return app;
}

const app = createApp();

// Graceful shutdown: stop accepting connections, close the database, then exit.
// Guarded against duplicate execution and a hard timeout so it can never hang.
function attachShutdown(server, { timeoutMs = 10000 } = {}) {
  let closing = false;
  return function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`[server] ${signal} received — shutting down`);
    const force = setTimeout(() => {
      console.error("[server] graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, timeoutMs);

    server.close((err) => {
      clearTimeout(force);
      try {
        fileStore.sweepTemps();
      } catch {
        /* best-effort temp cleanup */
      }
      try {
        db.close();
      } catch (closeErr) {
        console.warn(`[storage] close failed: ${closeErr.message}`);
      }
      if (err) {
        console.warn(`[server] close error: ${err.message}`);
        process.exit(1);
      }
      process.exit(0);
    });
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
  };
}

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Recall running at http://localhost:${PORT}`);
    embeddings.warmup();
  });
  const shutdown = attachShutdown(server);
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = { app, createApp, readConfig, attachShutdown, issueApiKey };

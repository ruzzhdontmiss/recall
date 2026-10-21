// Document-ingestion configuration. Read from the environment at call time so an
// isolated test process can override it before the server is required.
//
// All values are validated: an explicitly-set invalid value fails fast (see
// lib/config.js) rather than silently falling back.

const path = require("path");
const { posIntEnv } = require("../config");

function readConfig(env = process.env) {
  const dataDir = env.DATA_DIR || path.join(__dirname, "..", "..", "data");
  return {
    dataDir,
    // Uploaded files live beside the database and are never served directly.
    uploadDir: env.UPLOAD_DIR || path.join(dataDir, "uploads"),
    maxUploadBytes: posIntEnv(env, "MAX_UPLOAD_BYTES", 10 * 1024 * 1024), // 10 MiB
    maxPdfPages: posIntEnv(env, "MAX_PDF_PAGES", 500),
    pdfTimeoutMs: posIntEnv(env, "PDF_EXTRACT_TIMEOUT_MS", 20000),
    // PDF parsing runs in worker threads. Bound how many run at once and how many
    // may wait, so a burst of uploads cannot exhaust memory or stall the server.
    pdfMaxConcurrent: posIntEnv(env, "PDF_MAX_CONCURRENT", 2),
    pdfMaxQueue: posIntEnv(env, "PDF_MAX_QUEUE", 64),
    // Optional per-worker V8 old-space cap in MiB (0 = Node default). A very
    // large PDF can still exceed it; the worker then dies and the job fails
    // cleanly rather than growing the server heap.
    pdfWorkerHeapMb: posIntEnv(env, "PDF_WORKER_HEAP_MB", 0, { min: 0 }),
    maxExtractedChars: posIntEnv(env, "MAX_EXTRACTED_CHARS", 2_000_000),
    chunkSize: posIntEnv(env, "CHUNK_SIZE", 1200),
    chunkOverlap: posIntEnv(env, "CHUNK_OVERLAP", 200, { min: 0 }),
    maxChunks: posIntEnv(env, "MAX_CHUNKS", 2000),
    embedBatchSize: posIntEnv(env, "EMBED_BATCH_SIZE", 64),
  };
}

module.exports = { readConfig };

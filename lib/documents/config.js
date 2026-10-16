// Document-ingestion configuration. Read from the environment at call time so an
// isolated test process can override it before the server is required.

const path = require("path");

function toPosInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readConfig(env = process.env) {
  const dataDir = env.DATA_DIR || path.join(__dirname, "..", "..", "data");
  return {
    dataDir,
    // Uploaded files live beside the database and are never served directly.
    uploadDir: env.UPLOAD_DIR || path.join(dataDir, "uploads"),
    maxUploadBytes: toPosInt(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024), // 10 MiB
    maxPdfPages: toPosInt(env.MAX_PDF_PAGES, 500),
    pdfTimeoutMs: toPosInt(env.PDF_EXTRACT_TIMEOUT_MS, 20000),
    maxExtractedChars: toPosInt(env.MAX_EXTRACTED_CHARS, 2_000_000),
    chunkSize: toPosInt(env.CHUNK_SIZE, 1200),
    chunkOverlap: toPosInt(env.CHUNK_OVERLAP, 200),
    maxChunks: toPosInt(env.MAX_CHUNKS, 2000),
    embedBatchSize: toPosInt(env.EMBED_BATCH_SIZE, 64),
  };
}

module.exports = { readConfig };

// Format-specific text extraction.
//
// Adapters supported in this phase: plain text (.txt), Markdown (.md) and PDF
// (.pdf). PDF parsing runs in a separate worker thread (see ./pdf) so it can be
// deadline-bounded and terminated; this module itself never parses a PDF in the
// main process.

const { readConfig } = require("./config");
const { httpError } = require("./errors");
const { normalizeText } = require("./text");
const { extractPdfIsolated } = require("./pdf");

function extractTextLike(buffer) {
  const text = normalizeText(buffer.toString("utf8"));
  return { pages: [{ page: null, text }], pageCount: null };
}

// Returns { pages: [{ page, text }], pageCount }.
// `opts` is used by tests to inject a runner / bound; production callers omit it.
async function extractDocument(buffer, adapter, opts = {}) {
  const cfg = readConfig();
  if (adapter === "pdf") return extractPdfIsolated(buffer, cfg, opts);
  if (adapter === "text" || adapter === "markdown") return extractTextLike(buffer);
  throw httpError(415, "unsupported_type", "unsupported file type");
}

module.exports = { extractDocument, normalizeText, httpError };

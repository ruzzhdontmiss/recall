// Format-specific text extraction.
//
// Adapters supported in this phase: plain text (.txt), Markdown (.md) and PDF
// (.pdf) via `unpdf` (a serverless build of Mozilla PDF.js). PDF.js does not
// execute scripts embedded in a PDF, but parsing is still untrusted work, so we
// bound page count and wall-clock time and never let a parser hang the request.

const { readConfig } = require("./config");

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// Collapse CRLF, trailing whitespace and runs of blank lines while leaving the
// readable structure intact.
function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(httpError(422, code, "document parsing timed out")), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

function extractTextLike(buffer) {
  const text = normalizeText(buffer.toString("utf8"));
  return { pages: [{ page: null, text }], pageCount: null };
}

async function extractPdf(buffer, { maxPdfPages, pdfTimeoutMs }) {
  let unpdf;
  try {
    unpdf = require("unpdf");
  } catch {
    throw httpError(500, "pdf_unavailable", "PDF support is unavailable");
  }
  const { getDocumentProxy, extractText } = unpdf;

  let pdf;
  try {
    pdf = await withTimeout(getDocumentProxy(new Uint8Array(buffer)), pdfTimeoutMs, "pdf_timeout");
  } catch (err) {
    if (err && err.status) throw err;
    throw httpError(422, "pdf_unreadable", "could not read PDF");
  }

  try {
    if (pdf.numPages > maxPdfPages) {
      throw httpError(413, "pdf_too_many_pages", "PDF has too many pages");
    }
    let text;
    try {
      ({ text } = await withTimeout(
        extractText(pdf, { mergePages: false }),
        pdfTimeoutMs,
        "pdf_timeout"
      ));
    } catch (err) {
      if (err && err.status) throw err;
      throw httpError(422, "pdf_unreadable", "could not read PDF");
    }
    const parts = Array.isArray(text) ? text : [text];
    const pages = parts.map((t, i) => ({ page: i + 1, text: normalizeText(t) }));
    return { pages, pageCount: pdf.numPages };
  } finally {
    try {
      await pdf.destroy();
    } catch {
      /* nothing else to clean up */
    }
  }
}

// Returns { pages: [{ page, text }], pageCount }.
async function extractDocument(buffer, adapter) {
  const cfg = readConfig();
  if (adapter === "pdf") return extractPdf(buffer, cfg);
  if (adapter === "text" || adapter === "markdown") return extractTextLike(buffer);
  throw httpError(415, "unsupported_type", "unsupported file type");
}

module.exports = { extractDocument, normalizeText, httpError };

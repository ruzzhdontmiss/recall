// Text normalization shared by the in-process extractors and the PDF worker.
// Kept dependency-free so a worker thread can require it cheaply.

// Collapse CRLF, trailing whitespace and runs of blank lines while leaving the
// readable structure intact.
function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { normalizeText };

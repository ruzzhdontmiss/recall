// Shared HTTP-shaped error helper for the document-ingestion pipeline.
//
// Kept in its own module so the PDF worker runner (lib/documents/pdf.js) and the
// extractor (lib/documents/extract.js) can both use it without a require cycle.

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = { httpError };

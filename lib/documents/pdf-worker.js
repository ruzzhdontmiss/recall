// PDF extraction worker (runs in a dedicated worker thread).
//
// The main server never parses PDFs itself: PDF.js is untrusted-work-heavy, so it
// runs here where the parent can enforce a wall-clock deadline by terminating the
// whole thread, and where a parser crash cannot take down the request loop.
//
// Protocol: the parent posts nothing; all input arrives once via `workerData`
// ({ buffer, maxPdfPages, maxExtractedChars }). Exactly one message is sent back:
//   { ok: true,  pages: [{ page, text }], pageCount }
//   { ok: false, status, code }        // status/code mirror the HTTP contract
//
// Page identity and ordering are preserved: element i of the extracted array is
// page i + 1. Limits are enforced here as early as practical so a giant or
// over-long document never has to travel back to the parent.

const { parentPort, workerData } = require("node:worker_threads");
const { normalizeText } = require("./text");

function reply(message) {
  parentPort.postMessage(message);
}

function fail(status, code) {
  reply({ ok: false, status, code });
}

async function main() {
  const { buffer, maxPdfPages, maxExtractedChars } = workerData || {};

  let unpdf;
  try {
    unpdf = require("unpdf");
  } catch {
    return fail(500, "pdf_unavailable");
  }
  const { getDocumentProxy, extractText } = unpdf;

  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch {
    return fail(422, "pdf_unreadable");
  }

  try {
    // Enforce the page ceiling before extracting any text.
    if (!Number.isInteger(pdf.numPages) || pdf.numPages <= 0) {
      return fail(422, "pdf_unreadable");
    }
    if (pdf.numPages > maxPdfPages) {
      return fail(413, "pdf_too_many_pages");
    }

    let text;
    try {
      ({ text } = await extractText(pdf, { mergePages: false }));
    } catch {
      return fail(422, "pdf_unreadable");
    }

    const parts = Array.isArray(text) ? text : [text];
    const pages = parts.map((t, i) => ({ page: i + 1, text: normalizeText(t) }));

    // Enforce the extracted-text ceiling before shipping the payload back.
    let total = 0;
    for (const page of pages) total += page.text ? page.text.length : 0;
    if (total > maxExtractedChars) {
      return fail(413, "too_much_text");
    }

    reply({ ok: true, pages, pageCount: pdf.numPages });
  } finally {
    try {
      await pdf.destroy();
    } catch {
      /* nothing else to release */
    }
  }
}

main().catch(() => {
  // A post-startup failure is reported as a generic parser failure; the parent
  // still owns the deadline and will terminate a worker that never replies.
  fail(500, "pdf_worker_failed");
});

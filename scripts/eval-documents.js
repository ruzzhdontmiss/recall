#!/usr/bin/env node
// End-to-end probe for Phase 4 document ingestion. Uses an isolated temp
// directory (never ./data) and the offline providers by default:
//   txt/md/pdf are stored -> chunked -> searchable with source attribution,
//   identical bytes dedupe, lookups/deletes are container-scoped, and deleting
//   a source removes only the memories derived from it.
//
// Run: npm run eval:documents   (set EMBEDDINGS_PROVIDER=xenova for semantic)

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "recall-eval-docs-"));
process.env.DATA_DIR = TMP;
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND || "sqlite";
process.env.EMBEDDINGS_PROVIDER = process.env.EMBEDDINGS_PROVIDER || "tfidf";
process.env.EXTRACTION_PROVIDER = process.env.EXTRACTION_PROVIDER || "regex";

const db = require("../lib/db");
const embeddings = require("../lib/embeddings");
const fileStore = require("../lib/documents/storage");
const { ingestUpload } = require("../lib/documents/ingest");
const { searchDocumentsWithChunks } = require("../lib/search");

const TAG = "eval_docs";
const OTHER = "eval_docs_other";

// Minimal, dependency-free PDF builder so the eval is self-contained.
function buildPdf(pageTexts) {
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const n = pageTexts.length;
  const fontNum = 3 + 2 * n;
  const objs = {};
  const kids = [];
  for (let i = 0; i < n; i++) {
    const pageNum = 3 + 2 * i;
    const contentNum = 4 + 2 * i;
    kids.push(`${pageNum} 0 R`);
    const stream = `BT /F1 24 Tf 72 700 Td (${esc(pageTexts[i])}) Tj ET`;
    objs[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`;
    objs[contentNum] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`;
  objs[fontNum] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i <= fontNum; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${fontNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= fontNum; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${fontNum + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function searchable(q) {
  const all = db.listDocuments(TAG);
  const docs = all.filter((d) => !d.chunkCount);
  const chunks = db.listChunks(TAG);
  const docById = new Map(all.map((d) => [d.id, d]));
  return searchDocumentsWithChunks({ q, docs, chunks, docById });
}

async function main() {
  db.reset();
  await embeddings.getImpl();
  console.log(`provider: ${embeddings.getProviderName()}`);

  const txtBytes = Buffer.from("Project recall stores uploaded notes about zebras and ingestion.");
  const txt = await ingestUpload({
    db,
    containerTag: TAG,
    filename: "notes.txt",
    declaredMime: "text/plain",
    buffer: txtBytes,
  });
  check(
    "txt ingested, chunked, marked ready",
    txt.document.status === "ready" && txt.chunks.length >= 1,
    `chunks=${txt.chunks.length}`
  );

  const md = await ingestUpload({
    db,
    containerTag: TAG,
    filename: "readme.md",
    declaredMime: "text/markdown",
    buffer: Buffer.from("# Readme\n\nNotes about falcons."),
  });
  check("markdown ingested", md.document.status === "ready");

  const pdf = await ingestUpload({
    db,
    containerTag: TAG,
    filename: "report.pdf",
    declaredMime: "application/pdf",
    buffer: buildPdf(["Alpha page about cats", "Beta page about rockets"]),
  });
  check("pdf ingested and page count recorded", pdf.document.pageCount === 2);

  const zebra = await searchable("zebras");
  check(
    "uploaded text is retrievable with source attribution",
    zebra.some(
      (h) =>
        h.source === "chunk" && h.documentId === txt.document.id && h.filename === "notes.txt"
    )
  );

  const pageHit = (await searchable("rockets")).find((h) => h.documentId === pdf.document.id);
  check("pdf result is attributed to the right page", pageHit && pageHit.page === 2,
    pageHit ? `page=${pageHit.page}` : "no hit");

  const again = await ingestUpload({
    db,
    containerTag: TAG,
    filename: "notes.txt",
    declaredMime: "text/plain",
    buffer: txtBytes,
  });
  check(
    "identical bytes deduplicated",
    again.duplicate === true && again.document.id === txt.document.id
  );

  check("hash lookup is container-scoped", db.findDocumentByHash(OTHER, txt.document.contentHash) === null);

  const wrongDelete = db.deleteDocument(txt.document.id, OTHER);
  check(
    "cross-container delete is a no-op",
    wrongDelete === null && db.getDocument(txt.document.id, TAG) !== null
  );

  const facts = await ingestUpload({
    db,
    containerTag: TAG,
    filename: "facts.txt",
    declaredMime: "text/plain",
    buffer: Buffer.from("I live in Berlin and I work as a backend engineer."),
    extractFacts: true,
  });
  const derived = db.listMemories(TAG).filter((m) => m.documentId === facts.document.id);
  check("opt-in fact extraction records provenance", derived.length >= 1, `memories=${derived.length}`);

  const del = db.deleteDocument(facts.document.id, TAG);
  if (del && del.storageKey) {
    try {
      fileStore.remove(del.storageKey);
    } catch {
      /* reported by the file check below */
    }
  }
  check(
    "delete removes the document and only its derived memories",
    del &&
      db.getDocument(facts.document.id, TAG) === null &&
      db.listMemories(TAG).filter((m) => m.documentId === facts.document.id).length === 0
  );
  check(
    "delete removes the stored file",
    !del.storageKey || !fs.existsSync(path.join(TMP, "uploads", del.storageKey))
  );
  check("delete leaves other documents intact", db.getDocument(txt.document.id, TAG) !== null);

  const failed = checks.filter((c) => !c).length;
  if (failed) throw new Error(`${failed} document eval check(s) failed`);
  console.log(`PASS: ${checks.length} document-ingestion checks passed`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

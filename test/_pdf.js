// Minimal PDF builder for tests. Produces a valid, uncompressed PDF with one
// text object per page so PDF.js can extract per-page text. Kept programmatic so
// no binary fixtures are committed.

function escapeText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(pageTexts) {
  const n = pageTexts.length;
  const fontNum = 3 + 2 * n;
  const objs = {};
  const kids = [];

  for (let i = 0; i < n; i++) {
    const pageNum = 3 + 2 * i;
    const contentNum = 4 + 2 * i;
    kids.push(`${pageNum} 0 R`);
    const stream = `BT /F1 24 Tf 72 700 Td (${escapeText(pageTexts[i])}) Tj ET`;
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
  const xrefStart = Buffer.byteLength(out);
  out += `xref\n0 ${fontNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= fontNum; i++) {
    out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  out += `trailer\n<< /Size ${fontNum + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

module.exports = { buildPdf };

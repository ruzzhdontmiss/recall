// Boundary-aware text chunking.
//
// Chunks overlap slightly so a passage split across a boundary is still
// retrievable. Splits prefer a paragraph break, then a sentence end, then a
// newline/space, and only fall back to a hard cut when none is found in the
// second half of the window. The overlap start is also snapped to the start of
// the sentence/line it lands in (bounded by the previous chunk's start), so a
// chunk never begins in the middle of a word. Offsets reference the normalized
// source text.

function boundaryEnd(window) {
  const minPos = Math.floor(window.length * 0.5);
  for (const sep of ["\n\n", ". ", "! ", "? ", "\n", " "]) {
    const idx = window.lastIndexOf(sep);
    if (idx >= minPos) return idx + sep.length;
  }
  return -1;
}

function boundaryStart(src, from, floor, maxBack) {
  const limit = Math.max(floor, from - maxBack);
  for (let i = from; i > limit; i--) {
    if (src[i - 1] === "\n") {
      let j = i;
      while (j < from && /\s/.test(src[j])) j++;
      return j;
    }
    if ((src[i - 1] === "." || src[i - 1] === "!" || src[i - 1] === "?") && /\s/.test(src[i])) {
      let j = i;
      while (j < from && /\s/.test(src[j])) j++;
      return j;
    }
  }
  // No sentence/line boundary was found nearby: at least never start inside a
  // word. If `from` is already at a word boundary, this is a no-op.
  let i = from;
  while (i < src.length && /\S/.test(src[i - 1]) && /\S/.test(src[i])) i++;
  return i;
}

function chunkText(text, { size = 1200, overlap = 200 } = {}) {
  const out = [];
  const src = String(text || "");
  const n = src.length;
  if (!src.trim()) return out;

  let start = 0;
  while (start < n) {
    let end = Math.min(start + size, n);
    if (end < n) {
      const window = src.slice(start, end);
      const boundary = boundaryEnd(window);
      if (boundary > 0) end = start + boundary;
    }
    const piece = src.slice(start, end);
    if (piece.trim()) out.push({ text: piece.trim(), charStart: start, charEnd: end });
    if (end >= n) break;
    const next = end - overlap;
    let nextStart = next;
    if (next > start) {
      const aligned = boundaryStart(src, next, start, overlap * 2);
      if (aligned > start && aligned < end) nextStart = aligned;
    }
    start = nextStart > start ? nextStart : end; // always make progress
  }
  return out;
}

// Chunk a list of pages, carrying the page number and a document-wide index so
// results can be attributed back to a page and position.
function chunkPages(pages, opts) {
  const out = [];
  let index = 0;
  for (const page of pages) {
    for (const part of chunkText(page.text, opts)) {
      out.push({ ...part, page: page.page ?? null, chunkIndex: index++ });
    }
  }
  return out;
}

module.exports = { chunkText, chunkPages };

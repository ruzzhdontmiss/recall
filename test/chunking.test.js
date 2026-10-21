const { test } = require("node:test");
const assert = require("node:assert");
const { chunkText, chunkPages } = require("../lib/documents/chunk");

test("overlap chunks start at a sentence/line boundary, never mid-word", () => {
  const sentence = "The quick brown fox jumps over the lazy dog. ";
  const text = sentence.repeat(60);
  const chunks = chunkText(text, { size: 500, overlap: 120 });
  assert.ok(chunks.length > 2, "the fixture must produce several chunks");
  assert.equal(chunks[0].charStart, 0);
  for (const chunk of chunks) {
    assert.ok(chunk.text.startsWith("The quick brown fox"), "a chunk starts at the sentence boundary");
    const prev = text[chunk.charStart - 1];
    const first = chunk.text[0];
    if (prev !== undefined) {
      assert.ok(
        !(/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(first)),
        "a chunk must not begin in the middle of a word"
      );
    }
  }
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].charStart > chunks[i - 1].charStart, "chunks must make progress");
    assert.ok(chunks[i].charStart < chunks[i - 1].charEnd, "consecutive chunks must overlap");
  }
  assert.equal(chunks[chunks.length - 1].charEnd, text.length, "the final chunk reaches the end");
});

test("chunkPages carries page and document-wide indexes", () => {
  const pages = [
    { page: 1, text: "First page sentence. ".repeat(40) },
    { page: 2, text: "Second page sentence. ".repeat(40) },
  ];
  const chunks = chunkPages(pages, { size: 300, overlap: 60 });
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].page, 1);
  assert.equal(chunks[chunks.length - 1].page, 2);
  chunks.forEach((c, i) => assert.equal(c.chunkIndex, i));
});

test("empty and whitespace-only text produce no chunks", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\t "), []);
  assert.deepEqual(chunkPages([{ page: 1, text: " " }]), []);
});

// Sparse lexical fallback. Vectors are not persisted; search rebuilds a
// corpus index per request via lib/tfidf.js.

module.exports = {
  kind: "tfidf",
  async ready() {},
  async embed() {
    return null;
  },
  async embedMany(texts) {
    return (texts || []).map(() => null);
  },
};

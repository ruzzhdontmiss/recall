// Child process with STORAGE_BACKEND=json. Proves the lexical-degradation and
// honest-ranking behavior is identical on the legacy JSON backend: a dense
// provider that cannot produce a vector for a row must fall back to lexical
// ranking, never return nothing, and never claim "dense".
const db = require("../../lib/db");
const embeddings = require("../../lib/embeddings");
const search = require("../../lib/search");

(async () => {
  db.addDocument({
    id: "json-1",
    containerTag: "jb",
    content: "alpha beta gamma",
    createdAt: new Date().toISOString(),
    embedding: null,
  });

  embeddings.getImpl = async () => ({ kind: "xenova" });
  embeddings.isDense = () => true;
  embeddings.embed = async () => {
    throw new Error("provider down");
  };

  const state = search.createRankingState();
  const hits = await search.searchDocuments("alpha", db.listDocuments("jb"), state);
  process.stdout.write(
    "RESULT " + JSON.stringify({ hits: hits.length, ranking: search.rankingMode(state) }) + "\n"
  );
  db.close();
  process.exit(0);
})().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + "\n");
  process.exit(1);
});

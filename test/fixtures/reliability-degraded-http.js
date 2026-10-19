// Child process. EMBEDDINGS_PROVIDER=openai with no OPENAI_API_KEY: the provider
// cannot initialize, which used to make /v1/search fail with a 500. Search must
// instead degrade to lexical ranking, still retrieve the content, and report the
// truth (provider "uninitialized", ranking "lexical").
const db = require("../../lib/db");
const { issueApiKey } = require("../../lib/auth");
const { app } = require("../../server");

(async () => {
  const { key } = issueApiKey(db, { tenantId: "deg", containerTag: "deg" });
  db.addDocument({
    id: "deg-1",
    containerTag: "deg",
    content: "I work at Acme Corp in Berlin",
    createdAt: new Date().toISOString(),
    embedding: null,
  });

  const srv = app.listen(0);
  await new Promise((resolve) => srv.once("listening", resolve));
  const port = srv.address().port;
  const url =
    `http://127.0.0.1:${port}/v1/search?containerTag=deg&q=` +
    encodeURIComponent("where do I work");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  const body = await res.text();
  process.stdout.write("RESULT " + JSON.stringify({ status: res.status, body }) + "\n");
  await new Promise((resolve) => srv.close(resolve));
  db.close();
  process.exit(0);
})().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + "\n");
  process.exit(1);
});

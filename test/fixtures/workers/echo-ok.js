// Test fixture: a worker that replies with a fixed success payload after an
// optional delay. Used to exercise the runner's concurrency bound, deadline, and
// shutdown behavior without depending on real PDF timing.
const { parentPort, workerData } = require("node:worker_threads");

const ms = (workerData && workerData.ms) || 0;
setTimeout(() => {
  parentPort.postMessage({ ok: true, pages: [{ page: 1, text: "ok" }], pageCount: 1 });
}, ms);

// Test fixture: a worker that never replies but keeps its event loop alive. The
// parent must terminate it when the deadline expires.
const { parentPort } = require("node:worker_threads");

parentPort; // keep the reference explicit
setInterval(() => {}, 1000);

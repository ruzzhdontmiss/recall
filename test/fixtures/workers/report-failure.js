// Test fixture: a worker that reports a structured, non-fatal failure.
const { parentPort } = require("node:worker_threads");

parentPort.postMessage({ ok: false, status: 422, code: "pdf_unreadable" });

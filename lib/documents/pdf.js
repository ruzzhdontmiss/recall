// Isolated, bounded PDF processing.
//
// PDF.js parsing is untrusted CPU work, so it never runs in the main server: each
// job executes in its own worker thread. This module owns the policy around that:
//   - a hard wall-clock deadline per job (the worker is terminated on expiry);
//   - bounded concurrency (a small pool of active workers plus a bounded queue);
//   - guaranteed cleanup — the thread is always reaped and its slot always freed,
//     on success, error, crash, timeout, or shutdown.
//
// A worker is never reused after a job. That costs a small spawn latency per PDF,
// but it is the only way to guarantee that a terminated/timed-out parser cannot
// leave shared state behind, and it keeps memory bounded.

const path = require("path");
const { Worker } = require("node:worker_threads");
const { httpError } = require("./errors");

const DEFAULT_WORKER = path.join(__dirname, "pdf-worker.js");

function toPosInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// A runner owns the concurrency budget and the set of live worker threads.
function createPdfRunner(options = {}) {
  const scriptPath = options.scriptPath || DEFAULT_WORKER;
  const maxConcurrent = toPosInt(options.maxConcurrent, 2);
  const maxQueued = toPosInt(options.maxQueued, 64);
  const heapMb = toPosInt(options.heapMb, 0); // 0 = use the Node default heap limit

  let active = 0;
  let peakActive = 0;
  const queue = [];
  const live = new Set();
  let closing = false;

  // Reserve a slot, or queue behind the current jobs. Throws when the queue is
  // full so a burst of uploads is shed rather than buffered without bound.
  function takeSlot() {
    if (active < maxConcurrent) {
      active += 1;
      if (active > peakActive) peakActive = active;
      return null;
    }
    if (queue.length >= maxQueued) {
      throw httpError(503, "pdf_busy", "too many PDF jobs are already in progress");
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  // Free the slot. If a job is waiting, hand the slot straight to it (the active
  // count is unchanged); otherwise decrement.
  function freeSlot() {
    const next = queue.shift();
    if (next) {
      next();
      return;
    }
    if (active > 0) active -= 1;
  }

  function execute(job) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(scriptPath, {
          workerData: job.workerData,
          resourceLimits: heapMb > 0 ? { maxOldGenerationSizeMb: heapMb } : undefined,
        });
      } catch {
        freeSlot();
        reject(httpError(500, "pdf_worker_start_failed", "PDF worker failed to start"));
        return;
      }

      live.add(worker);
      let settled = false;
      let timer = null;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        live.delete(worker);
        // Always reap the thread, even on success: this releases its memory and
        // guarantees a timeout or crash cannot leave a zombie worker behind.
        worker.terminate().catch(() => {});
        freeSlot();
        if (err) reject(err);
        else resolve(value);
      };

      timer = setTimeout(
        () => finish(httpError(422, "pdf_timeout", "document parsing timed out")),
        job.timeoutMs
      );

      worker.on("message", (msg) => {
        if (!msg || typeof msg !== "object" || typeof msg.ok !== "boolean") {
          return finish(httpError(500, "pdf_worker_failed", "PDF worker returned an invalid result"));
        }
        if (msg.ok) return finish(null, { pages: msg.pages, pageCount: msg.pageCount });
        finish(httpError(msg.status || 422, msg.code || "pdf_unreadable", "could not read PDF"));
      });
      worker.on("error", (err) => {
        const missing = err && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "ERR_WORKER_PATH");
        finish(
          httpError(
            500,
            missing ? "pdf_worker_start_failed" : "pdf_worker_failed",
            "PDF worker failed"
          )
        );
      });
      worker.on("exit", () => {
        // A clean exit without a message (e.g. process.exit inside the worker, or
        // the thread being terminated by the deadline) is a failure.
        if (!settled) finish(httpError(500, "pdf_worker_failed", "PDF worker exited unexpectedly"));
      });
    });
  }

  // Run one job. Resolves with { pages, pageCount } or rejects with an
  // HTTP-shaped error. Never leaves a slot held.
  async function run(job) {
    if (closing) throw httpError(503, "shutting_down", "service is shutting down");
    const wait = takeSlot();
    if (wait) await wait;
    if (closing) {
      freeSlot();
      throw httpError(503, "shutting_down", "service is shutting down");
    }
    return execute(job);
  }

  // Terminate every live worker and fail every queued job. Idempotent.
  function shutdown() {
    if (closing && live.size === 0 && queue.length === 0) return;
    closing = true;
    while (queue.length) {
      const next = queue.shift();
      next();
    }
    for (const worker of live) {
      worker.terminate().catch(() => {});
    }
    live.clear();
    active = 0;
  }

  function stats() {
    return { active, queued: queue.length, live: live.size, peakActive, maxConcurrent };
  }

  return { run, shutdown, stats, isClosed: () => closing };
}

// --------------------------------------------------------------- default ----

// The process-wide runner used by the ingestion pipeline. Recreated only if the
// concurrency configuration changes (previous live workers are shut down first so
// nothing is orphaned).
let defaultRunner = null;
let defaultKey = null;

function runnerKey(cfg) {
  return `${cfg.pdfMaxConcurrent}:${cfg.pdfMaxQueue}:${cfg.pdfWorkerHeapMb}`;
}

function getDefaultRunner(cfg) {
  const key = runnerKey(cfg);
  if (!defaultRunner || defaultKey !== key) {
    if (defaultRunner) defaultRunner.shutdown();
    defaultRunner = createPdfRunner({
      maxConcurrent: cfg.pdfMaxConcurrent,
      maxQueued: cfg.pdfMaxQueue,
      heapMb: cfg.pdfWorkerHeapMb,
    });
    defaultKey = key;
  }
  return defaultRunner;
}

// Extract text from a PDF buffer in an isolated worker. Rejects with an
// HTTP-shaped error ({ status, code }) on any failure.
async function extractPdfIsolated(buffer, cfg, opts = {}) {
  const runner = opts.runner || getDefaultRunner(cfg);
  return runner.run({
    timeoutMs: opts.timeoutMs || cfg.pdfTimeoutMs,
    workerData: {
      buffer,
      maxPdfPages: opts.maxPdfPages || cfg.maxPdfPages,
      maxExtractedChars: opts.maxExtractedChars || cfg.maxExtractedChars,
    },
  });
}

// Terminate any default-runner workers (server shutdown / tests).
function shutdownPdfWorkers() {
  if (defaultRunner) defaultRunner.shutdown();
}

module.exports = {
  createPdfRunner,
  extractPdfIsolated,
  shutdownPdfWorkers,
  DEFAULT_WORKER,
};

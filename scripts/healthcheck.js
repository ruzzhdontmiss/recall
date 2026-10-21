#!/usr/bin/env node
// Health probe for containers and orchestrators.
//
// Exits 0 when the instance reports ready, non-zero otherwise. Defaults to the
// readiness endpoint (a not-ready instance should be taken out of rotation or
// restarted); set HEALTHCHECK_PATH=/healthz for a pure liveness probe.
//
// Reads HOST/PORT-equivalent settings, so it works inside the container where the
// server binds 0.0.0.0 but the probe must connect over loopback.

const host = process.env.HEALTHCHECK_HOST || "127.0.0.1";
const port = process.env.PORT || 6767;
const endpoint = process.env.HEALTHCHECK_PATH || "/readyz";
const url = `http://${host}:${port}${endpoint}`;
const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS) || 4000;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

fetch(url, { signal: controller.signal })
  .then((res) => {
    clearTimeout(timer);
    process.exit(res.ok ? 0 : 1);
  })
  .catch(() => {
    clearTimeout(timer);
    process.exit(1);
  });

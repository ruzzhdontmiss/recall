// Central configuration reading and validation.
//
// Every setting has a safe default. An explicitly-set value that is invalid fails
// fast at startup with a clear, secret-free message, instead of being silently
// replaced by the default — a typo in a deployment env file should surface
// immediately, not as odd runtime behaviour (against a wrong port, say).

// Parse a positive (or zero, when `min` is 0) integer env var. Unset/empty falls
// back; anything else that is not a plain integer in range throws.
function posIntEnv(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const text = String(raw).trim();
  const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `between ${min} and ${max}`;
  if (!/^\d+$/.test(text)) {
    throw new Error(`invalid ${name}=${JSON.stringify(raw)} (expected an integer ${range})`);
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`invalid ${name}=${JSON.stringify(raw)} (expected an integer ${range})`);
  }
  return n;
}

const AUTH_MODES = new Set(["required", "dev"]);

// Read + validate the server's own configuration. Only values that are set are
// validated; defaults are always valid.
function readServerConfig(env = process.env) {
  const authMode = String(env.AUTH_MODE || "required").toLowerCase().trim();
  if (!AUTH_MODES.has(authMode)) {
    throw new Error(`unknown AUTH_MODE=${JSON.stringify(env.AUTH_MODE)} (expected "required" or "dev")`);
  }
  if (authMode === "dev" && env.NODE_ENV === "production") {
    throw new Error("AUTH_MODE=dev is not allowed when NODE_ENV=production");
  }

  // A bare hostname or IP address only — never a URL/scheme or a path.
  const host = env.HOST && String(env.HOST).trim() ? String(env.HOST).trim() : "127.0.0.1";
  if (/[\s/]/.test(host) || host.includes("://")) {
    throw new Error(
      `invalid HOST=${JSON.stringify(env.HOST)} (expected a bare hostname or IP address)`
    );
  }

  const corsOrigins = String(env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of corsOrigins) {
    if (origin === "*" || !/^https?:\/\/[^/\s]+$/i.test(origin)) {
      throw new Error(
        `invalid CORS_ORIGINS entry ${JSON.stringify(origin)} ` +
          "(expected an explicit http(s) origin, never a wildcard)"
      );
    }
  }

  return {
    authMode,
    host,
    port: posIntEnv(env, "PORT", 6767, { min: 1, max: 65535 }),
    devTenant: env.DEV_TENANT || "dev",
    devContainer: env.DEV_CONTAINER || "dev",
    generalMax: posIntEnv(env, "RATE_LIMIT_PER_MIN", 120),
    expensiveMax: posIntEnv(env, "RATE_LIMIT_EXPENSIVE_PER_MIN", 30),
    corsOrigins,
  };
}

module.exports = { posIntEnv, readServerConfig };

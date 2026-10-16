// In-memory fixed-window rate limiter.
//
// Single process only. It deliberately does not claim to be a distributed
// limiter — with multiple processes each would keep its own counters (see the
// "Limitations" section of the README).

function createLimiter({ windowMs = 60_000, max = 120 } = {}) {
  const buckets = new Map();
  let lastSweep = 0;

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return {
    limit: max,
    check(id, now = Date.now()) {
      sweep(now);
      let bucket = buckets.get(id);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(id, bucket);
      }
      bucket.count += 1;
      const allowed = bucket.count <= max;
      return {
        allowed,
        limit: max,
        remaining: Math.max(0, max - bucket.count),
        resetAt: bucket.resetAt,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    },
    reset() {
      buckets.clear();
    },
  };
}

function createRateLimitMiddleware({ limiter, identify }) {
  return function rateLimit(req, res, next) {
    const result = limiter.check(identify(req));
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSec));
      return res.status(429).json({ error: "rate limit exceeded" });
    }
    return next();
  };
}

module.exports = { createLimiter, createRateLimitMiddleware };

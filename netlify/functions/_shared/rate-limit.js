/**
 * Best-effort per-IP limiter. The map lives in one function instance only,
 * so a burst can exceed the cap when Netlify runs more than one isolate.
 * Limits themselves are documented in limits.js.
 */

const buckets = new Map();

export function clientIp(req) {
  const nf = req.headers.get("x-nf-client-connection-ip");
  if (nf) return nf.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

export function takeToken(bucket, ip, limit, windowMs, now = Date.now()) {
  const key = `${bucket}:${ip || "unknown"}`;
  let entry = buckets.get(key);
  if (!entry || now - entry.start >= windowMs) {
    entry = { start: now, count: 0 };
    buckets.set(key, entry);
  }
  entry.count += 1;

  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (now - v.start >= windowMs) buckets.delete(k);
    }
  }

  if (entry.count > limit) {
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)),
    };
  }
  return { ok: true, remaining: limit - entry.count };
}

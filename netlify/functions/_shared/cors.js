/**
 * Browser CORS for every function.
 *
 * Default allow-list is GeoDataTrack over HTTPS only:
 *   https://app.geodatatrack.com
 *   https://api.geodatatrack.com
 *   https://*.geodatatrack.com
 *
 * Override with the env var ALLOWED_ORIGINS (comma-separated). "*" is ignored.
 * http:// origins are never reflected.
 *
 * A request whose Origin host equals this function's Host is treated as
 * same-site so the hm-eia widget can call its own functions. Any other
 * origin is rejected with 403 and no Access-Control-Allow-Origin.
 * Requests with no Origin (non-browser) are allowed and get no ACAO header.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  "https://app.geodatatrack.com",
  "https://api.geodatatrack.com",
  "https://*.geodatatrack.com",
];

function envGet(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env && typeof Netlify.env.get === "function") {
      const value = Netlify.env.get(name);
      if (value) return value;
    }
  } catch {
    /* Netlify global is absent in local tests */
  }
  return process.env[name] || "";
}

export function allowedOriginList() {
  const raw = envGet("ALLOWED_ORIGINS");
  if (!raw || !String(raw).trim()) return DEFAULT_ALLOWED_ORIGINS.slice();
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "*" && s.toLowerCase().startsWith("https://"));
  return list.length ? list : DEFAULT_ALLOWED_ORIGINS.slice();
}

export function originAllowed(origin, allowList = allowedOriginList()) {
  if (typeof origin !== "string" || !origin || origin === "null") return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.search || url.hash) return false;

  const serialized = url.origin;
  const host = url.hostname.toLowerCase();

  for (const entry of allowList) {
    if (!entry.startsWith("https://")) continue;
    if (entry === serialized) return true;
    if (entry.startsWith("https://*.")) {
      const suffix = entry.slice("https://*.".length).toLowerCase();
      if (!suffix || suffix.includes("*") || suffix.includes("/")) continue;
      if (host.endsWith(`.${suffix}`) && host !== suffix) return true;
    }
  }
  return false;
}

function sameHost(req, origin) {
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    return Boolean(host) && host === originHost;
  } catch {
    return false;
  }
}

export function corsDecision(req) {
  const origin = req.headers.get("origin");
  if (!origin) return { allow: true, reflect: null };
  if (originAllowed(origin) || sameHost(req, origin)) {
    return { allow: true, reflect: origin };
  }
  return { allow: false, reflect: null };
}

function applyCors(headers, decision) {
  headers.Vary = "Origin";
  if (decision.reflect) {
    headers["Access-Control-Allow-Origin"] = decision.reflect;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
}

export function preflight(req) {
  const decision = corsDecision(req);
  if (!decision.allow) {
    return new Response(JSON.stringify({ error: "Origin not allowed" }), {
      status: 403,
      headers: { "Content-Type": "application/json", Vary: "Origin" },
    });
  }
  const headers = {};
  applyCors(headers, decision);
  if (decision.reflect) headers["Access-Control-Max-Age"] = "600";
  return new Response(null, { status: 204, headers });
}

export function jsonResponse(req, data, status = 200, extra = {}) {
  const decision = corsDecision(req);
  if (!decision.allow) {
    return new Response(JSON.stringify({ error: "Origin not allowed" }), {
      status: 403,
      headers: { "Content-Type": "application/json", Vary: "Origin" },
    });
  }
  const headers = { "Content-Type": "application/json", ...extra };
  applyCors(headers, decision);
  return new Response(JSON.stringify(data), { status, headers });
}

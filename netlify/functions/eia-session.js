import { preflight, jsonResponse } from "./_shared/cors.js";
import { clientIp, takeToken } from "./_shared/rate-limit.js";
import { buildGdtGetUrl } from "./_shared/gdt-allow.js";
import { authSecret, chatPassphrase, secretsMatch, sessionTtlSeconds, signSession } from "./_shared/eia-auth.js";

/**
 * Issues a short-lived HMAC session.
 *
 * grant "gdt": the caller presents a GeoDataTrack bearer. This function
 * checks it with one GET to an allow-listed /oauth/ path, and attaches a
 * property apikey only when a second GET confirms that property.
 * grant "passphrase": standalone chat. EIA_CHAT_PASSPHRASE is compared
 * on the server. The browser never receives a long-lived app secret.
 *
 * Neither grant spends the Anthropic key.
 */

const SESSION_LIMIT = 10;
const SESSION_WINDOW_MS = 10 * 60 * 1000;

function bearer(token) {
  const text = String(token || "").trim();
  if (!text) return "";
  return text.toLowerCase().startsWith("bearer ") ? text : `Bearer ${text}`;
}

async function gdtGet(url, token, fetchImpl) {
  const resp = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      Authorization: bearer(token),
      Accept: "application/json",
    },
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, data };
}

function propertyConfirmed(data, propertyApikey) {
  const want = String(propertyApikey);
  const items = [];
  if (Array.isArray(data?.list)) items.push(...data.list);
  if (Array.isArray(data?.data)) items.push(...data.data);
  else if (data?.data && typeof data.data === "object") items.push(data.data);
  if (data && typeof data === "object" && !Array.isArray(data)) items.push(data);
  return items.some((item) => {
    if (!item || typeof item !== "object") return false;
    const id = item.property_apikey || item._apikey || item.apikey;
    return id && String(id) === want;
  });
}

function orgFrom(data) {
  const record = data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : data;
  if (!record || typeof record !== "object") return "";
  return String(record.org_apikey || record.organisation_apikey || "");
}

async function grantFromGdt(body, fetchImpl) {
  const base = body.base;
  const token = body.token;
  if (!base || !token) return { error: "Missing base or token", status: 400 };
  const bootstrapUrl = buildGdtGetUrl(base, "/oauth/bootstrap") || buildGdtGetUrl(base, "/oauth/org");
  if (!bootstrapUrl) return { error: "Base is not an allow-listed GeoDataTrack host", status: 400 };
  let bootstrap;
  try {
    bootstrap = await gdtGet(bootstrapUrl, token, fetchImpl);
  } catch (err) {
    console.error("[eia-session]", err.message);
    return { error: "GeoDataTrack could not be reached", status: 502 };
  }
  if (!bootstrap.ok) return { error: "GeoDataTrack rejected the token", status: 401 };

  let propertyApikey = "";
  const requested = typeof body.property_apikey === "string" ? body.property_apikey.trim() : "";
  if (requested) {
    const propertyUrl = buildGdtGetUrl(base, "/oauth/properties", { property_apikey: requested });
    if (propertyUrl) {
      try {
        const found = await gdtGet(propertyUrl, token, fetchImpl);
        if (found.ok && propertyConfirmed(found.data, requested)) propertyApikey = requested;
      } catch (err) {
        console.error("[eia-session] property", err.message);
      }
    }
  }

  const session = signSession({
    sub: "gdt",
    property_apikey: propertyApikey,
    org: orgFrom(bootstrap.data),
  });
  if (!session) return { error: "EIA_AUTH_SECRET is not set", status: 503 };
  return { token: session, property_apikey: propertyApikey };
}

function grantFromPassphrase(body) {
  const expected = chatPassphrase();
  if (!expected) return { error: "Chat passphrase is not configured", status: 503 };
  if (!secretsMatch(body.passphrase, expected)) return { error: "Unauthorised", status: 401 };
  const session = signSession({ sub: "chat" });
  if (!session) return { error: "EIA_AUTH_SECRET is not set", status: 503 };
  return { token: session, property_apikey: "" };
}

export default async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method not allowed" }, 405);

  const limit = takeToken("session", clientIp(req), SESSION_LIMIT, SESSION_WINDOW_MS);
  if (!limit.ok) {
    return jsonResponse(req, { error: "Rate limit exceeded" }, 429, { "Retry-After": String(limit.retryAfter) });
  }

  if (!authSecret()) return jsonResponse(req, { error: "EIA_AUTH_SECRET is not set" }, 503);

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { error: "Invalid JSON" }, 400);
  }

  let grant;
  if (body?.grant === "passphrase") grant = grantFromPassphrase(body);
  else if (body?.grant === "gdt") grant = await grantFromGdt(body, globalThis.fetch);
  else grant = { error: "Unknown grant", status: 400 };

  if (grant.error) return jsonResponse(req, { error: grant.error }, grant.status);
  return jsonResponse(req, {
    token: grant.token,
    token_type: "Bearer",
    expires_in: sessionTtlSeconds(),
    property_apikey: grant.property_apikey || "",
  }, 200);
};

export const config = {
  path: "/api/eia-session",
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};

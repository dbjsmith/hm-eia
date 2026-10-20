/**
 * Credentials for the Anthropic-backed endpoints.
 *
 * CORS is not authentication. A request with no Origin is a non-browser
 * client and must still present a credential.
 *
 * Two credentials are accepted:
 *   - a short-lived HMAC session from eia-session (widget or passphrase chat)
 *   - EIA_APP_SECRET, a shared secret for a server-side caller (never put
 *     this in the browser bundle)
 *
 * If neither EIA_AUTH_SECRET nor EIA_APP_SECRET is set, chat and
 * eia-analyze refuse the request. The Anthropic key is not spent.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { envGet } from "./llm.js";

export const DEFAULT_SESSION_TTL_SECONDS = 2 * 60 * 60;

export function authSecret() {
  return String(envGet("EIA_AUTH_SECRET") || "");
}

export function appSecret() {
  return String(envGet("EIA_APP_SECRET") || "");
}

export function chatPassphrase() {
  return String(envGet("EIA_CHAT_PASSPHRASE") || "");
}

export function sessionTtlSeconds() {
  const n = Number(envGet("EIA_SESSION_TTL_SECONDS"));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_TTL_SECONDS;
  return Math.min(Math.floor(n), 24 * 60 * 60);
}

export function secretsMatch(given, expected) {
  if (!expected || !given) return false;
  const left = Buffer.from(String(given));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function signBody(body, secret) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signSession(claims = {}, now = Date.now()) {
  const secret = authSecret();
  if (!secret) return null;
  const payload = {
    v: 1,
    exp: Math.floor(now / 1000) + sessionTtlSeconds(),
    sub: claims.sub === "chat" ? "chat" : "gdt",
    property_apikey: claims.property_apikey ? String(claims.property_apikey) : "",
    org: claims.org ? String(claims.org) : "",
  };
  const body = encodePayload(payload);
  return `${body}.${signBody(body, secret)}`;
}

export function verifySession(token, now = Date.now()) {
  const secret = authSecret();
  if (!secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = signBody(parts[0], secret);
  if (!secretsMatch(parts[1], expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || !payload.exp) return null;
  if (payload.exp * 1000 <= now) return { expired: true };
  return {
    ok: true,
    sub: payload.sub === "chat" ? "chat" : "gdt",
    property_apikey: payload.property_apikey ? String(payload.property_apikey) : "",
    org: payload.org ? String(payload.org) : "",
    exp: payload.exp,
  };
}

export function presentedBearer(req) {
  const auth = req.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const header = req.headers.get("x-eia-token");
  return header ? header.trim() : "";
}

export function authoriseRequest(req, now = Date.now()) {
  if (!authSecret() && !appSecret()) {
    return { ok: false, status: 503, error: "EIA auth is not configured" };
  }
  const token = presentedBearer(req);
  if (!token) return { ok: false, status: 401, error: "Missing credentials" };
  if (appSecret() && secretsMatch(token, appSecret())) {
    return { ok: true, kind: "app", property_apikey: "", org: "" };
  }
  const session = verifySession(token, now);
  if (!session) return { ok: false, status: 401, error: "Unauthorised" };
  if (session.expired) return { ok: false, status: 401, error: "Session expired" };
  return {
    ok: true,
    kind: session.sub,
    property_apikey: session.property_apikey || "",
    org: session.org || "",
  };
}

/**
 * Report-binding verifier.
 *
 * A GeoDataTrack assertion is canonical JSON signed with Ed25519. This
 * process holds public keys only, looked up by kid. With no configured
 * public key, every token returns issuer_unavailable. No key is built in.
 *
 * HMAC-SHA256 is accepted only when allowHmac is exactly true and a secret
 * is configured. The default is off.
 *
 * Replay of request_id uses an onlyIfNew write. A missing replay store
 * fails closed after a signature would otherwise have been accepted.
 */

import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

export const EOV_AUDIENCE = "eia-eov-report";
export const ASSERTION_ISS = "geodatatrack-dev";
export const ASSERTION_TTL_SECONDS = 5 * 60;
export const ASSERTION_SKEW_SECONDS = 30;

export const ASSERTION_KEYS = [
  "iss",
  "aud",
  "install_id",
  "org_id",
  "property_id",
  "report_id",
  "sha256",
  "ai_consent",
  "consent_id",
  "consent_changed_at",
  "request_id",
  "iat",
  "exp",
  "kid",
];

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,80}$/;
const KID = /^[A-Za-z0-9._:-]{1,64}$/;

export function unavailableBindingVerifier() {
  return reportBindingVerifier({});
}

export function fixtureBindingVerifier(records) {
  const table = records instanceof Map ? records : new Map();
  return {
    kind: "test-fixture",
    gdtSignature: false,
    async verify(token) {
      if (typeof token !== "string" || !table.has(token)) {
        return { ok: false, reason: "binding_rejected" };
      }
      const claims = table.get(token);
      if (!claims || typeof claims !== "object") return { ok: false, reason: "binding_rejected" };
      return { ok: true, claims };
    },
  };
}

export function readBindingConfig(env = process.env) {
  let keys = {};
  if (typeof env.EIA_EOV_BINDING_KEYS === "string" && env.EIA_EOV_BINDING_KEYS.trim()) {
    try {
      const parsed = JSON.parse(env.EIA_EOV_BINDING_KEYS);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) keys = parsed;
    } catch {
      keys = {};
    }
  }
  const allowHmac = env.EIA_EOV_BINDING_HMAC === "true";
  return {
    keys,
    allowHmac,
    hmacSecret: allowHmac ? String(env.EIA_EOV_BINDING_HMAC_SECRET || "") : "",
    audience: EOV_AUDIENCE,
  };
}

export function canonicalAssertion(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (Object.keys(payload).length !== ASSERTION_KEYS.length) return null;
  const ordered = {};
  for (const key of ASSERTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) return null;
    ordered[key] = payload[key];
  }
  if (typeof ordered.iss !== "string" || typeof ordered.aud !== "string") return null;
  for (const key of ["install_id", "org_id", "property_id", "report_id", "consent_id", "request_id"]) {
    if (typeof ordered[key] !== "string" || !ID.test(ordered[key])) return null;
  }
  if (typeof ordered.kid !== "string" || !KID.test(ordered.kid)) return null;
  if (typeof ordered.sha256 !== "string" || !SHA256.test(ordered.sha256)) return null;
  if (typeof ordered.ai_consent !== "boolean") return null;
  if (typeof ordered.consent_changed_at !== "string" || !INSTANT.test(ordered.consent_changed_at)) return null;
  if (!Number.isInteger(ordered.iat) || !Number.isInteger(ordered.exp)) return null;
  return JSON.stringify(ordered);
}

export function packAssertion(alg, payload, signature) {
  const canonical = canonicalAssertion(payload);
  if (!canonical || (alg !== "ed25519" && alg !== "hmac-sha256")) return null;
  const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  return `${alg}.${Buffer.from(canonical, "utf8").toString("base64url")}.${sig.toString("base64url")}`;
}

function configuredKids(keys) {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return [];
  return Object.keys(keys).filter((kid) => typeof keys[kid] === "string" && keys[kid].trim());
}

function digestBytes(reportBytes) {
  return createHash("sha256").update(Buffer.from(reportBytes)).digest("hex");
}

function signatureOk(alg, canonical, signature, config, kid) {
  if (alg === "hmac-sha256") {
    if (config.allowHmac !== true) return { ok: false, reason: "hmac_disabled" };
    if (!config.hmacSecret) return { ok: false, reason: "issuer_unavailable" };
    const expected = createHmac("sha256", config.hmacSecret).update(canonical).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      return { ok: false, reason: "binding_rejected" };
    }
    return { ok: true };
  }
  if (alg !== "ed25519") return { ok: false, reason: "binding_rejected" };
  const pem = config.keys?.[kid];
  if (typeof pem !== "string" || !pem.trim()) return { ok: false, reason: "unknown_kid" };
  try {
    const publicKey = createPublicKey(pem);
    if (publicKey.asymmetricKeyType !== "ed25519") return { ok: false, reason: "unknown_kid" };
    const ok = verify(null, Buffer.from(canonical, "utf8"), publicKey, signature);
    return ok ? { ok: true } : { ok: false, reason: "binding_rejected" };
  } catch {
    return { ok: false, reason: "issuer_unavailable" };
  }
}

function windowReason(payload, now) {
  if (payload.exp <= payload.iat || payload.exp - payload.iat > ASSERTION_TTL_SECONDS) return "assertion_window";
  const nowSec = Math.floor(now / 1000);
  if (payload.iat > nowSec + ASSERTION_SKEW_SECONDS) return "assertion_not_yet_valid";
  if (nowSec > payload.exp + ASSERTION_SKEW_SECONDS) return "assertion_expired";
  return null;
}

async function claimRequest(replayStore, requestId) {
  if (!replayStore || typeof replayStore.setJSON !== "function") {
    return { ok: false, reason: "replay_unverified" };
  }
  try {
    const wrote = await replayStore.setJSON(
      `eov-report-v0/request/${requestId}`,
      { request_id: requestId },
      { onlyIfNew: true },
    );
    if (!wrote || wrote.modified !== true) return { ok: false, reason: "replay_rejected" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "replay_unverified" };
  }
}

export function reportBindingVerifier(config = {}) {
  const keys = config.keys && typeof config.keys === "object" ? config.keys : {};
  const kids = configuredKids(keys);
  const hmacReady = config.allowHmac === true && Boolean(config.hmacSecret);
  return {
    kind: kids.length ? "ed25519" : "issuer_unavailable",
    gdtSignature: false,
    async verify(token, context = {}) {
      if (!kids.length && !hmacReady) return { ok: false, reason: "issuer_unavailable" };
      if (typeof token !== "string") return { ok: false, reason: "binding_rejected" };
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "binding_rejected" };
      const [alg, body, sigPart] = parts;
      let payload;
      let canonical;
      try {
        canonical = Buffer.from(body, "base64url").toString("utf8");
        payload = JSON.parse(canonical);
      } catch {
        return { ok: false, reason: "binding_rejected" };
      }
      const expected = canonicalAssertion(payload);
      if (!expected || expected !== canonical) return { ok: false, reason: "binding_rejected" };
      let signature;
      try {
        signature = Buffer.from(sigPart, "base64url");
      } catch {
        return { ok: false, reason: "binding_rejected" };
      }
      const signed = signatureOk(alg, canonical, signature, { ...config, keys }, payload.kid);
      if (!signed.ok) return signed;
      if (payload.iss !== ASSERTION_ISS) return { ok: false, reason: "issuer_mismatch" };
      if (payload.aud !== (config.audience || EOV_AUDIENCE)) return { ok: false, reason: "audience_mismatch" };
      const timing = windowReason(payload, context.now ?? Date.now());
      if (timing) return { ok: false, reason: timing };
      if (payload.ai_consent !== true) return { ok: false, reason: "ai_consent_required" };
      if (context.reportBytes == null) return { ok: false, reason: "report_bytes_required" };
      if (digestBytes(context.reportBytes) !== payload.sha256) return { ok: false, reason: "sha256_mismatch" };
      const replay = await claimRequest(context.replayStore, payload.request_id);
      if (!replay.ok) return replay;
      return {
        ok: true,
        claims: {
          assertion: true,
          iss: payload.iss,
          aud: payload.aud,
          audience: payload.aud,
          install_id: payload.install_id,
          org_id: payload.org_id,
          property_id: payload.property_id,
          report_id: payload.report_id,
          sha256: payload.sha256,
          ai_consent: true,
          primary_consent: true,
          consent_id: payload.consent_id,
          confirmation_id: payload.consent_id,
          consent_changed_at: payload.consent_changed_at,
          request_id: payload.request_id,
          iat: payload.iat,
          exp: payload.exp,
          kid: payload.kid,
        },
      };
    },
  };
}

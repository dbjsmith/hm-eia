/**
 * Report-binding verifier for GeoDataTrack contract report-bytes-v1.1.
 *
 * A GDT assertion is a JWS compact string (RFC 7515): header.payload.signature,
 * each part base64url without padding. The header is canonical JSON
 * {"alg":"EdDSA","kid":"<kid>","typ":"gdt-report+jws"}. The payload is
 * canonical JSON of fourteen claims (keys sorted, no spaces, slashes and
 * UTF-8 unescaped). The Ed25519 signature is over the ASCII bytes
 * "header.payload". This process holds public keys only.
 *
 * The GDT dev TEST key (issuer geodatatrack-dev, kid
 * gdt-dev-20261111-5e0d4528) is trusted only when Netlify CONTEXT is not
 * "production" and EIA_GDT_TRUST_DEV_KEY is exactly "true". In production
 * it cannot be trusted, even if the flag is set or the key is supplied in
 * EIA_EOV_BINDING_KEYS. The TEST issuer is refused in production for any
 * kid. With no trusted key, every token returns issuer_unavailable.
 *
 * Replay of request_id uses an onlyIfNew write. A missing replay store
 * fails closed after a signature would otherwise have been accepted.
 *
 * Aligns with claude/GDT_ReportBytes_Contract.md (Prompt 435) as read
 * from BlueBox-WorldWide/geodatatrack on the development branch,
 * blob SHA a166da6bb901d09f99555759304fbe3ac8c168c9.
 */

import { createHash, createPublicKey, verify } from "node:crypto";

export const CONTRACT_V11 = "report-bytes-v1.1";
export const EOV_AUDIENCE = "eia-eov-report";
export const ASSERTION_ISS = "geodatatrack-dev";
export const ASSERTION_TTL_SECONDS = 5 * 60;
export const ASSERTION_SKEW_SECONDS = 30;
export const DEV_KID = "gdt-dev-20261111-5e0d4528";
export const DEV_PUBLIC_KEY_B64U = "Z6C7bDe7rY3axBbmNGT08HUNAEgai2B-lf6w_1BgOPE";

/** Fourteen v1.1 claims, sorted as GDT's canonical JSON requires. */
export const ASSERTION_KEYS = [
  "ai_consent",
  "aud",
  "consent_at",
  "consent_id",
  "exp",
  "iat",
  "install_id",
  "iss",
  "kid",
  "org_id",
  "property_id",
  "report_id",
  "request_id",
  "sha256",
];

const SHA256 = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const CONSENT_AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const AUD = /^gdt-app:\d+$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export function trustDevIssuer(env = process.env) {
  if (env.CONTEXT === "production") return false;
  return env.EIA_GDT_TRUST_DEV_KEY === "true";
}

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

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) return null;
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      const encoded = canonicalJson(item);
      if (encoded == null) return null;
      parts.push(encoded);
    }
    return `[${parts.join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const encoded = canonicalJson(value[key]);
      if (encoded == null) return null;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  }
  return null;
}

export function canonicalHeader(kid) {
  if (typeof kid !== "string" || !KID.test(kid)) return null;
  return canonicalJson({ alg: "EdDSA", kid, typ: "gdt-report+jws" });
}

function isInt(value) {
  return typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value);
}

export function canonicalAssertion(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (Object.keys(payload).length !== ASSERTION_KEYS.length) return null;
  const ordered = {};
  for (const key of ASSERTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) return null;
    ordered[key] = payload[key];
  }
  if (typeof ordered.iss !== "string" || ordered.iss.length < 1) return null;
  if (typeof ordered.aud !== "string" || !AUD.test(ordered.aud)) return null;
  for (const key of ["install_id", "org_id", "property_id", "report_id", "consent_id"]) {
    if (!isInt(ordered[key]) || ordered[key] < 0) return null;
  }
  if (typeof ordered.kid !== "string" || !KID.test(ordered.kid)) return null;
  if (typeof ordered.sha256 !== "string" || !SHA256.test(ordered.sha256)) return null;
  if (typeof ordered.ai_consent !== "boolean") return null;
  if (typeof ordered.consent_at !== "string") return null;
  if (ordered.consent_at !== "" && !CONSENT_AT.test(ordered.consent_at)) return null;
  if (typeof ordered.request_id !== "string" || !REQUEST_ID.test(ordered.request_id)) return null;
  if (!isInt(ordered.iat) || !isInt(ordered.exp)) return null;
  return canonicalJson(ordered);
}

function b64url(text) {
  return Buffer.from(text, "utf8").toString("base64url");
}

function b64urlDecode(text, expectedLength) {
  if (typeof text !== "string" || !B64URL.test(text)) return null;
  let buf;
  try {
    buf = Buffer.from(text, "base64url");
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.toString("base64url") !== text) return null;
  if (expectedLength != null && buf.length !== expectedLength) return null;
  return buf;
}

/**
 * Import an Ed25519 public key from a raw 32-byte base64url string, or
 * from a PEM SPKI block passed in by a test. Returns { key, raw } or null.
 */
export function importEd25519Public(material) {
  if (typeof material !== "string") return null;
  const s = material.trim();
  if (!s) return null;
  if (s.startsWith("-----")) {
    try {
      const key = createPublicKey(s);
      if (key.asymmetricKeyType !== "ed25519") return null;
      const jwk = key.export({ format: "jwk" });
      if (typeof jwk.x !== "string") return null;
      const raw = b64urlDecode(jwk.x, 32);
      if (!raw) return null;
      return { key, raw };
    } catch {
      return null;
    }
  }
  const raw = b64urlDecode(s, 32);
  if (!raw) return null;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
    if (key.asymmetricKeyType !== "ed25519") return null;
    return { key, raw };
  } catch {
    return null;
  }
}

export function packAssertion(payload, signature) {
  const header = canonicalHeader(payload?.kid);
  const body = canonicalAssertion(payload);
  if (!header || !body) return null;
  const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  if (sig.length !== 64) return null;
  return `${b64url(header)}.${b64url(body)}.${sig.toString("base64url")}`;
}

export function readBindingConfig(env = process.env) {
  let keys = {};
  if (typeof env.EIA_EOV_BINDING_KEYS === "string" && env.EIA_EOV_BINDING_KEYS.trim()) {
    try {
      const parsed = JSON.parse(env.EIA_EOV_BINDING_KEYS);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) keys = { ...parsed };
    } catch {
      keys = {};
    }
  }
  delete keys[DEV_KID];
  if (trustDevIssuer(env)) {
    keys[DEV_KID] = DEV_PUBLIC_KEY_B64U;
  }
  let audience = "";
  if (typeof env.EIA_GDT_AUD === "string" && env.EIA_GDT_AUD.trim()) {
    audience = env.EIA_GDT_AUD.trim();
  } else if (typeof env.EIA_GDT_APP_ID === "string" && /^\d+$/.test(env.EIA_GDT_APP_ID.trim())) {
    audience = `gdt-app:${env.EIA_GDT_APP_ID.trim()}`;
  }
  let installId = null;
  if (typeof env.EIA_GDT_INSTALL_ID === "string" && /^\d+$/.test(env.EIA_GDT_INSTALL_ID.trim())) {
    installId = Number(env.EIA_GDT_INSTALL_ID.trim());
  }
  return {
    keys,
    audience,
    installId,
    context: typeof env.CONTEXT === "string" ? env.CONTEXT : "",
  };
}

function deployContext(config) {
  if (typeof config.context === "string") return config.context;
  if (typeof process.env.CONTEXT === "string") return process.env.CONTEXT;
  return "";
}

function activeKeys(config) {
  const raw = config.keys && typeof config.keys === "object" && !Array.isArray(config.keys)
    ? { ...config.keys }
    : {};
  if (deployContext(config) === "production") {
    delete raw[DEV_KID];
  }
  return raw;
}

function configuredKids(keys) {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return [];
  return Object.keys(keys).filter((kid) => typeof keys[kid] === "string" && keys[kid].trim());
}

function digestBytes(reportBytes) {
  return createHash("sha256").update(Buffer.from(reportBytes)).digest("hex");
}

function importKeyMap(keys) {
  const imported = new Map();
  for (const kid of configuredKids(keys)) {
    const pub = importEd25519Public(keys[kid]);
    if (pub) imported.set(kid, pub.key);
  }
  return imported;
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

function parseJws(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts;
  const headerBytes = b64urlDecode(headerPart);
  const payloadBytes = b64urlDecode(payloadPart);
  const signature = b64urlDecode(sigPart, 64);
  if (!headerBytes || !payloadBytes || !signature) return null;
  let header;
  let payload;
  let headerJson;
  let payloadJson;
  try {
    headerJson = headerBytes.toString("utf8");
    payloadJson = payloadBytes.toString("utf8");
    header = JSON.parse(headerJson);
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) return null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return { headerPart, payloadPart, header, payload, headerJson, payloadJson, signature };
}

export function reportBindingVerifier(config = {}) {
  const contextName = deployContext(config);
  const keys = activeKeys({ ...config, context: contextName });
  const imported = importKeyMap(keys);
  return {
    kind: imported.size ? "ed25519" : "issuer_unavailable",
    gdtSignature: false,
    async verify(token, context = {}) {
      if (!imported.size) return { ok: false, reason: "issuer_unavailable" };
      const jws = parseJws(token);
      if (!jws) return { ok: false, reason: "binding_rejected" };
      const { header, payload, headerJson, payloadJson, headerPart, payloadPart, signature } = jws;
      if (header.alg !== "EdDSA" || header.typ !== "gdt-report+jws" || typeof header.kid !== "string") {
        return { ok: false, reason: "binding_rejected" };
      }
      const expectedHeader = canonicalHeader(header.kid);
      if (!expectedHeader || headerJson !== expectedHeader || Object.keys(header).length !== 3) {
        return { ok: false, reason: "binding_rejected" };
      }
      const publicKey = imported.get(header.kid);
      if (!publicKey) return { ok: false, reason: "unknown_kid" };
      let sigOk = false;
      try {
        sigOk = verify(null, Buffer.from(`${headerPart}.${payloadPart}`, "utf8"), publicKey, signature);
      } catch {
        return { ok: false, reason: "binding_rejected" };
      }
      if (!sigOk) return { ok: false, reason: "binding_rejected" };
      const expectedPayload = canonicalAssertion(payload);
      if (!expectedPayload || expectedPayload !== payloadJson) return { ok: false, reason: "binding_rejected" };
      if (payload.kid !== header.kid) return { ok: false, reason: "binding_rejected" };
      if (payload.iss !== ASSERTION_ISS) return { ok: false, reason: "issuer_mismatch" };
      if (contextName === "production") return { ok: false, reason: "issuer_not_for_production" };
      if (config.audience) {
        if (payload.aud !== config.audience) return { ok: false, reason: "audience_mismatch" };
      }
      if (isInt(config.installId) && payload.install_id !== config.installId) {
        return { ok: false, reason: "install_mismatch" };
      }
      if (typeof context.requestId === "string" && context.requestId !== payload.request_id) {
        return { ok: false, reason: "request_id_mismatch" };
      }
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
          contract: CONTRACT_V11,
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
          consent_at: payload.consent_at,
          request_id: payload.request_id,
          iat: payload.iat,
          exp: payload.exp,
          kid: payload.kid,
        },
      };
    },
  };
}

/**
 * EOV report adapter v0 — decision gate only.
 *
 * This module does not call a model, a shadow provider, GeoDataTrack, or
 * ecoregion.net. It does not write to GeoDataTrack. It does not accept PDF
 * bytes or a raw property apikey. A reading is not produced here.
 *
 * Prompt428 `ai_consent` is a reported same-row flag, not source-confirmed
 * and not a cryptographic consent proof. `false` withholds inference.
 * `true` still needs a server-bound report/property/digest, a separate
 * per-send confirmation, a concurrency-safe monetary reservation, and an
 * approved token policy. None of those exist in this process, so the
 * provider path stays closed.
 */

export const ADAPTER_VERSION = "eov-report-v0";

const SHA256 = /^[a-f0-9]{64}$/;
const RAW_PROPERTY_KEY = /^[a-f0-9]{40}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_KEYS = new Set([
  "property_apikey",
  "pdf",
  "pdf_bytes",
  "pdf_base64",
  "access_token",
  "authorization",
  "bound_scope",
  "trusted_scope",
  "budget",
]);

function decision(httpStatus, status, reason) {
  return {
    httpStatus,
    payload: {
      adapter_version: ADAPTER_VERSION,
      ok: status === "withheld",
      status,
      reason,
      provider_calls: 0,
      shadow_calls: 0,
      inference: "not_called",
      verification: "offline_gate",
      draft: null,
      writes_to_gdt: false,
    },
  };
}

function reasonForForbidden(key) {
  if (key === "property_apikey") return "raw_property_key_refused";
  if (key === "pdf" || key === "pdf_bytes" || key === "pdf_base64") return "pdf_bytes_refused";
  return "client_trust_refused";
}

function forbiddenKey(value, depth) {
  if (depth > 6 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    if (value.length > 20) return "invalid_body";
    for (const item of value) {
      const found = forbiddenKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return reasonForForbidden(key);
    const found = forbiddenKey(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function parseInstant(value) {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function scopeMismatch(body, boundScope) {
  if (boundScope.property_ref !== body.property_ref) return "scope_mismatch_property";
  if (boundScope.report_id !== body.report.report_id) return "scope_mismatch_report";
  if (boundScope.sha256 !== body.report.sha256) return "scope_mismatch_digest";
  const expires = parseInstant(boundScope.expires_at);
  if (expires == null) return "scope_expired";
  return null;
}

/**
 * @param {object} input
 * @param {object} input.body Client metadata. Never a PDF and never a property apikey.
 * @param {object|null} input.boundScope Server-injected binding. The HTTP handler passes null.
 * @param {{status?: string}|null} input.budget Server budget reservation. Unknown unless status is "reserved" or "exhausted".
 * @param {Set<string>|null} input.replayLedger Server replay ledger. Null means the ledger is not available. This function does not insert ids.
 * @param {number} input.now
 */
export function decideEovReport({
  body,
  boundScope = null,
  budget = null,
  replayLedger = null,
  now = Date.now(),
} = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return decision(400, "blocked", "invalid_body");
  if (body.adapter_version !== ADAPTER_VERSION) return decision(400, "blocked", "unsupported_version");
  const forbidden = forbiddenKey(body, 0);
  if (forbidden) return decision(400, "blocked", forbidden);

  const propertyRef = body.property_ref;
  if (typeof propertyRef !== "string" || propertyRef.length < 1 || propertyRef.length > 80) {
    return decision(400, "blocked", "invalid_body");
  }
  if (RAW_PROPERTY_KEY.test(propertyRef)) return decision(400, "blocked", "raw_property_key_refused");

  const report = body.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) return decision(400, "blocked", "invalid_body");
  if (typeof report.report_id !== "string" || report.report_id.length < 1 || report.report_id.length > 80) {
    return decision(400, "blocked", "invalid_body");
  }
  if (typeof report.sha256 !== "string" || !SHA256.test(report.sha256)) return decision(400, "blocked", "invalid_digest");
  if (!Number.isInteger(report.byte_length) || report.byte_length < 1) return decision(400, "blocked", "invalid_body");
  if (parseInstant(report.generated_at) == null) return decision(400, "blocked", "invalid_body");

  const consent = body.consent;
  if (!consent || typeof consent !== "object" || Array.isArray(consent)) return decision(400, "blocked", "invalid_body");
  if (typeof consent.ai_consent !== "boolean") return decision(400, "blocked", "ai_consent_not_boolean");
  if (consent.ai_consent === false) return decision(200, "withheld", "ai_consent_false");
  if (consent.content_send_confirmed !== true) return decision(403, "blocked", "content_send_unconfirmed");

  const confirmationExpires = parseInstant(consent.confirmation_expires_at);
  if (confirmationExpires == null || confirmationExpires <= now) {
    return decision(403, "blocked", "confirmation_expired");
  }
  if (typeof consent.confirmation_id !== "string" || consent.confirmation_id.length < 8 || consent.confirmation_id.length > 80) {
    return decision(400, "blocked", "invalid_body");
  }

  if (!boundScope || typeof boundScope !== "object" || Array.isArray(boundScope)) {
    return decision(403, "blocked", "trust_unavailable");
  }
  const mismatch = scopeMismatch(body, boundScope);
  if (mismatch) return decision(403, "blocked", mismatch);
  if (parseInstant(boundScope.expires_at) <= now) return decision(403, "blocked", "scope_expired");
  if (boundScope.trusted !== true) return decision(403, "blocked", "trust_unavailable");

  const budgetStatus = budget && budget.status;
  if (budgetStatus === "exhausted") return decision(429, "blocked", "budget_exhausted");
  if (budgetStatus !== "reserved") return decision(403, "blocked", "budget_unknown");

  if (!replayLedger || typeof replayLedger.has !== "function") {
    return decision(403, "blocked", "replay_unverified");
  }
  if (replayLedger.has(consent.confirmation_id)) return decision(409, "blocked", "replay_rejected");

  return decision(403, "blocked", "token_policy_unapproved");
}

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
 * approved token policy. The HTTP path uses an unavailable issuer and a
 * non-atomic store, so it still cannot call a provider. Fixture verifiers
 * and the single-process ledger are test doubles, not a GeoDataTrack signature
 * and not distributed proof. Declared token numbers are not tokenised.
 */

import { ASSERTION_SKEW_SECONDS, EOV_AUDIENCE } from "./eov-verifier.js";
import { policyGap } from "./eov-policy.js";
import { releaseUninvokedHold, reserveEovSpend } from "./eov-ledger.js";

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
  "primary_consent",
  "model",
]);

function decision(httpStatus, status, reason, extra = {}) {
  return {
    httpStatus,
    payload: {
      adapter_version: ADAPTER_VERSION,
      ok: status === "withheld",
      status,
      reason,
      provider_calls: 0,
      shadow_calls: 0,
      shadow: "forced_off",
      inference: "not_called",
      verification: extra.verification || "offline_gate",
      draft: null,
      writes_to_gdt: false,
      token_accounting: "not_tokenised",
      reservation: extra.reservation || "not_attempted",
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

function claimMismatch(body, claims, auth, now) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return "binding_rejected";
  if (claims.assertion === true) {
    // Audience is already checked by the v1.1 verifier (gdt-app:<id>).
    // report_id is an integer in the assertion and a string on the body.
    // GDT's consent_id is not EIA's send confirmation_id; they are not compared.
    if (String(claims.report_id) !== String(body.report.report_id)) return "scope_mismatch_report";
    if (claims.sha256 !== body.report.sha256) return "scope_mismatch_digest";
    if (body.property_id != null && String(claims.property_id) !== String(body.property_id)) {
      return "scope_mismatch_property";
    }
    if (!Number.isInteger(claims.exp) || now > (claims.exp + ASSERTION_SKEW_SECONDS) * 1000) {
      return "scope_expired";
    }
    if (claims.primary_consent !== true) return "primary_consent_refused";
    return null;
  }
  if (claims.audience !== EOV_AUDIENCE) return "audience_mismatch";
  if (!auth?.kind || claims.caller_kind !== auth.kind) return "auth_mismatch";
  if (claims.property_ref !== body.property_ref) return "scope_mismatch_property";
  if (claims.report_id !== body.report.report_id) return "scope_mismatch_report";
  if (claims.sha256 !== body.report.sha256) return "scope_mismatch_digest";
  const expires = parseInstant(claims.expires_at);
  if (expires == null || expires <= now) return "scope_expired";
  if (claims.primary_consent !== true) return "primary_consent_refused";
  if (claims.confirmation_id !== body.consent.confirmation_id) return "send_confirmation_unbound";
  return null;
}

function declaredUsage(body, policy) {
  const usage = body.declared_usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return { reason: "token_undeclared" };
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens) || inputTokens < 1 || outputTokens < 1) {
    return { reason: "token_undeclared" };
  }
  if (inputTokens > policy.maxInputTokens || outputTokens > policy.maxOutputTokens) return { reason: "token_limit_rejected" };
  return { inputTokens, outputTokens };
}

function httpForLedger(reason) {
  if (reason === "budget_exhausted") return 429;
  if (reason === "replay_rejected" || reason === "idempotency_conflict") return 409;
  if (reason === "token_limit_rejected" || reason === "token_undeclared" || reason === "invalid_body") return 400;
  if (reason === "reservation_store_unavailable" || reason === "reservation_conflict" || reason === "reservation_release_failed") {
    return 503;
  }
  return 403;
}

/**
 * Server-side assessment. `verifier`, `ledger`, and `policy` are injected.
 * The production handler injects an unavailable issuer when no public key
 * is configured, a CAS Blobs ledger when the store opens, and whatever
 * explicit env policy exists (none by default).
 * A passing fixture still rolls the hold back and does not call a model.
 */
export async function assessEovReport({
  body,
  auth = null,
  verifier = null,
  ledger = null,
  policy = null,
  now = Date.now(),
  reportBytes = null,
  replayStore = null,
} = {}) {
  const early = decideEovReport({ body, now });
  if (early.payload.reason !== "trust_unavailable") return early;

  const token = body?.binding_token;
  if (typeof token !== "string" || token.length < 1 || token.length > 4096) {
    return decision(403, "blocked", "binding_required");
  }
  if (!verifier || typeof verifier.verify !== "function") {
    return decision(403, "blocked", "issuer_unavailable");
  }
  const verified = await verifier.verify(token, { reportBytes, replayStore, now });
  if (!verified?.ok) {
    const status = verified?.reason === "replay_rejected" ? 409 : 403;
    return decision(status, "blocked", verified?.reason || "issuer_unavailable", {
      verification: verifier.kind === "test-fixture" ? "fixture_not_issuer" : "offline_gate",
    });
  }
  const mismatch = claimMismatch(body, verified.claims, auth, now);
  if (mismatch) {
    return decision(403, "blocked", mismatch, {
      verification: verifier.kind === "test-fixture" ? "fixture_not_issuer" : "offline_gate",
    });
  }

  const gap = policyGap(policy);
  if (gap) return decision(403, "blocked", gap, { verification: verifier.kind === "test-fixture" ? "fixture_not_issuer" : "offline_gate" });
  const usage = declaredUsage(body, policy);
  if (usage.reason) return decision(httpForLedger(usage.reason), "blocked", usage.reason);

  const idempotencyKey = typeof body.idempotency_key === "string" && body.idempotency_key.length >= 8
    ? body.idempotency_key
    : body.consent.confirmation_id;
  const charge = {
    minor: policy.maxCallMinor,
    ceilingMinor: policy.ceilingMinor,
    confirmationId: body.consent.confirmation_id,
    idempotencyKey,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    maxInputTokens: policy.maxInputTokens,
    maxOutputTokens: policy.maxOutputTokens,
  };
  const reserved = await reserveEovSpend(ledger, charge);
  if (!reserved.ok) return decision(httpForLedger(reserved.reason), "blocked", reserved.reason);
  const released = await releaseUninvokedHold(ledger, charge);
  if (!released.ok) return decision(503, "blocked", "reservation_release_failed", { reservation: "held_uninvoked" });
  return decision(403, "blocked", "provider_path_closed", {
    verification: verifier.kind === "test-fixture" ? "fixture_not_issuer" : "offline_gate",
    reservation: "rolled_back",
  });
}

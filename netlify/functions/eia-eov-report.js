import { preflight, jsonResponse } from "./_shared/cors.js";
import { authoriseRequest } from "./_shared/eia-auth.js";
import { clientIp, takeToken } from "./_shared/rate-limit.js";
import { assessEovReport } from "./_shared/eov-report.js";
import { readBindingConfig, reportBindingVerifier } from "./_shared/eov-verifier.js";
import { blobsGetSetLedger } from "./_shared/eov-ledger.js";
import { readEovPolicy } from "./_shared/eov-policy.js";

/**
 * Metadata gate for a future EOV report reading.
 *
 * The PDF stays in the report app. This function does not call a model or
 * a shadow provider. Production controls are an unavailable binding issuer,
 * and a Blobs adapter that does not open a live store. Conditional
 * onlyIfMatch reservation is implemented for an injected store and is
 * unverified against deployed Blobs. Tests may inject fixtures.
 */

const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_LIMIT = 8;
const MAX_BODY_BYTES = 8 * 1024;

let testControls;

export function setEovControlsForTests(controls) {
  testControls = controls || null;
}

function activeControls() {
  if (testControls) return testControls;
  return {
    verifier: reportBindingVerifier(readBindingConfig()),
    ledger: blobsGetSetLedger(null),
    policy: readEovPolicy(),
  };
}

function gate(req, status, reason, headers) {
  return jsonResponse(req, {
    adapter_version: "eov-report-v0",
    ok: false,
    status: "blocked",
    reason,
    provider_calls: 0,
    shadow_calls: 0,
    shadow: "forced_off",
    inference: "not_called",
    verification: "offline_gate",
    draft: null,
    writes_to_gdt: false,
    token_accounting: "not_tokenised",
    reservation: "not_attempted",
  }, status, headers);
}

export default async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return gate(req, 405, "method_not_allowed");

  const auth = authoriseRequest(req);
  if (!auth.ok) {
    const reason = auth.status === 503
      ? "auth_not_configured"
      : auth.error === "Session expired"
        ? "session_expired"
        : auth.error === "Missing credentials"
          ? "missing_credentials"
          : "unauthorised";
    return gate(req, auth.status, reason);
  }

  const limit = takeToken("eov-report", clientIp(req), WINDOW_LIMIT, WINDOW_MS);
  if (!limit.ok) return gate(req, 429, "rate_limited", { "Retry-After": String(limit.retryAfter) });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return gate(req, 413, "body_too_large");

  let body;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return gate(req, 400, "invalid_json");
  }

  const controls = activeControls();
  const decision = await assessEovReport({
    body,
    auth: { kind: auth.kind },
    verifier: controls.verifier,
    ledger: controls.ledger,
    policy: controls.policy,
  });
  console.log("[eia-eov-report]", { status: decision.payload.status, reason: decision.payload.reason });
  return jsonResponse(req, decision.payload, decision.httpStatus);
};

export const config = {
  path: "/api/eia-eov-report",
  rateLimit: {
    windowLimit: WINDOW_LIMIT,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};

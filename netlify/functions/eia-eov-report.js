import { preflight, jsonResponse } from "./_shared/cors.js";
import { authoriseRequest } from "./_shared/eia-auth.js";
import { clientIp, takeToken } from "./_shared/rate-limit.js";
import { decideEovReport } from "./_shared/eov-report.js";

/**
 * Metadata gate for a future EOV report reading.
 *
 * The report PDF stays in the report app. This function accepts a small
 * JSON description only. It reuses EIA session/app-secret authentication
 * and the in-memory per-IP limiter. It does not reserve spend, does not
 * read a monetary budget, does not call Anthropic, and does not start a
 * shadow model. Server report/property/digest trust is not available, so
 * decideEovReport is called with a null binding.
 */

const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_LIMIT = 8;
const MAX_BODY_BYTES = 8 * 1024;

export default async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") {
    return jsonResponse(req, {
      adapter_version: "eov-report-v0",
      ok: false,
      status: "blocked",
      reason: "method_not_allowed",
      provider_calls: 0,
      shadow_calls: 0,
      inference: "not_called",
      verification: "offline_gate",
      draft: null,
      writes_to_gdt: false,
    }, 405);
  }

  const auth = authoriseRequest(req);
  if (!auth.ok) {
    const reason = auth.status === 503
      ? "auth_not_configured"
      : auth.error === "Session expired"
        ? "session_expired"
        : auth.error === "Missing credentials"
          ? "missing_credentials"
          : "unauthorised";
    return jsonResponse(req, {
      adapter_version: "eov-report-v0",
      ok: false,
      status: "blocked",
      reason,
      provider_calls: 0,
      shadow_calls: 0,
      inference: "not_called",
      verification: "offline_gate",
      draft: null,
      writes_to_gdt: false,
    }, auth.status);
  }

  const limit = takeToken("eov-report", clientIp(req), WINDOW_LIMIT, WINDOW_MS);
  if (!limit.ok) {
    return jsonResponse(req, {
      adapter_version: "eov-report-v0",
      ok: false,
      status: "blocked",
      reason: "rate_limited",
      provider_calls: 0,
      shadow_calls: 0,
      inference: "not_called",
      verification: "offline_gate",
      draft: null,
      writes_to_gdt: false,
    }, 429, { "Retry-After": String(limit.retryAfter) });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return jsonResponse(req, {
      adapter_version: "eov-report-v0",
      ok: false,
      status: "blocked",
      reason: "body_too_large",
      provider_calls: 0,
      shadow_calls: 0,
      inference: "not_called",
      verification: "offline_gate",
      draft: null,
      writes_to_gdt: false,
    }, 413);
  }

  let body;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return jsonResponse(req, {
      adapter_version: "eov-report-v0",
      ok: false,
      status: "blocked",
      reason: "invalid_json",
      provider_calls: 0,
      shadow_calls: 0,
      inference: "not_called",
      verification: "offline_gate",
      draft: null,
      writes_to_gdt: false,
    }, 400);
  }

  const decision = decideEovReport({
    body,
    boundScope: null,
    budget: { status: "unknown" },
    replayLedger: null,
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

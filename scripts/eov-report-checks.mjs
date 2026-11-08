/**
 * Offline checks for the EOV report adapter.
 * No network and no model call. global fetch is replaced and must stay unused.
 *
 *   node scripts/eov-report-checks.mjs
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import eovReport from "../netlify/functions/eia-eov-report.js";
import { decideEovReport, ADAPTER_VERSION } from "../netlify/functions/_shared/eov-report.js";

process.env.EIA_AUTH_SECRET = "eov-test-auth-secret-0123456789";
process.env.EIA_APP_SECRET = "eov-test-app-secret-0123456789";
process.env.ANTHROPIC_API_KEY = "not-a-live-key";
process.env.SHADOW_ENABLED = "true";
process.env.SHADOW_PROVIDER_BASE_URL = "https://openrouter.ai/api/v1";
process.env.SHADOW_PROVIDER_HOSTS = "openrouter.ai";
process.env.SHADOW_ALLOWED_PROPERTIES = "should-not-be-sent";
process.env.SHADOW_CONSENT_REF = "not-eov-consent";
process.env.SHADOW_API_KEY = "not-a-live-shadow-key";

const calls = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  calls.push(String(url));
  throw new Error("provider call");
};

let passed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`PASS  ${name}`);
    });
}

function zeroCalls() {
  assert.deepEqual(calls, []);
}

function token(exp, secret = process.env.EIA_AUTH_SECRET) {
  const body = Buffer.from(JSON.stringify({
    v: 1,
    exp,
    sub: "gdt",
    property_apikey: "",
    org: "",
  })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

let requestSeq = 0;

function request(body, { bearer = process.env.EIA_APP_SECRET, raw } = {}) {
  requestSeq += 1;
  const headers = {
    "Content-Type": "application/json",
    "x-nf-client-connection-ip": `203.0.113.${requestSeq}`,
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return new Request("https://hm-eia.test/api/eia-eov-report", {
    method: "POST",
    headers,
    body: raw ?? JSON.stringify(body),
  });
}

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const now = Date.parse("2026-11-08T14:32:00Z");
const future = "2027-06-01T00:00:00Z";
const past = "2026-11-08T13:32:00Z";

function baseBody(overrides = {}) {
  return {
    adapter_version: ADAPTER_VERSION,
    property_ref: "opaque-property-ref",
    report: {
      report_id: "synthetic-report-1",
      sha256: digest,
      byte_length: 1200,
      generated_at: "2026-11-08T12:00:00Z",
    },
    consent: {
      ai_consent: false,
      content_send_confirmed: false,
      confirmation_id: null,
      confirmation_expires_at: null,
    },
    ...overrides,
  };
}

function consentedBody(overrides = {}) {
  return baseBody({
    consent: {
      ai_consent: true,
      content_send_confirmed: true,
      confirmation_id: "confirm-001",
      confirmation_expires_at: future,
    },
    ...overrides,
  });
}

function trustedScope(overrides = {}) {
  return {
    trusted: true,
    property_ref: "opaque-property-ref",
    report_id: "synthetic-report-1",
    sha256: digest,
    expires_at: future,
    ...overrides,
  };
}

await check("source does not call a provider or shadow", () => {
  const gate = readFileSync(new URL("../netlify/functions/_shared/eov-report.js", import.meta.url), "utf8");
  const handler = readFileSync(new URL("../netlify/functions/eia-eov-report.js", import.meta.url), "utf8");
  for (const source of [gate, handler]) {
    assert.equal(source.includes("callAnthropic"), false);
    assert.equal(source.includes("startShadow"), false);
    assert.equal(source.includes("api.anthropic.com"), false);
    assert.equal(source.includes("chat/completions"), false);
    assert.equal(source.includes("takeDailyAllowance"), false);
    assert.equal(source.includes("fetch("), false);
  }
});

await check("missing auth configuration makes no provider call", async () => {
  const savedAuth = process.env.EIA_AUTH_SECRET;
  const savedApp = process.env.EIA_APP_SECRET;
  delete process.env.EIA_AUTH_SECRET;
  delete process.env.EIA_APP_SECRET;
  try {
    const res = await eovReport(request(baseBody(), { bearer: "anything" }));
    const payload = await res.json();
    assert.equal(res.status, 503);
    assert.equal(payload.reason, "auth_not_configured");
    assert.equal(payload.provider_calls, 0);
    assert.equal(payload.shadow_calls, 0);
    zeroCalls();
  } finally {
    process.env.EIA_AUTH_SECRET = savedAuth;
    process.env.EIA_APP_SECRET = savedApp;
  }
});

await check("missing, tampered, and expired credentials make no provider call", async () => {
  const missing = await eovReport(request(baseBody(), { bearer: "" }));
  assert.equal((await missing.json()).reason, "missing_credentials");
  const tampered = await eovReport(request(baseBody(), { bearer: `${token(Math.floor(now / 1000) + 60)}x` }));
  assert.equal((await tampered.json()).reason, "unauthorised");
  const expired = await eovReport(request(baseBody(), { bearer: token(Math.floor(now / 1000) - 60) }));
  const expiredBody = await expired.json();
  assert.equal(expired.status, 401);
  assert.equal(expiredBody.reason, "session_expired");
  assert.equal(expiredBody.provider_calls, 0);
  zeroCalls();
});

await check("ai_consent false withholds inference and does not require a provider", async () => {
  const res = await eovReport(request(baseBody()));
  const payload = await res.json();
  assert.equal(res.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "withheld");
  assert.equal(payload.reason, "ai_consent_false");
  assert.equal(payload.draft, null);
  assert.equal(payload.writes_to_gdt, false);
  assert.equal(payload.verification, "offline_gate");
  zeroCalls();
});

await check("client trust, raw property key, and pdf bytes are refused", async () => {
  const trusted = await eovReport(request({ ...consentedBody(), bound_scope: trustedScope() }));
  assert.equal((await trusted.json()).reason, "client_trust_refused");
  const keyed = await eovReport(request({ ...baseBody(), property_apikey: "a".repeat(40) }));
  assert.equal((await keyed.json()).reason, "raw_property_key_refused");
  const asRef = await eovReport(request(baseBody({ property_ref: "a".repeat(40) })));
  assert.equal((await asRef.json()).reason, "raw_property_key_refused");
  const pdf = await eovReport(request({ ...baseBody(), pdf_base64: "AAAA" }));
  assert.equal((await pdf.json()).reason, "pdf_bytes_refused");
  zeroCalls();
});

await check("reported ai_consent true without separate confirmation makes no provider call", async () => {
  const body = consentedBody();
  body.consent.content_send_confirmed = false;
  const res = await eovReport(request(body));
  const payload = await res.json();
  assert.equal(payload.reason, "content_send_unconfirmed");
  assert.equal(payload.provider_calls, 0);
  assert.equal(payload.shadow_calls, 0);
  zeroCalls();
});

await check("http handler keeps trust and budget closed even when consent is confirmed", async () => {
  const res = await eovReport(request(consentedBody()));
  const payload = await res.json();
  assert.equal(res.status, 403);
  assert.equal(payload.reason, "trust_unavailable");
  assert.equal(payload.inference, "not_called");
  assert.equal(payload.provider_calls, 0);
  zeroCalls();
});

await check("fixture scope mismatches and expiry never become a provider call", () => {
  const body = consentedBody();
  const common = { budget: { status: "reserved" }, replayLedger: new Set(), now };
  assert.equal(decideEovReport({ body, boundScope: trustedScope({ property_ref: "other" }), ...common }).payload.reason, "scope_mismatch_property");
  assert.equal(decideEovReport({ body, boundScope: trustedScope({ report_id: "other-report" }), ...common }).payload.reason, "scope_mismatch_report");
  assert.equal(decideEovReport({ body, boundScope: trustedScope({ sha256: otherDigest }), ...common }).payload.reason, "scope_mismatch_digest");
  assert.equal(decideEovReport({ body, boundScope: trustedScope({ expires_at: past }), ...common }).payload.reason, "scope_expired");
  const expiredConfirmation = consentedBody();
  expiredConfirmation.consent.confirmation_expires_at = past;
  assert.equal(decideEovReport({ body: expiredConfirmation, boundScope: trustedScope(), ...common }).payload.reason, "confirmation_expired");
  zeroCalls();
});

await check("unknown and exhausted budgets stop before token policy", () => {
  const body = consentedBody();
  const boundScope = trustedScope();
  assert.equal(decideEovReport({ body, boundScope, budget: { status: "unknown" }, replayLedger: new Set(), now }).payload.reason, "budget_unknown");
  assert.equal(decideEovReport({ body, boundScope, budget: null, replayLedger: new Set(), now }).payload.reason, "budget_unknown");
  const exhausted = decideEovReport({ body, boundScope, budget: { status: "exhausted" }, replayLedger: new Set(), now });
  assert.equal(exhausted.httpStatus, 429);
  assert.equal(exhausted.payload.reason, "budget_exhausted");
  assert.equal(exhausted.payload.provider_calls, 0);
  zeroCalls();
});

await check("a reserved fixture still makes no provider call and does not consume replay", () => {
  const ledger = new Set();
  const first = decideEovReport({
    body: consentedBody(),
    boundScope: trustedScope(),
    budget: { status: "reserved" },
    replayLedger: ledger,
    now,
  });
  assert.equal(first.payload.reason, "token_policy_unapproved");
  assert.equal(first.payload.provider_calls, 0);
  assert.equal(first.payload.shadow_calls, 0);
  assert.equal(ledger.size, 0);
  const again = decideEovReport({
    body: consentedBody(),
    boundScope: trustedScope(),
    budget: { status: "reserved" },
    replayLedger: ledger,
    now,
  });
  assert.equal(again.payload.reason, "token_policy_unapproved");
  ledger.add("confirm-001");
  const replay = decideEovReport({
    body: consentedBody(),
    boundScope: trustedScope(),
    budget: { status: "reserved" },
    replayLedger: ledger,
    now,
  });
  assert.equal(replay.payload.reason, "replay_rejected");
  const untracked = decideEovReport({
    body: consentedBody(),
    boundScope: trustedScope(),
    budget: { status: "reserved" },
    replayLedger: null,
    now,
  });
  assert.equal(untracked.payload.reason, "replay_unverified");
  zeroCalls();
});

await check("shadow flags in the environment do not create a second call", async () => {
  assert.equal(process.env.SHADOW_ENABLED, "true");
  const withheld = await eovReport(request(baseBody()));
  const blocked = await eovReport(request(consentedBody()));
  assert.equal((await withheld.json()).shadow_calls, 0);
  assert.equal((await blocked.json()).shadow_calls, 0);
  zeroCalls();
});

globalThis.fetch = previousFetch;
console.log(`\n${passed} eov report checks passed`);

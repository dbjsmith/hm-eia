/**
 * Offline checks for the EOV report adapter.
 * No network and no model call. global fetch is replaced and must stay unused.
 *
 *   node scripts/eov-report-checks.mjs
 */

import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import eovReport, { setEovControlsForTests } from "../netlify/functions/eia-eov-report.js";
import { assessEovReport, decideEovReport, decodePdfBase64, ADAPTER_VERSION } from "../netlify/functions/_shared/eov-report.js";
import { assertionSkewSeconds, canonicalAssertion, canonicalJson, fixtureBindingVerifier, importEd25519Public, packAssertion, readBindingConfig, reportBindingVerifier, trustDevIssuer, CONTRACT_V11, DEV_KID, DEV_PUBLIC_KEY_B64U, EOV_AUDIENCE, ASSERTION_ISS } from "../netlify/functions/_shared/eov-verifier.js";
import { blobsGetSetLedger, casBlobsLedger, memoryLedger, releaseUninvokedHold, reserveEovSpend, unsafeLostUpdateLedger } from "../netlify/functions/_shared/eov-ledger.js";
import { readEovPolicy } from "../netlify/functions/_shared/eov-policy.js";
import { reserveOnConditionalStore } from "../netlify/functions/_shared/eov-blobs-ledger.js";
import { admitDeclaredTokens, worstCaseMicroUsd } from "../netlify/functions/_shared/eov-tokens.js";
import { assertEovPromptShape, EOV_PROMPT_VERSION, EOV_REPORT_SYSTEM } from "../netlify/functions/_shared/eov-prompt.js";

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

function request(body, { bearer = process.env.EIA_APP_SECRET, raw, ip } = {}) {
  requestSeq += 1;
  const headers = {
    "Content-Type": "application/json",
    "x-nf-client-connection-ip": ip || `203.0.113.${requestSeq}`,
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
  const files = [
    "../netlify/functions/_shared/eov-report.js",
    "../netlify/functions/_shared/eov-ledger.js",
    "../netlify/functions/_shared/eov-verifier.js",
    "../netlify/functions/_shared/eov-policy.js",
    "../netlify/functions/eia-eov-report.js",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(source.includes("callAnthropic"), false);
    assert.equal(source.includes("startShadow"), false);
    assert.equal(source.includes("api.anthropic.com"), false);
    assert.equal(source.includes("chat/completions"), false);
    assert.equal(source.includes("takeDailyAllowance"), false);
    assert.equal(source.includes("fetch("), false);
    assert.equal(source.includes("claude-sonnet"), false);
    assert.equal(source.includes("0.044"), false);
    assert.equal(source.includes("BEGIN PRIVATE KEY"), false);
    assert.equal(source.includes("BEGIN PUBLIC KEY"), false);
  }
  for (const file of [
    "../netlify/functions/_shared/eov-tokens.js",
    "../netlify/functions/_shared/eov-blobs-ledger.js",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(source.includes("fetch("), false);
    assert.equal(source.includes("api.anthropic.com"), false);
    assert.equal(source.includes("count_tokens"), false);
    assert.equal(source.includes("0.044"), false);
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
  assert.equal(payload.reason, "binding_required");
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
  const blockedRes = await eovReport(request(consentedBody()));
  const blocked = await blockedRes.json();
  assert.equal((await withheld.json()).shadow_calls, 0);
  assert.equal(blocked.shadow, "forced_off");
  assert.equal(blocked.shadow_calls, 0);
  zeroCalls();
});

await check("an unsigned client token is not an issuer", async () => {
  const res = await eovReport(request({ ...consentedBody(), binding_token: "client-forged-token" }));
  const payload = await res.json();
  assert.equal(payload.reason, "issuer_unavailable");
  assert.equal(payload.provider_calls, 0);
  zeroCalls();
});

await check("empty policy selects no model and no amount", () => {
  const policy = readEovPolicy({});
  assert.equal(policy.configured, false);
  assert.equal(policy.approved, false);
  assert.equal(policy.model, null);
  assert.equal(policy.ceilingMinor, null);
  assert.equal(policy.maxInputTokens, null);
  assert.equal(policy.maxOutputTokens, null);
});

await check("explicit env policy still cannot open the provider without an issuer", async () => {
  const names = {
    EIA_EOV_BUDGET_APPROVED: "true",
    EIA_EOV_MODEL: "fixture-model-not-a-runtime-selection",
    EIA_EOV_BUDGET_CURRENCY: "USD",
    EIA_EOV_BUDGET_MINOR: "20",
    EIA_EOV_MAX_CALL_MINOR: "5",
    EIA_EOV_MAX_INPUT_TOKENS: "12000",
    EIA_EOV_MAX_OUTPUT_TOKENS: "10000",
  };
  const saved = {};
  for (const [key, value] of Object.entries(names)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const policy = readEovPolicy();
    assert.equal(policy.configured, true);
    assert.equal(policy.model, "fixture-model-not-a-runtime-selection");
    const res = await eovReport(request({ ...consentedBody(), binding_token: "still-untrusted" }));
    const payload = await res.json();
    assert.equal(payload.reason, "issuer_unavailable");
    assert.equal(payload.provider_calls, 0);
    zeroCalls();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

const researchFixturePolicy = {
  approved: true,
  model: "fixture-model-not-a-runtime-selection",
  currency: "USD",
  ceilingMinor: 20,
  maxCallMinor: 5,
  maxInputTokens: 12000,
  maxOutputTokens: 10000,
};

function fixtureClaims(overrides = {}) {
  return {
    property_ref: "opaque-property-ref",
    report_id: "synthetic-report-1",
    sha256: digest,
    expires_at: future,
    audience: "eia-eov-report",
    caller_kind: "app",
    primary_consent: true,
    confirmation_id: "confirm-001",
    ...overrides,
  };
}

function readyBody(overrides = {}) {
  return {
    ...consentedBody(),
    binding_token: "fixture-token-1",
    declared_usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

async function withFixture(claims, fn, policy = researchFixturePolicy) {
  const ledger = memoryLedger();
  setEovControlsForTests({
    verifier: fixtureBindingVerifier(new Map([["fixture-token-1", claims]])),
    ledger,
    policy,
  });
  try {
    return await fn(ledger);
  } finally {
    setEovControlsForTests(null);
  }
}

await check("ai_consent false does not consult the fixture issuer", async () => {
  let seen = 0;
  setEovControlsForTests({
    verifier: { kind: "test-fixture", async verify() { seen += 1; return { ok: false, reason: "binding_rejected" }; } },
    ledger: memoryLedger(),
    policy: researchFixturePolicy,
  });
  try {
    const res = await eovReport(request(baseBody()));
    assert.equal((await res.json()).reason, "ai_consent_false");
    assert.equal(seen, 0);
    zeroCalls();
  } finally {
    setEovControlsForTests(null);
  }
});

await check("fixture mismatches for property, report, digest, expiry, audience, and auth make no call", async () => {
  const cases = [
    ["scope_mismatch_property", { property_ref: "other-property" }],
    ["scope_mismatch_report", { report_id: "other-report" }],
    ["scope_mismatch_digest", { sha256: otherDigest }],
    ["scope_expired", { expires_at: past }],
    ["audience_mismatch", { audience: "some-other-app" }],
    ["auth_mismatch", { caller_kind: "gdt" }],
    ["primary_consent_refused", { primary_consent: false }],
    ["send_confirmation_unbound", { confirmation_id: "confirm-999" }],
  ];
  for (const [reason, overrides] of cases) {
    await withFixture(fixtureClaims(overrides), async (ledger) => {
      const res = await eovReport(request(readyBody()));
      const payload = await res.json();
      assert.equal(payload.reason, reason);
      assert.equal(payload.verification, "fixture_not_issuer");
      assert.equal(payload.provider_calls, 0);
      assert.equal((await ledger.read()).spentMinor, 0);
    });
  }
  zeroCalls();
});

await check("declared tokens over the fixture ceiling are rejected before a hold", async () => {
  await withFixture(fixtureClaims(), async (ledger) => {
    const res = await eovReport(request(readyBody({
      declared_usage: { input_tokens: 12001, output_tokens: 50 },
    })));
    const payload = await res.json();
    assert.equal(payload.reason, "token_limit_rejected");
    assert.equal(payload.token_accounting, "not_tokenised");
    assert.equal((await ledger.read()).spentMinor, 0);
  });
  zeroCalls();
});

await check("a fully valid synthetic fixture still makes no provider call and rolls the hold back", async () => {
  await withFixture(fixtureClaims(), async (ledger) => {
    const first = await eovReport(request(readyBody()));
    const payload = await first.json();
    assert.equal(payload.reason, "provider_path_closed");
    assert.equal(payload.reservation, "rolled_back");
    assert.equal(payload.provider_calls, 0);
    assert.equal(payload.shadow_calls, 0);
    assert.equal(payload.shadow, "forced_off");
    assert.equal((await ledger.read()).spentMinor, 0);
    const second = await eovReport(request(readyBody()));
    assert.equal((await second.json()).reason, "provider_path_closed");
    assert.equal((await ledger.read()).spentMinor, 0);
  });
  zeroCalls();
});

await check("the in-memory ledger caps concurrent reservations and is not distributed", async () => {
  const ledger = memoryLedger();
  assert.equal(ledger.distributed, false);
  assert.equal(ledger.safety, "single_process_queue");
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => reserveEovSpend(ledger, {
    minor: 10,
    ceilingMinor: 100,
    confirmationId: `confirm-${index}`,
    idempotencyKey: `idem-${index}`,
    inputTokens: 10,
    outputTokens: 10,
    maxInputTokens: 100,
    maxOutputTokens: 100,
  })));
  assert.equal(results.filter((item) => item.reason === "reserved").length, 10);
  assert.equal(results.filter((item) => item.reason === "budget_exhausted").length, 10);
  assert.equal((await ledger.read()).spentMinor, 100);
});

await check("identical retries are idempotent and a second confirmation key is replay", async () => {
  const ledger = memoryLedger();
  const charge = {
    minor: 10,
    ceilingMinor: 100,
    confirmationId: "confirm-same",
    idempotencyKey: "idem-same",
    inputTokens: 10,
    outputTokens: 10,
    maxInputTokens: 100,
    maxOutputTokens: 100,
  };
  const results = await Promise.all(Array.from({ length: 12 }, () => reserveEovSpend(ledger, charge)));
  assert.equal(results.filter((item) => item.reason === "reserved").length, 1);
  assert.equal(results.filter((item) => item.reason === "idempotent").length, 11);
  assert.equal((await ledger.read()).spentMinor, 10);
  const conflict = await reserveEovSpend(ledger, { ...charge, minor: 9 });
  assert.equal(conflict.reason, "idempotency_conflict");
  const replay = await reserveEovSpend(ledger, { ...charge, idempotencyKey: "idem-other" });
  assert.equal(replay.reason, "replay_rejected");
  assert.equal((await ledger.read()).spentMinor, 10);
  const released = await releaseUninvokedHold(ledger, charge);
  assert.equal(released.reason, "released");
  assert.equal((await ledger.read()).spentMinor, 0);
});

await check("an unsynchronised get/set loses updates and Blobs is not asked to set", async () => {
  const unsafe = unsafeLostUpdateLedger();
  await Promise.all(Array.from({ length: 30 }, () => unsafe.add(10)));
  assert.equal(unsafe.spent(), 10);
  let writes = 0;
  const store = {
    set() { writes += 1; },
    setJSON() { writes += 1; },
  };
  const refused = await reserveEovSpend(blobsGetSetLedger(store), {
    minor: 5,
    ceilingMinor: 20,
    confirmationId: "confirm-blobs",
    idempotencyKey: "idem-blobs",
    inputTokens: 10,
    outputTokens: 10,
    maxInputTokens: 100,
    maxOutputTokens: 100,
  });
  assert.equal(refused.reason, "reservation_store_unavailable");
  assert.equal(writes, 0);
  zeroCalls();
});

await check("casBlobsLedger reserves and releases with onlyIfMatch writes", async () => {
  const rows = new Map();
  let seq = 1;
  const writes = [];
  const store = {
    async getWithMetadata(key, options) {
      if (options?.consistency !== "strong" || options?.type !== "json") throw new Error("read was not strong json");
      const row = rows.get(key);
      if (!row) return null;
      return { data: JSON.parse(JSON.stringify(row.value)), etag: row.etag };
    },
    async setJSON(key, value, options = {}) {
      const conditional = options.onlyIfNew === true || typeof options.onlyIfMatch === "string";
      if (!conditional) throw new Error("unconditional write");
      writes.push({ key, onlyIfNew: options.onlyIfNew === true, onlyIfMatch: options.onlyIfMatch || null });
      const row = rows.get(key);
      if (options.onlyIfNew === true) {
        if (row) return { modified: false };
        const etag = `e${seq += 1}`;
        rows.set(key, { etag, value: JSON.parse(JSON.stringify(value)) });
        return { modified: true, etag };
      }
      if (!row || row.etag !== options.onlyIfMatch) return { modified: false };
      const etag = `e${seq += 1}`;
      rows.set(key, { etag, value: JSON.parse(JSON.stringify(value)) });
      return { modified: true, etag };
    },
  };
  const ledger = casBlobsLedger(store);
  const charge = {
    minor: 7,
    ceilingMinor: 50,
    confirmationId: "confirm-cas-1",
    idempotencyKey: "idem-cas-1",
    inputTokens: 10,
    outputTokens: 10,
    maxInputTokens: 100,
    maxOutputTokens: 100,
  };
  const reserved = await reserveEovSpend(ledger, charge);
  assert.equal(reserved.reason, "reserved");
  assert.equal(reserved.spentMinor, 7);
  assert.equal(writes.every((w) => w.onlyIfNew || w.onlyIfMatch), true);
  const replay = await reserveEovSpend(ledger, { ...charge, idempotencyKey: "idem-cas-2" });
  assert.equal(replay.reason, "replay_rejected");
  const released = await releaseUninvokedHold(ledger, charge);
  assert.equal(released.reason, "released");
  assert.equal((await ledger.read()).spentMinor, 0);
  zeroCalls();
});

function fakeConditionalStore({ failMatches = 0, account = null } = {}) {
  const rows = new Map();
  let seq = 1;
  let failLeft = failMatches;
  const writes = [];
  if (account) rows.set("eov-report-v0/account", { etag: "e0", value: account });
  return {
    writes,
    async getWithMetadata(key, options) {
      if (options?.consistency !== "strong" || options?.type !== "json") throw new Error("read was not strong json");
      await Promise.resolve();
      const row = rows.get(key);
      if (!row) return null;
      return { data: JSON.parse(JSON.stringify(row.value)), etag: row.etag };
    },
    async setJSON(key, value, options = {}) {
      const conditional = options.onlyIfNew === true || typeof options.onlyIfMatch === "string";
      if (!conditional) throw new Error("unconditional write");
      writes.push({ key, onlyIfNew: options.onlyIfNew === true, onlyIfMatch: options.onlyIfMatch || null });
      await Promise.resolve();
      const row = rows.get(key);
      if (options.onlyIfNew === true) {
        if (row) return { modified: false };
        const etag = `e${seq += 1}`;
        rows.set(key, { etag, value: JSON.parse(JSON.stringify(value)) });
        return { modified: true, etag };
      }
      if (failLeft > 0) {
        failLeft -= 1;
        return { modified: false };
      }
      if (!row || row.etag !== options.onlyIfMatch) return { modified: false };
      const etag = `e${seq += 1}`;
      rows.set(key, { etag, value: JSON.parse(JSON.stringify(value)) });
      return { modified: true, etag };
    },
    account() {
      const row = rows.get("eov-report-v0/account");
      return row ? JSON.parse(JSON.stringify(row.value)) : null;
    },
  };
}

function blobCharge(index, overrides = {}) {
  return {
    confirmationId: `confirm-${index}-ok`,
    idempotencyKey: `idem-${index}-ok`,
    input_tokens: 100,
    output_tokens: 50,
    ...overrides,
  };
}

await check("declared token ceilings are not inferred from byte length", () => {
  assert.equal(worstCaseMicroUsd(), 124000);
  assert.equal(admitDeclaredTokens({ input_tokens: 12000, output_tokens: 10000 }).ok, true);
  assert.equal(admitDeclaredTokens({ input_tokens: 12001, output_tokens: 1 }).reason, "token_limit_rejected");
  assert.equal(admitDeclaredTokens({ input_tokens: 1, output_tokens: 10001 }).reason, "token_limit_rejected");
  const wide = { input_tokens: 100, output_tokens: 50, byte_length: 5_000_000 };
  assert.equal(admitDeclaredTokens(wide).ok, true);
  assert.equal(admitDeclaredTokens(wide).accounting, "declared_not_counted");
  zeroCalls();
});

await check("conditional store admits eight worst-case calls under the spend ceiling and still enforces the call cap", async () => {
  // Worst-case reservation is 124,000 micro-USD; ceiling is 1,000,000.
  // Eight full calls fit (992,000). The ninth is budget_exhausted. The
  // call cap (10) still binds when spend allows. Reservations are made
  // in sequence because concurrent CAS is limited to five attempts.
  const store = fakeConditionalStore();
  const reserved = [];
  for (let index = 0; index < 8; index += 1) {
    reserved.push(await reserveOnConditionalStore(store, blobCharge(index)));
  }
  assert.equal(reserved.every((item) => item.reason === "reserved"), true);
  assert.equal(store.account().calls, 8);
  assert.equal(store.account().spentMicroUsd, 992000);
  const ninth = await reserveOnConditionalStore(store, blobCharge(8));
  assert.equal(ninth.reason, "budget_exhausted");
  assert.equal(store.account().calls, 8);
  assert.equal(store.account().spentMicroUsd, 992000);
  assert.equal(store.writes.every((write) => write.onlyIfNew || write.onlyIfMatch), true);

  const raced = fakeConditionalStore();
  const concurrent = await Promise.all([30, 31, 32].map((index) => reserveOnConditionalStore(raced, blobCharge(index))));
  assert.equal(concurrent.filter((item) => item.reason === "reserved").length, 3);
  assert.equal(raced.account().calls, 3);
  assert.equal(raced.account().spentMicroUsd, 372000);

  const nearCap = fakeConditionalStore({
    account: { spentMicroUsd: 0, calls: 9, holds: {} },
  });
  const last = await reserveOnConditionalStore(nearCap, blobCharge(20));
  assert.equal(last.reason, "reserved");
  assert.equal(nearCap.account().calls, 10);
  const capped = await reserveOnConditionalStore(nearCap, blobCharge(21));
  assert.equal(capped.reason, "call_cap");
  assert.equal(nearCap.account().calls, 10);

  const conflicted = fakeConditionalStore({
    failMatches: 1,
    account: { spentMicroUsd: 0, calls: 0, holds: {} },
  });
  const retried = await reserveOnConditionalStore(conflicted, blobCharge(7));
  assert.equal(retried.reason, "reserved");
  assert.equal(conflicted.account().calls, 1);
  assert.equal(conflicted.account().spentMicroUsd, 124000);

  const stuck = fakeConditionalStore({
    failMatches: 5,
    account: { spentMicroUsd: 0, calls: 0, holds: {} },
  });
  const blocked = await reserveOnConditionalStore(stuck, blobCharge(8));
  assert.equal(blocked.reason, "reservation_conflict");
  assert.equal(stuck.account().calls, 0);
  assert.equal(stuck.account().spentMicroUsd, 0);
  zeroCalls();
});
await check("conditional retries are idempotent and a second confirmation is replay", async () => {
  const store = fakeConditionalStore();
  const charge = blobCharge(4);
  const results = await Promise.all(Array.from({ length: 8 }, () => reserveOnConditionalStore(store, charge)));
  assert.equal(results.every((item) => item.ok && (item.reason === "reserved" || item.reason === "idempotent")), true);
  assert.equal(store.account().calls, 1);
  assert.equal(store.account().spentMicroUsd, 124000);
  const replay = await reserveOnConditionalStore(store, blobCharge(4, { idempotencyKey: "idem-other-key" }));
  assert.equal(replay.reason, "replay_rejected");
  assert.equal(store.account().calls, 1);
  const missing = await reserveOnConditionalStore({}, blobCharge(5));
  assert.equal(missing.reason, "reservation_store_unavailable");
  zeroCalls();
});

await check("the dollar ceiling rejects a charge the call cap would still allow", async () => {
  const store = fakeConditionalStore({
    account: { spentMicroUsd: 900_000, calls: 0, holds: {} },
  });
  const result = await reserveOnConditionalStore(store, blobCharge(6));
  assert.equal(result.reason, "budget_exhausted");
  assert.equal(store.account().spentMicroUsd, 900_000);
  assert.equal(store.account().calls, 0);
  zeroCalls();
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const throwawayPublicPem = publicKey.export({ type: "spki", format: "pem" });
const { privateKey: otherPrivateKey } = generateKeyPairSync("ed25519");
const assertionNow = Date.parse("2026-11-09T18:46:00Z");
const assertionBytes = Buffer.from("synthetic-eov-report-bytes");
const TEST_AUD = "gdt-app:9";

function onlyNewStore() {
  const seen = new Set();
  return {
    async setJSON(key, _value, options) {
      if (options?.onlyIfNew !== true) throw new Error("onlyIfNew required");
      if (seen.has(key)) return { modified: false };
      seen.add(key);
      return { modified: true, etag: "etag-1" };
    },
  };
}

function assertionPayload(overrides = {}, bytes = assertionBytes) {
  const nowSec = Math.floor(assertionNow / 1000);
  return {
    iss: ASSERTION_ISS,
    aud: TEST_AUD,
    install_id: 70,
    org_id: 7,
    property_id: 501,
    report_id: 41,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ai_consent: true,
    consent_id: 3301,
    consent_at: "2026-11-09 18:00:00",
    request_id: "request-test-1",
    iat: nowSec,
    exp: nowSec + 300,
    kid: "test-kid-1",
    ...overrides,
  };
}

function edAssertion(payload = assertionPayload(), key = privateKey) {
  const canonical = canonicalAssertion(payload);
  if (!canonical) throw new Error("invalid test payload");
  const header = canonicalJson({ alg: "EdDSA", kid: payload.kid, typ: "gdt-report+jws" });
  const signingInput = `${Buffer.from(header, "utf8").toString("base64url")}.${Buffer.from(canonical, "utf8").toString("base64url")}`;
  const sig = sign(null, Buffer.from(signingInput, "utf8"), key);
  const token = packAssertion(payload, sig);
  if (!token) throw new Error("failed to pack assertion");
  return token;
}

function testVerifier(overrides = {}) {
  return reportBindingVerifier({
    keys: { "test-kid-1": throwawayPublicPem },
    audience: TEST_AUD,
    ...overrides,
  });
}

await check("canonical JSON matches GDT: keys sorted, no spaces, slashes and UTF-8 unescaped", () => {
  assert.equal(canonicalJson({ b: true, a: { d: 2, c: "x/y é" } }), '{"a":{"c":"x/y é","d":2},"b":true}');
  const payload = assertionPayload();
  const canonical = canonicalAssertion(payload);
  assert.equal(canonical.startsWith("{"), true);
  assert.equal(/": /.test(canonical) || canonical.includes(", "), false);
  assert.equal(canonical.includes("consent_at"), true);
  assert.equal(canonical.includes("consent_changed_at"), false);
  const parsed = JSON.parse(canonical);
  assert.deepEqual(Object.keys(parsed), [
    "ai_consent", "aud", "consent_at", "consent_id", "exp", "iat",
    "install_id", "iss", "kid", "org_id", "property_id", "report_id",
    "request_id", "sha256",
  ]);
  zeroCalls();
});

await check("a signed assertion is refused when no public key is configured", async () => {
  const closed = reportBindingVerifier({});
  const result = await closed.verify(edAssertion(), {
    reportBytes: assertionBytes,
    replayStore: onlyNewStore(),
    now: assertionNow,
  });
  assert.equal(result.reason, "issuer_unavailable");
  assert.equal(closed.kind, "issuer_unavailable");
  zeroCalls();
});

await check("ed25519 verifies the report bytes and onlyIfNew rejects a replay", async () => {
  const verifier = testVerifier();
  const store = onlyNewStore();
  const context = { reportBytes: assertionBytes, replayStore: store, now: assertionNow };
  const ok = await verifier.verify(edAssertion(), context);
  assert.equal(ok.ok, true);
  assert.equal(ok.claims.iss, "geodatatrack-dev");
  assert.equal(ok.claims.ai_consent, true);
  assert.equal(ok.claims.primary_consent, true);
  assert.equal(ok.claims.report_id, 41);
  assert.equal(ok.claims.consent_at, "2026-11-09 18:00:00");
  assert.equal(ok.claims.contract, "report-bytes-v1.1");
  const replay = await verifier.verify(edAssertion(), context);
  assert.equal(replay.reason, "replay_rejected");
  const mismatched = await verifier.verify(edAssertion(), {
    reportBytes: Buffer.from("synthetic-eov-report-bytes!"),
    replayStore: onlyNewStore(),
    now: assertionNow,
  });
  assert.equal(mismatched.reason, "sha256_mismatch");
  const parts = edAssertion().split(".");
  const flipped = parts[2].slice(0, 8) + (parts[2][8] === "A" ? "B" : "A") + parts[2].slice(9);
  const badSig = await verifier.verify(`${parts[0]}.${parts[1]}.${flipped}`, {
    reportBytes: assertionBytes,
    replayStore: onlyNewStore(),
    now: assertionNow,
  });
  assert.equal(badSig.reason, "binding_rejected");
  zeroCalls();
});

await check("assertion iss, aud, lifetime, consent, and clock skew are enforced", async () => {
  const verifier = testVerifier();
  const base = { reportBytes: assertionBytes, replayStore: onlyNewStore(), now: assertionNow };
  const payload = assertionPayload();
  assert.equal((await verifier.verify(edAssertion({ ...payload, iss: "other-issuer", request_id: "request-iss" }), base)).reason, "issuer_mismatch");
  assert.equal((await verifier.verify(edAssertion({ ...payload, aud: "gdt-app:99", request_id: "request-aud" }), base)).reason, "audience_mismatch");
  assert.equal((await verifier.verify(edAssertion({ ...payload, exp: payload.iat + 301, request_id: "request-window" }), base)).reason, "assertion_window");
  assert.equal((await verifier.verify(edAssertion({ ...payload, ai_consent: false, request_id: "request-consent" }), base)).reason, "ai_consent_required");
  const early = await verifier.verify(edAssertion({ ...payload, request_id: "request-early" }), {
    ...base,
    now: payload.iat * 1000 - 31_000,
  });
  assert.equal(early.reason, "assertion_not_yet_valid");
  const late = await verifier.verify(edAssertion({ ...payload, request_id: "request-late" }), {
    ...base,
    now: (payload.iat + 300) * 1000 + 31_000,
  });
  assert.equal(late.reason, "assertion_expired");
  const skewed = await verifier.verify(edAssertion({ ...payload, request_id: "request-skew" }), {
    ...base,
    replayStore: onlyNewStore(),
    now: (payload.iat + 300) * 1000 + 20_000,
  });
  assert.equal(skewed.ok, true);
  zeroCalls();
});

await check("unknown kid, tampered payload, and a non-EdDSA token are refused", async () => {
  const verifier = testVerifier();
  const base = { reportBytes: assertionBytes, replayStore: onlyNewStore(), now: assertionNow };
  const unknown = await verifier.verify(edAssertion({ ...assertionPayload(), kid: "other-kid", request_id: "request-kid" }), base);
  assert.equal(unknown.reason, "unknown_kid");
  const token = edAssertion(assertionPayload({ request_id: "request-tamper" }));
  const parts = token.split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  payload.property_id = 999;
  const tampered = `${parts[0]}.${Buffer.from(canonicalAssertion({ ...assertionPayload(), request_id: "request-tamper", property_id: 999 }), "utf8").toString("base64url")}.${parts[2]}`;
  const tamperedResult = await verifier.verify(tampered, { ...base, replayStore: onlyNewStore() });
  assert.equal(tamperedResult.reason, "binding_rejected");
  const hmacLike = `hmac-sha256.${parts[1]}.${parts[2]}`;
  assert.equal((await verifier.verify(hmacLike, base)).reason, "binding_rejected");
  const missingSig = `${parts[0]}.${parts[1]}.`;
  assert.equal((await verifier.verify(missingSig, base)).reason, "binding_rejected");
  const v1Shape = `ed25519.${parts[1]}.${parts[2]}`;
  assert.equal((await verifier.verify(v1Shape, base)).reason, "binding_rejected");
  zeroCalls();
});

await check("a valid ed25519 assertion still makes no provider call", async () => {
  const payload = assertionPayload({ request_id: "request-assess" });
  const token = edAssertion(payload);
  const body = readyBody({
    binding_token: token,
    report: {
      report_id: "41",
      sha256: payload.sha256,
      byte_length: assertionBytes.length,
      generated_at: "2026-11-08T12:00:00Z",
    },
  });
  const verifier = testVerifier();
  const assessed = await assessEovReport({
    body,
    auth: { kind: "app" },
    verifier,
    ledger: memoryLedger(),
    policy: null,
    now: assertionNow,
    reportBytes: assertionBytes,
    replayStore: onlyNewStore(),
  });
  assert.equal(assessed.httpStatus, 200);
  assert.equal(assessed.payload.ok, true);
  assert.equal(assessed.payload.verified, true);
  assert.equal(assessed.payload.stage, "verifier_only");
  assert.equal(assessed.payload.reason, "verifier_only");
  assert.equal(assessed.payload.sha256_match, true);
  assert.equal(assessed.payload.kid, "test-kid-1");
  assert.equal(assessed.payload.request_id, "request-assess");
  assert.equal(assessed.payload.provider_calls, 0);
  assert.equal(assessed.payload.inference, "not_called");
  assert.equal(assessed.payload.shadow, "forced_off");
  zeroCalls();
});

await check("the GDT dev public key decodes to 32 bytes and imports as Ed25519", () => {
  const raw = Buffer.from(DEV_PUBLIC_KEY_B64U, "base64url");
  assert.equal(raw.length, 32);
  assert.equal(raw.toString("base64url"), DEV_PUBLIC_KEY_B64U);
  const imported = importEd25519Public(DEV_PUBLIC_KEY_B64U);
  assert.equal(imported != null, true);
  assert.equal(imported.key.asymmetricKeyType, "ed25519");
  assert.equal(imported.raw.length, 32);
  assert.deepEqual(imported.raw, raw);
  const config = readBindingConfig({
    CONTEXT: "deploy-preview",
    EIA_GDT_TRUST_DEV_KEY: "true",
  });
  assert.equal(trustDevIssuer({ CONTEXT: "deploy-preview", EIA_GDT_TRUST_DEV_KEY: "true" }), true);
  assert.equal(config.keys[DEV_KID], DEV_PUBLIC_KEY_B64U);
  zeroCalls();
});

await check("a throwaway signature under the GDT dev kid is rejected", async () => {
  const verifier = reportBindingVerifier({
    keys: { [DEV_KID]: DEV_PUBLIC_KEY_B64U },
    audience: TEST_AUD,
    context: "deploy-preview",
    trustDevKey: true,
  });
  const token = edAssertion({ ...assertionPayload({ kid: DEV_KID, request_id: "request-wrong-key" }) }, otherPrivateKey);
  // also with the first throwaway pair
  const token2 = edAssertion({ ...assertionPayload({ kid: DEV_KID, request_id: "request-wrong-key-2" }) }, privateKey);
  const base = { reportBytes: assertionBytes, replayStore: onlyNewStore(), now: assertionNow };
  const first = await verifier.verify(token, base);
  assert.equal(first.ok, false);
  assert.equal(first.reason, "binding_rejected");
  const second = await verifier.verify(token2, { ...base, replayStore: onlyNewStore() });
  assert.equal(second.reason, "binding_rejected");
  zeroCalls();
});

await check("the GDT dev key cannot be trusted in the production context", async () => {
  assert.equal(trustDevIssuer({ CONTEXT: "production", EIA_GDT_TRUST_DEV_KEY: "true" }), false);
  const productionConfig = readBindingConfig({
    CONTEXT: "production",
    EIA_GDT_TRUST_DEV_KEY: "true",
    EIA_EOV_BINDING_KEYS: JSON.stringify({ [DEV_KID]: DEV_PUBLIC_KEY_B64U }),
  });
  assert.equal(productionConfig.keys[DEV_KID], undefined);
  const injected = reportBindingVerifier({
    keys: { [DEV_KID]: DEV_PUBLIC_KEY_B64U },
    audience: TEST_AUD,
    context: "production",
    trustDevKey: true,
  });
  assert.equal(injected.kind, "issuer_unavailable");
  const underDevKid = edAssertion(assertionPayload({ kid: DEV_KID, request_id: "request-prod-dev" }));
  assert.equal((await injected.verify(underDevKid, {
    reportBytes: assertionBytes,
    replayStore: onlyNewStore(),
    now: assertionNow,
  })).reason, "issuer_unavailable");
  const productionIssuer = reportBindingVerifier({
    keys: { "test-kid-1": throwawayPublicPem },
    audience: TEST_AUD,
    context: "production",
  });
  const okShape = edAssertion(assertionPayload({ request_id: "request-prod-iss" }));
  const refused = await productionIssuer.verify(okShape, {
    reportBytes: assertionBytes,
    replayStore: onlyNewStore(),
    now: assertionNow,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "issuer_not_for_production");
  const noFlag = readBindingConfig({ CONTEXT: "deploy-preview" });
  assert.equal(noFlag.keys[DEV_KID], undefined);
  assert.equal(trustDevIssuer({ CONTEXT: "deploy-preview" }), false);
  zeroCalls();
});

await check("assertion clock skew is configurable and defaults to a provisional 30 seconds", async () => {
  const tight = testVerifier({ skewSeconds: 0 });
  const payload = assertionPayload({ request_id: "request-skew-0" });
  const late = await tight.verify(edAssertion(payload), {
    reportBytes: assertionBytes,
    replayStore: onlyNewStore(),
    now: (payload.iat + 300) * 1000 + 20_000,
  });
  assert.equal(late.reason, "assertion_expired");
  const wide = testVerifier({ skewSeconds: 60 });
  const ok = await wide.verify(edAssertion({ ...payload, request_id: "request-skew-60" }), {
    reportBytes: assertionBytes,
    replayStore: onlyNewStore(),
    now: (payload.iat + 300) * 1000 + 31_000,
  });
  assert.equal(ok.ok, true);
  assert.equal(assertionSkewSeconds({}), 30);
  assert.equal(assertionSkewSeconds({ EIA_GDT_ASSERTION_SKEW_SECONDS: "0" }), 0);
  assert.equal(assertionSkewSeconds({ EIA_GDT_ASSERTION_SKEW_SECONDS: "60" }), 60);
  assert.equal(assertionSkewSeconds({ EIA_GDT_ASSERTION_SKEW_SECONDS: "-1" }), 30);
  assert.equal(assertionSkewSeconds({ EIA_GDT_ASSERTION_SKEW_SECONDS: "301" }), 30);
  zeroCalls();
});

const samplePdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

function v11Body(overrides = {}, pdf = samplePdf, payloadOverrides = {}, nowSec = Math.floor(Date.now() / 1000)) {
  const payload = assertionPayload({
    request_id: "request-v11-http",
    iat: nowSec,
    exp: nowSec + 300,
    ...payloadOverrides,
  }, pdf);
  return {
    contract: CONTRACT_V11,
    gdt_assertion: edAssertion(payload),
    pdf_base64: pdf.toString("base64"),
    request_id: payload.request_id,
    identity: {
      iss: payload.iss,
      kid: payload.kid,
      aud: payload.aud,
      install_id: payload.install_id,
      property_id: payload.property_id,
      report_id: payload.report_id,
      request_id: payload.request_id,
      iat: payload.iat,
      exp: payload.exp,
    },
    ...overrides,
  };
}

await check("a report-bytes-v1.1 HTTP request verifies the received PDF and returns verifier-only success", async () => {
  const body = v11Body();
  setEovControlsForTests({
    verifier: testVerifier(),
    ledger: memoryLedger(),
    policy: null,
    replayStore: onlyNewStore(),
    verifierOnly: true,
  });
  try {
    const res = await eovReport(request(body));
    const payload = await res.json();
    assert.equal(res.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.verified, true);
    assert.equal(payload.stage, "verifier_only");
    assert.equal(payload.reason, "verifier_only");
    assert.equal(payload.sha256_match, true);
    assert.equal(payload.sha256, createHash("sha256").update(samplePdf).digest("hex"));
    assert.equal(payload.kid, "test-kid-1");
    assert.equal(payload.request_id, "request-v11-http");
    assert.equal(payload.provider_calls, 0);
    assert.equal(payload.inference, "not_called");
    assert.equal(payload.draft, null);
    assert.equal(payload.writes_to_gdt, false);
    zeroCalls();
  } finally {
    setEovControlsForTests(null);
  }
});

await check("v1.1 refuses a missing assertion, a garbage JWS, a digest mismatch, a bad identity, and a wrong contract", async () => {
  setEovControlsForTests({
    verifier: testVerifier(),
    ledger: memoryLedger(),
    policy: null,
    replayStore: onlyNewStore(),
    verifierOnly: true,
  });
  try {
    const base = v11Body();
    const noAssertion = { ...base };
    delete noAssertion.gdt_assertion;
    assert.equal((await (await eovReport(request(noAssertion))).json()).reason, "binding_required");

    const garbage = await eovReport(request({ ...base, gdt_assertion: "not-a-jws", request_id: "request-v11-garbage" }));
    const garbageBody = await garbage.json();
    assert.equal(garbage.status, 403);
    assert.equal(garbageBody.reason, "binding_rejected");
    assert.equal(garbageBody.verified, undefined);
    assert.equal(garbageBody.provider_calls, 0);
    assert.equal(garbageBody.inference, "not_called");

    const otherPdf = Buffer.from("%PDF-1.4\nother\n%%EOF\n");
    const signedForSample = v11Body({}, samplePdf, { request_id: "request-v11-digest" });
    const mismatch = await eovReport(request({
      contract: CONTRACT_V11,
      gdt_assertion: signedForSample.gdt_assertion,
      pdf_base64: otherPdf.toString("base64"),
      request_id: "request-v11-digest",
    }));
    assert.equal((await mismatch.json()).reason, "sha256_mismatch");

    const badId = await eovReport(request(v11Body({
      request_id: "request-v11-identity",
      identity: { property_id: 999, request_id: "request-v11-identity" },
    }, samplePdf, { request_id: "request-v11-identity" })));
    const badIdBody = await badId.json();
    assert.equal(badIdBody.reason, "identity_mismatch");

    const wrongContract = await eovReport(request({ ...base, contract: "report-bytes-v1" }));
    assert.equal((await wrongContract.json()).reason, "unsupported_contract");

    const noPdf = await eovReport(request({
      contract: CONTRACT_V11,
      gdt_assertion: base.gdt_assertion,
      request_id: "request-v11-nopdf",
    }));
    assert.equal((await noPdf.json()).reason, "report_bytes_required");

    const decoded = decodePdfBase64(samplePdf.toString("base64"));
    assert.deepEqual(decoded, samplePdf);
    zeroCalls();
  } finally {
    setEovControlsForTests(null);
  }
});

await check("pdf_base64 without a v1.1 contract is still refused, and a verified request never calls a provider", async () => {
  // The existing pdf_bytes_refused check covers the old body. This one
  // confirms a body that is otherwise consented still refuses pdf_base64
  // when contract is absent, and that verifier-only success is 200 with
  // inference not_called when no provider is configured.
  const consentedPdf = await eovReport(request({ ...consentedBody(), pdf_base64: samplePdf.toString("base64") }));
  assert.equal((await consentedPdf.json()).reason, "pdf_bytes_refused");
  const noProvider = v11Body({ request_id: "request-v11-noprovider" }, samplePdf, { request_id: "request-v11-noprovider" });
  setEovControlsForTests({
    verifier: testVerifier(),
    ledger: memoryLedger(),
    policy: null,
    replayStore: onlyNewStore(),
    verifierOnly: false,
  });
  try {
    const res = await eovReport(request(noProvider));
    const payload = await res.json();
    assert.equal(res.status, 200);
    assert.equal(payload.reason, "verifier_only");
    assert.equal(payload.provider_calls, 0);
    assert.equal(payload.inference, "not_called");
    zeroCalls();
  } finally {
    setEovControlsForTests(null);
  }
});

await check("the same address is rate limited before a provider call", async () => {
  const ip = "198.51.100.77";
  const reasons = [];
  for (let i = 0; i < 9; i += 1) {
    const res = await eovReport(request(baseBody(), { ip }));
    reasons.push((await res.json()).reason);
  }
  assert.equal(reasons.filter((reason) => reason === "ai_consent_false").length, 8);
  assert.equal(reasons[8], "rate_limited");
  zeroCalls();
});

globalThis.fetch = previousFetch;
await check("EOV report system prompt keeps seeker stance and the Nov 2026 guidance", () => {
  assertEovPromptShape(EOV_REPORT_SYSTEM);
  assert.match(EOV_PROMPT_VERSION, /^eov-report-system-v0\.2/);
  assert.match(EOV_REPORT_SYSTEM, /Avoid evaluative or judgement adjectives/);
  assert.match(EOV_REPORT_SYSTEM, /verifier checklist/);
  assert.match(EOV_REPORT_SYSTEM, /under 900 words/);
  assert.equal(/under 600 words/.test(EOV_REPORT_SYSTEM), false);
  zeroCalls();
});

console.log(`\n${passed} eov report checks passed`);

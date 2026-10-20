/**
 * Doctrine and safety checks for the review of PR #2.
 * No network. The model and GeoDataTrack are stubbed.
 *
 *   node scripts/doctrine-checks.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import eiaAnalyze from "../netlify/functions/eia-analyze.js";
import chat from "../netlify/functions/chat.js";
import eiaCompare from "../netlify/functions/eia-compare.js";
import eiaSession from "../netlify/functions/eia-session.js";
import { EIA_SYSTEM, PROMPT_VERSION, buildForceConstraintsPrompt, draftLabel } from "../netlify/functions/_shared/eia-prompt.js";
import { sanitiseEiaReturn, statusFromPackage } from "../netlify/functions/_shared/eia-sanitiser.js";
import { loadEcoregionPackage } from "../netlify/functions/_shared/ecoregion-package.js";
import { signSession, verifySession } from "../netlify/functions/_shared/eia-auth.js";
import { memoryCompareStore, setCompareStoreForTests } from "../netlify/functions/_shared/compare-store.js";
import { memorySpendStore, setSpendStoreForTests } from "../netlify/functions/_shared/spend-guard.js";
import { buildComparisonRecord } from "../netlify/functions/_shared/compare-record.js";

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.EIA_AUTH_SECRET = "test-auth-secret-0123456789";
process.env.EIA_APP_SECRET = "test-app-secret-0123456789";
process.env.EIA_CHAT_PASSPHRASE = "test-passphrase-0123456789";
process.env.COMPARE_ADMIN_TOKEN = "compare-secret";
process.env.SHADOW_ENABLED = "false";
process.env.EIA_DAILY_ANALYZE_CAP = "1000";
process.env.EIA_DAILY_CHAT_CAP = "1000";
delete process.env.SHADOW_CHAT_ALLOWED;
delete process.env.SHADOW_ALLOWED_PROPERTIES;
delete process.env.SHADOW_CONSENT_REF;
delete process.env.SHADOW_PROVIDER_HOSTS;
delete process.env.SHADOW_PROVIDER_BASE_URL;

const compareStore = memoryCompareStore();
setCompareStoreForTests(compareStore);
setSpendStoreForTests(memorySpendStore());

let passed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`PASS  ${name}`);
    });
}

function request(url, { body, ip = "203.0.113.50", token = process.env.EIA_APP_SECRET, origin } = {}) {
  const headers = { "Content-Type": "application/json", "x-nf-client-connection-ip": ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

function anthropic(payload) {
  return new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(payload) }],
    usage: { input_tokens: 3, output_tokens: 2 },
  }), { status: 200 });
}

const emptyProcesses = {
  mineral_cycle: { observations: [], questions: [], divergence: [], gaps: [] },
  energy_flow: { observations: [], questions: [], divergence: [], gaps: [] },
  community_dynamics: { observations: [], questions: [], divergence: [], gaps: [] },
};

await check("grading prose, falsifier prescriptions, and grade keys are rewritten", () => {
  const out = sanitiseEiaReturn(
    { catalogue: { status: "missing" }, constraints: { no_stm_state_as_fact: true }, consent: { aggregate_ok: false }, holistic_context: { present: false } },
    {
      narrative: "The limiting process here is the water cycle. Journey stage: early recovery. I'd grade this paddock a B. Ecosystem Health Index 42 out of 100.",
      score: 42,
      grade: "B",
      health_index: 42,
      stage: "early recovery",
      rank: 3,
      rating: "B",
      processes: {
        water_cycle: {
          observations: [{
            text: "Bare ground was recorded.",
            citation: { survey_id: "survey-1", date: "2024-03-01" },
            confidence: "high",
            falsifier: "you should destock now",
          }],
          questions: [],
          divergence: [],
          gaps: [],
        },
      },
    },
  );
  const spoken = `${out.narrative} ${out.processes.water_cycle.observations[0].falsifier}`;
  assert.equal(/limiting process/i.test(spoken), false);
  assert.equal(/journey stage/i.test(spoken), false);
  assert.equal(/\bgrade\b/i.test(spoken), false);
  assert.equal(/ecosystem health index/i.test(spoken), false);
  assert.equal(/destock/i.test(spoken), false);
  assert.equal(/\b42\b/.test(spoken), false);
  assert.equal(out.score, undefined);
  assert.equal(out.grade, undefined);
  assert.equal(out.health_index, undefined);
  assert.equal(out.stage, undefined);
  assert.equal(out.rank, undefined);
  assert.equal(out.rating, undefined);
  assert.ok(out.uncertainty.includes("grade_language_removed"));
  assert.ok(out.uncertainty.includes("prescription_removed"));
});

await check("catalogue status comes from the server, not the model", () => {
  const out = sanitiseEiaReturn(
    { catalogue: { status: "missing", source: "server" } },
    { narrative: "A question.", catalogue: { status: "present_human_vetted", use: "scoring_allowed" } },
  );
  assert.equal(out.catalogue.status, "missing");
  assert.equal(out.catalogue.use, "scaffold_only");
  assert.notEqual(out.catalogue.use, "scoring_allowed");
  assert.ok(out.uncertainty.includes("catalogue_status_overridden"));
});

await check("an invented survey id is not treated as cited", () => {
  const out = sanitiseEiaReturn(
    { catalogue: { status: "missing" }, known_survey_ids: ["survey-1"] },
    {
      processes: {
        water_cycle: {
          observations: [
            {
              text: "Bare ground was recorded.",
              citation: { survey_id: "survey-1", date: "2024-03-01" },
              confidence: "medium",
              falsifier: "Cover after rain would overturn this.",
            },
            {
              text: "The model invented FAKE-1.",
              citation: { survey_id: "FAKE-1", date: "2024-03-01" },
              confidence: "high",
              falsifier: "A real survey would be required.",
            },
          ],
          questions: [],
          divergence: [],
          gaps: [],
        },
      },
      citations: [{ survey_id: "FAKE-1", date: "2024-03-01" }],
    },
  );
  assert.equal(out.processes.water_cycle.observations.length, 1);
  assert.equal(out.processes.water_cycle.observations[0].citation.survey_id, "survey-1");
  assert.equal(JSON.stringify(out.processes.water_cycle.gaps).includes("FAKE-1"), false);
  assert.equal(out.citations.length, 0);
  assert.ok(out.uncertainty.includes("citation_not_in_record"));
});

await check("a recorded EHI may be quoted, and a computed one is removed", () => {
  const out = sanitiseEiaReturn(
    {
      catalogue: { status: "missing" },
      recorded_ehi: { value: "73.68", survey_id: "survey-1", date: "2026-01-01" },
    },
    {
      narrative: "EHI 73.68 as recorded in survey-1. I'd grade this paddock a B. EHI is 10/100.",
    },
  );
  assert.match(out.narrative, /73\.68/);
  assert.match(out.narrative, /recorded/);
  assert.equal(/\bgrade\b/i.test(out.narrative), false);
  assert.equal(/10\/100/.test(out.narrative), false);
});

await check("Yellowstone and a bottom percentage are not comparisons", () => {
  const out = sanitiseEiaReturn(
    { catalogue: { status: "missing" }, consent: { aggregate_ok: false }, constraints: { no_foreign_property_names: true } },
    { narrative: "This paddock is like Yellowstone and sits in the bottom 12%." },
  );
  assert.equal(/yellowstone/i.test(out.narrative), false);
  assert.equal(/bottom\s+12\s*%/i.test(out.narrative), false);
});

await check("statusFromPackage never lets the model, or an unvetted package, allow scoring", () => {
  assert.equal(statusFromPackage(null).use, "scaffold_only");
  const draft = statusFromPackage({
    catalogue: { status: "ai_draft_not_vetted", use: "scoring_allowed", scoring_allowed: true },
  });
  assert.notEqual(draft.use, "scoring_allowed");
  assert.equal(draft.scoring_allowed, false);
  const vettedOff = statusFromPackage({
    catalogue: { status: "present_human_vetted", use: "scoring_allowed", scoring_allowed: false },
  });
  assert.equal(vettedOff.use, "questions_only");
  const vettedOn = statusFromPackage({
    eco_id: "PA0409",
    catalogue: { status: "present_human_vetted", scoring_allowed: true },
  });
  assert.equal(vettedOn.use, "scoring_allowed");
  assert.equal(vettedOn.scoring_allowed, true);
  assert.equal(vettedOn.ecoregion_id, "PA0409");
});

await check("ecoregion client tries the API, then the static file, then the PA0409 fixture", async () => {
  const calls = [];
  const loaded = await loadEcoregionPackage("PA0409", {
    fetchImpl: async (url, opts) => {
      calls.push({ url: String(url), method: opts.method });
      if (String(url).includes("/api/")) return new Response("no", { status: 404 });
      return new Response(JSON.stringify({
        eco_id: "PA0409",
        catalogue: { status: "ai_draft_not_vetted", use: "questions_only", scoring_allowed: false },
      }), { status: 200 });
    },
  });
  assert.equal(loaded.source, "static");
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.method === "GET" && call.url.startsWith("https://ecoregion.net/")), true);
  const derived = statusFromPackage(loaded.package);
  assert.notEqual(derived.use, "scoring_allowed");

  const fixture = await loadEcoregionPackage("PA0409", {
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(fixture.source, "fixture");
  assert.equal(statusFromPackage(fixture.package).scoring_allowed, false);
  assert.equal(fixture.package.indicators, 15);

  const missing = await loadEcoregionPackage("ZZ9999", {
    fetchImpl: async () => new Response("no", { status: 404 }),
  });
  assert.equal(missing.ok, false);
});

await check("the prompt forbids scoring language and the server constraints block is attached", () => {
  assert.equal(PROMPT_VERSION, "eia-system-v3.1-2026-10-20");
  assert.match(EIA_SYSTEM, /as recorded/);
  assert.match(EIA_SYSTEM, /belongs to the people you work with/);
  assert.match(EIA_SYSTEM, /15 indicators, not 16/);
  assert.equal(/indicator scores aggregate/i.test(EIA_SYSTEM), false);
  assert.equal(/best recommendation/i.test(EIA_SYSTEM), false);
  assert.equal(/plan is unwise/i.test(EIA_SYSTEM), false);
  assert.equal(EIA_SYSTEM.includes("priority_lever"), false);
  const block = buildForceConstraintsPrompt({
    catalogue: { status: "missing", use: "scaffold_only", ecoregion_id: "PA0409" },
  });
  assert.match(block, /eco_id: PA0409/);
  assert.match(block, /indicators: 15/);
  assert.match(block, /scoring_allowed: false/);
  assert.match(block, /catalogue_status: missing/);
});

await check("a request with no Origin and no credential does not reach the model", async () => {
  let called = false;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("model should not be called");
  };
  try {
    const res = await eiaAnalyze(new Request("https://hm-eia.netlify.app/api/eia-analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "overview" }),
    }));
    assert.equal(res.status, 401);
    const chatRes = await chat(new Request("https://hm-eia.netlify.app/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    }));
    assert.equal(chatRes.status, 401);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previous;
  }
});

await check("expired, tampered, and missing-secret calls are refused", async () => {
  const expired = signSession({ sub: "gdt", property_apikey: "prop-rbh" }, Date.now() - 10 * 24 * 60 * 60 * 1000);
  assert.equal(verifySession(expired, Date.now()).expired, true);
  const stale = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
    ip: "203.0.113.51",
    token: expired,
    body: { mode: "overview" },
  }));
  assert.equal(stale.status, 401);

  const tampered = `${signSession({ sub: "gdt" })}x`;
  const bad = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
    ip: "203.0.113.52",
    token: tampered,
    body: { mode: "overview" },
  }));
  assert.equal(bad.status, 401);

  const savedSecret = process.env.EIA_AUTH_SECRET;
  const savedApp = process.env.EIA_APP_SECRET;
  delete process.env.EIA_AUTH_SECRET;
  delete process.env.EIA_APP_SECRET;
  try {
    const closed = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
      ip: "203.0.113.53",
      token: "anything",
      body: { mode: "overview" },
    }));
    assert.equal(closed.status, 503);
  } finally {
    process.env.EIA_AUTH_SECRET = savedSecret;
    process.env.EIA_APP_SECRET = savedApp;
  }
});

await check("a GDT session is minted only after an allow-listed GET, and a passphrase session has no property", async () => {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, authorization: opts.headers.Authorization });
    if (String(url).includes("/oauth/properties")) {
      return new Response(JSON.stringify({ list: [{ property_apikey: "prop-rbh" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { org_apikey: "org-1" } }), { status: 200 });
  };
  try {
    const refused = await eiaSession(request("https://hm-eia.netlify.app/api/eia-session", {
      ip: "203.0.113.54",
      token: "",
      body: { grant: "gdt", base: "https://evil.example", token: "gdt-token", property_apikey: "prop-rbh" },
    }));
    assert.equal(refused.status, 400);
    assert.equal(calls.length, 0);

    const minted = await eiaSession(request("https://hm-eia.netlify.app/api/eia-session", {
      ip: "203.0.113.55",
      token: "",
      body: {
        grant: "gdt",
        base: "https://app.geodatatrack.com/api/v1",
        token: "gdt-token-not-logged",
        property_apikey: "prop-rbh",
      },
    }));
    assert.equal(minted.status, 200);
    const mintedBody = await minted.json();
    const session = verifySession(mintedBody.token);
    assert.equal(session.ok, true);
    assert.equal(session.property_apikey, "prop-rbh");
    assert.equal(session.org, "org-1");
    assert.equal(calls.every((call) => call.method === "GET"), true);
    assert.equal(calls.every((call) => call.url.startsWith("https://app.geodatatrack.com/")), true);
    assert.equal(calls.some((call) => call.authorization === "Bearer gdt-token-not-logged"), true);

    const wrong = await eiaSession(request("https://hm-eia.netlify.app/api/eia-session", {
      ip: "203.0.113.56",
      token: "",
      body: { grant: "passphrase", passphrase: "nope" },
    }));
    assert.equal(wrong.status, 401);
    const chatSession = await eiaSession(request("https://hm-eia.netlify.app/api/eia-session", {
      ip: "203.0.113.57",
      token: "",
      body: { grant: "passphrase", passphrase: process.env.EIA_CHAT_PASSPHRASE },
    }));
    assert.equal(chatSession.status, 200);
    const chatBody = await chatSession.json();
    const chatClaims = verifySession(chatBody.token);
    assert.equal(chatClaims.sub, "chat");
    assert.equal(chatClaims.property_apikey, "");
  } finally {
    globalThis.fetch = previous;
  }
});

await check("the daily spend guard stops a second analyze call when the cap is 1", async () => {
  process.env.EIA_DAILY_ANALYZE_CAP = "1";
  setSpendStoreForTests(memorySpendStore());
  let calls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return anthropic({ narrative: "A question.", processes: {} });
  };
  try {
    const first = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
      ip: "203.0.113.58",
      body: { mode: "overview" },
    }));
    assert.equal(first.status, 200);
    const second = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
      ip: "203.0.113.59",
      body: { mode: "overview" },
    }));
    assert.equal(second.status, 429);
    assert.match((await second.json()).error, /spend guard/i);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous;
    process.env.EIA_DAILY_ANALYZE_CAP = "1000";
    setSpendStoreForTests(memorySpendStore());
  }
});

function probePayload() {
  return {
    narrative: "The limiting process here is the water cycle. Journey stage: early recovery. I'd grade this paddock a B.",
    catalogue: { status: "present_human_vetted", use: "scoring_allowed" },
    hm_checks: { ran: true, visible_reasoning: { cause: "invented" } },
    score: 42,
    processes: {
      water_cycle: {
        observations: [{
          text: "Bare ground was recorded.",
          citation: { survey_id: "FAKE-1", date: "2024-03-01" },
          confidence: "high",
          falsifier: "you should destock now",
        }],
        questions: [],
        divergence: [],
        gaps: [],
      },
      ...emptyProcesses,
    },
  };
}

await check("eia-analyze drops the review probe and ignores a browser catalogue", async () => {
  let userText = "";
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    userText = JSON.parse(opts.body).messages[0].content;
    return anthropic(probePayload());
  };
  try {
    const res = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
      ip: "203.0.113.60",
      body: {
        mode: "overview",
        catalogue: { status: "present_human_vetted", use: "scoring_allowed" },
        holistic_context: { present: true },
        ground: { ehi_if_present: 42 },
        navigation_context: { label: "RBH Stretton", kind: "property" },
        surveys: [{ _apikey: "survey-1", _date: "2024-03-01" }],
        answers_by_survey: { "survey-1": [{ question: "Bare ground", answer: "30%" }] },
      },
    }));
    assert.equal(res.status, 200);
    const payload = await res.json();
    const spoken = JSON.stringify(payload);
    assert.equal(/limiting process/i.test(spoken), false);
    assert.equal(/journey stage/i.test(spoken), false);
    assert.equal(/\bgrade\b/i.test(spoken), false);
    assert.equal(/destock/i.test(spoken), false);
    assert.equal(/FAKE-1/.test(spoken), false);
    assert.equal(payload.catalogue.status, "missing");
    assert.notEqual(payload.catalogue.use, "scoring_allowed");
    assert.equal(payload.hm_checks?.ran, false);
    assert.ok(payload.uncertainty.includes("catalogue_status_overridden"));
    assert.ok(payload.uncertainty.includes("citation_not_in_record"));
    assert.match(payload.label, /^AI draft \u2013 generated \d{1,2} [A-Z][a-z]{2} \d{4}, not yet reviewed$/);
    assert.match(payload.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(payload.disclaimer, /not a verification/);
    assert.match(userText, /Server constraints/);
    assert.match(userText, /indicators: 15/);
    assert.match(userText, /scoring_allowed: false/);
    assert.equal(draftLabel(new Date("2026-10-20T12:00:00Z")), "AI draft \u2013 generated 20 Oct 2026, not yet reviewed");
  } finally {
    globalThis.fetch = previous;
  }
});

await check("a recorded EHI in the evidence is quoted and the browser cannot supply one", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => anthropic({
    narrative: "EHI 73.68 as recorded in survey-1. Ecosystem Health Index 42 out of 100.",
    processes: {
      water_cycle: { observations: [], questions: [], divergence: [], gaps: [] },
      ...emptyProcesses,
    },
  });
  try {
    const res = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
      ip: "203.0.113.61",
      body: {
        mode: "overview",
        surveys: [{ _apikey: "survey-1", _date: "2026-01-01" }],
        answers_by_survey: { "survey-1": [{ question: "Ecosystem Health Index", answer: "73.68" }] },
      },
    }));
    const payload = await res.json();
    assert.match(payload.narrative, /73\.68/);
    assert.match(payload.narrative, /recorded/);
    assert.equal(/ecosystem health index/i.test(payload.narrative), false);
    assert.equal(/\b42\b/.test(payload.narrative), false);
  } finally {
    globalThis.fetch = previous;
  }
});

function allowShadow() {
  process.env.SHADOW_ENABLED = "true";
  process.env.SHADOW_PROVIDER_BASE_URL = "https://openrouter.ai/api/v1";
  process.env.SHADOW_PROVIDER_HOSTS = "openrouter.ai";
  process.env.SHADOW_ALLOWED_PROPERTIES = "prop-rbh";
  process.env.SHADOW_CONSENT_REF = "TruQuest letter 20/10/2026";
  process.env.SHADOW_API_KEY = "shadow-key";
}

await check("shadow runs only for an allow-listed property, never from the browser label", async () => {
  allowShadow();
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("anthropic")) return anthropic({ narrative: "Primary.", processes: {} });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"narrative\":\"Shadow.\"}" } }] }), { status: 200 });
  };
  const bucket = { jobs: [] };
  bucket.context = { waitUntil(job) { bucket.jobs.push(job); } };
  try {
    const offList = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
      ip: "203.0.113.62",
      token: signSession({ sub: "gdt", property_apikey: "prop-other" }),
      body: { mode: "overview", navigation_context: { label: "RBH Stretton" } },
    }), bucket.context);
    assert.equal(offList.status, 200);
    await Promise.all(bucket.jobs);
    assert.deepEqual(calls, ["https://api.anthropic.com/v1/messages"]);

    calls.length = 0;
    const fromBrowser = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
      ip: "203.0.113.63",
      body: { mode: "overview", property_apikey: "prop-rbh", navigation_context: { label: "prop-rbh" } },
    }));
    assert.equal(fromBrowser.status, 200);
    assert.deepEqual(calls, ["https://api.anthropic.com/v1/messages"]);

    calls.length = 0;
    const allowed = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
      ip: "203.0.113.64",
      token: signSession({ sub: "gdt", property_apikey: "prop-rbh" }),
      body: { mode: "overview", navigation_context: { label: "RBH Stretton" } },
    }), bucket.context);
    assert.equal(allowed.status, 200);
    await Promise.all(bucket.jobs);
    assert.equal(calls.filter((url) => url.includes("openrouter")).length, 1);
  } finally {
    globalThis.fetch = previous;
    process.env.SHADOW_ENABLED = "false";
  }
});

await check("chat shadow stays off unless SHADOW_CHAT_ALLOWED and the property is allow-listed", async () => {
  allowShadow();
  delete process.env.SHADOW_CHAT_ALLOWED;
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "A question first." }] }), { status: 200 });
  };
  const messages = { messages: [{ role: "user", content: "What is the water doing?" }] };
  try {
    const quiet = await chat(request("https://hm-eia.netlify.app/api/chat", {
      ip: "203.0.113.65",
      token: signSession({ sub: "gdt", property_apikey: "prop-rbh" }),
      body: messages,
    }));
    assert.equal(quiet.status, 200);
    const quietBody = await quiet.json();
    assert.equal(quietBody.response, "A question first.");
    assert.match(quietBody.label, /AI draft/);
    assert.equal(calls.length, 1);

    process.env.SHADOW_CHAT_ALLOWED = "true";
    const open = await chat(request("https://hm-eia.netlify.app/api/chat", {
      ip: "203.0.113.66",
      token: signSession({ sub: "gdt", property_apikey: "prop-rbh" }),
      body: messages,
    }));
    assert.equal(open.status, 200);
    assert.equal(calls.filter((url) => url.includes("openrouter")).length, 1);

    const passphrase = await chat(request("https://hm-eia.netlify.app/api/chat", {
      ip: "203.0.113.67",
      token: signSession({ sub: "chat" }),
      body: messages,
    }));
    assert.equal(passphrase.status, 200);
    assert.equal(calls.filter((url) => url.includes("openrouter")).length, 1);
  } finally {
    globalThis.fetch = previous;
    process.env.SHADOW_ENABLED = "false";
    delete process.env.SHADOW_CHAT_ALLOWED;
  }
});

await check("a shadow host that is not allow-listed is not called", async () => {
  allowShadow();
  process.env.SHADOW_PROVIDER_BASE_URL = "https://evil.example/v1";
  process.env.SHADOW_PROVIDER_HOSTS = "openrouter.ai";
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return anthropic({ narrative: "Primary.", processes: {} });
  };
  try {
    const res = await eiaAnalyze(request("https://hm-eia.netlify.app/api/eia-analyze", {
      ip: "203.0.113.68",
      token: signSession({ sub: "gdt", property_apikey: "prop-rbh" }),
      body: { mode: "overview" },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ["https://api.anthropic.com/v1/messages"]);
  } finally {
    globalThis.fetch = previous;
    process.env.SHADOW_ENABLED = "false";
  }
});

await check("comparison records expire and an admin can delete them without a query token", async () => {
  const old = buildComparisonRecord({
    property: "RBH",
    propertyApikey: "prop-rbh",
    consentRef: "letter",
    retentionDays: 180,
    runAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
    hash: "abc",
    mode: "overview",
    primary: { model: "a" },
    shadow: { model: "b" },
  });
  old.expires_at = new Date(Date.now() - 1000).toISOString();
  const kept = buildComparisonRecord({
    property: "RBH",
    propertyApikey: "prop-rbh",
    consentRef: "letter",
    retentionDays: 180,
    runAt: new Date().toISOString(),
    hash: "def",
    mode: "overview",
    primary: { model: "a" },
    shadow: { model: "b" },
  });
  await compareStore.setJSON(old.key, old);
  await compareStore.setJSON(kept.key, kept);

  const query = await eiaCompare(new Request(
    `https://hm-eia.netlify.app/.netlify/functions/eia-compare?token=${process.env.COMPARE_ADMIN_TOKEN}`,
  ));
  assert.equal(query.status, 401);

  const list = await eiaCompare(new Request("https://hm-eia.netlify.app/.netlify/functions/eia-compare", {
    headers: { "x-compare-token": process.env.COMPARE_ADMIN_TOKEN },
  }));
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.runs.some((run) => run.key === old.key), false);
  assert.equal(body.runs.some((run) => run.key === kept.key), true);
  assert.equal(await compareStore.get(old.key, { type: "json" }), null);

  const removed = await eiaCompare(new Request(
    `https://hm-eia.netlify.app/.netlify/functions/eia-compare?property_apikey=${encodeURIComponent("prop-rbh")}`,
    { method: "DELETE", headers: { "x-compare-token": process.env.COMPARE_ADMIN_TOKEN } },
  ));
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).deleted >= 1, true);
  assert.equal(await compareStore.get(kept.key, { type: "json" }), null);
});

await check("the pages label drafts, gate chat, and do not take the admin token from the query", () => {
  const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const chatHtml = readFileSync(new URL("../public/chat.html", import.meta.url), "utf8");
  const compareHtml = readFileSync(new URL("../compare.html", import.meta.url), "utf8");
  assert.match(index, /\/api\/eia-session/);
  assert.match(index, /originIsGdt/);
  assert.match(index, /a\.label/);
  assert.match(chatHtml, /passphrase/);
  assert.match(chatHtml, /data\.label/);
  assert.match(compareHtml, /Delete this run/);
  assert.equal(compareHtml.includes('params.get("token")'), false);
});

console.log(`\n${passed} checks passed`);

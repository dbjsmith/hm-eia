/**
 * Phase 0(c)(d) checks. No network. The model call is stubbed.
 *
 *   node scripts/phase0-checks.mjs
 */

import assert from "node:assert/strict";
import gdtProxy from "../netlify/functions/gdt-proxy.js";
import eiaAnalyze from "../netlify/functions/eia-analyze.js";
import chat from "../netlify/functions/chat.js";
import { buildGdtGetUrl, isAllowedGdtBase } from "../netlify/functions/_shared/gdt-allow.js";
import { originAllowed } from "../netlify/functions/_shared/cors.js";
import { EIA_SYSTEM, PROMPT_VERSION } from "../netlify/functions/_shared/eia-prompt.js";
import { sanitiseEiaReturn } from "../netlify/functions/_shared/eia-sanitiser.js";
import { LIMITS } from "../netlify/functions/_shared/limits.js";

process.env.SHADOW_ENABLED = "false";

const FORBIDDEN_KEYS = ["ehi", "journey_stage", "limiting_process", "priority_lever"];
let passed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`PASS  ${name}`);
    });
}

function keysOf(value, found = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => keysOf(item, found));
    return found;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      found.push(key);
      keysOf(value[key], found);
    }
  }
  return found;
}

function assertNoGradeKeys(value) {
  const keys = keysOf(value).map((key) => key.toLowerCase());
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.includes(forbidden), false, `output still has key ${forbidden}`);
  }
}

function jsonRequest(url, { method = "POST", origin, host, ip, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  if (host) headers.Host = host;
  if (ip) headers["x-nf-client-connection-ip"] = ip;
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const baseContext = {
  constraints: { no_foreign_property_names: true, no_stm_state_as_fact: true },
  consent: { aggregate_ok: false },
  holistic_context: { present: false },
  ground: { property_name: "RBH Stretton", ehi_if_present: null },
  catalogue: { status: "missing" },
};

await check("prompt is the versioned apprentice stance and has no score ranges", () => {
  assert.equal(PROMPT_VERSION, "eia-system-v3-2026-10-12");
  assert.match(EIA_SYSTEM, /apprentice/i);
  assert.match(EIA_SYSTEM, /15 indicators, not 16/);
  assert.match(EIA_SYSTEM, /accredited verifier decides/);
  assert.equal(EIA_SYSTEM.includes("calibrated to ecoregion reference area"), false);
  assert.equal(EIA_SYSTEM.includes("-20 to +20"), false);
  assert.equal(EIA_SYSTEM.includes("priority_lever"), false);
});

await check("gdt base allow-list rejects non-GDT, http, and the dev fallback host", () => {
  assert.equal(isAllowedGdtBase("https://evil.example"), false);
  assert.equal(isAllowedGdtBase("https://geodatatrack-dev.phpbucket.net"), false);
  assert.equal(isAllowedGdtBase("http://app.geodatatrack.com"), false);
  assert.equal(isAllowedGdtBase("https://app.geodatatrack.com.evil.com"), false);
  assert.equal(isAllowedGdtBase("https://evil.com@app.geodatatrack.com"), false);
  assert.equal(isAllowedGdtBase("https://app.geodatatrack.com/api/v1"), true);
  assert.equal(isAllowedGdtBase("https://api.geodatatrack.com"), true);
  assert.equal(isAllowedGdtBase("https://staging.geodatatrack.com/api/v1"), true);
  assert.equal(buildGdtGetUrl("https://evil.example", "/oauth/surveys"), null);
  assert.equal(buildGdtGetUrl("https://app.geodatatrack.com/api/v1", "/admin"), null);
  assert.equal(buildGdtGetUrl("https://app.geodatatrack.com/api/v1", "/oauth/../secrets"), null);
});

await check("gdt-proxy rejects a non-GDT base and never fetches", async () => {
  let called = false;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not run");
  };
  try {
    const res = await gdtProxy(
      jsonRequest("https://hm-eia.netlify.app/.netlify/functions/gdt-proxy", {
        body: {
          base: "https://geodatatrack-dev.phpbucket.net",
          path: "/oauth/surveys",
          token: "secret-token-value",
        },
      }),
    );
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.match(payload.error, /not allowed/i);
    const posted = await gdtProxy(
      jsonRequest("https://hm-eia.netlify.app/.netlify/functions/gdt-proxy", {
        body: {
          base: "https://app.geodatatrack.com/api/v1",
          path: "/oauth/surveys",
          token: "secret-token-value",
          method: "POST",
        },
      }),
    );
    assert.equal(posted.status, 400);
    assert.match((await posted.json()).error, /Only GET/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previous;
  }
});

await check("gdt-proxy forwards GET only to an allow-listed /oauth path", async () => {
  const token = "super-secret-access-token-0123456789";
  let seen;
  const logs = [];
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), method: opts.method, authorization: opts.headers.Authorization };
    return new Response(JSON.stringify({ list: [] }), { status: 200 });
  };
  try {
    const res = await gdtProxy(
      jsonRequest("https://hm-eia.netlify.app/.netlify/functions/gdt-proxy", {
        body: {
          base: "https://app.geodatatrack.com/api/v1",
          path: "/oauth/surveys",
          params: { _apikey: "abc" },
          token,
        },
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(seen.method, "GET");
    assert.equal(seen.url, "https://app.geodatatrack.com/api/v1/oauth/surveys?_apikey=abc");
    assert.equal(seen.authorization, `Bearer ${token}`);
    assert.equal(logs.some((line) => line.includes(token)), false);
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
});

await check("CORS rejects a non-GDT origin on every function", async () => {
  const origin = "https://evil.example";
  const host = "hm-eia.netlify.app";
  for (const handler of [gdtProxy, eiaAnalyze, chat]) {
    const res = await handler(jsonRequest("https://hm-eia.netlify.app/.netlify/functions/x", {
      method: "OPTIONS",
      origin,
      host,
    }));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(originAllowed("https://evil.example"), false);
  assert.equal(originAllowed("http://app.geodatatrack.com"), false);
  assert.equal(originAllowed("*"), false);
});

await check("CORS reflects a GeoDataTrack https origin and the widget's own host", async () => {
  const gdt = await gdtProxy(jsonRequest("https://hm-eia.netlify.app/.netlify/functions/gdt-proxy", {
    method: "OPTIONS",
    origin: "https://staging.geodatatrack.com",
    host: "hm-eia.netlify.app",
  }));
  assert.equal(gdt.status, 204);
  assert.equal(gdt.headers.get("access-control-allow-origin"), "https://staging.geodatatrack.com");

  const same = await chat(jsonRequest("https://hm-eia.netlify.app/api/chat", {
    method: "OPTIONS",
    origin: "https://hm-eia.netlify.app",
    host: "hm-eia.netlify.app",
  }));
  assert.equal(same.status, 204);
  assert.equal(same.headers.get("access-control-allow-origin"), "https://hm-eia.netlify.app");
  assert.notEqual(same.headers.get("access-control-allow-origin"), "*");
});

await check("sanitiser v0 strips Knepp, percentiles, State A, EHI, and fake HM checks", () => {
  const scenarioA = sanitiseEiaReturn(baseContext, {
    signals: [{
      process: "water",
      observation: "Bare soil was noted on the north transect in March.",
      confidence: "medium",
      falsifier: "A covered surface after the next rain would overturn this.",
    }],
    questions_for_steward: [{ level: "observational", ask: "Where does water sit after rain on this paddock?" }],
    catalogue: { ecoregion_id: "PA0409", status: "missing", use: "scaffold_only" },
    hm_checks: { ran: false, reason_if_skipped: "holistic_context_absent", visible_reasoning: null },
    uncertainty: [],
  });
  assert.equal(scenarioA.signals[0].observation, "Bare soil was noted on the north transect in March.");
  assert.equal(scenarioA.hm_checks.ran, false);
  assert.equal(scenarioA.catalogue.use, "scaffold_only");

  const scenarioC = sanitiseEiaReturn(
    { ...baseContext, catalogue: { status: "ai_draft_not_vetted" } },
    {
      signals: [{
        process: "water",
        observation: "Compared with Knepp this paddock is in State A and is Severely Degraded, 35th percentile.",
        confidence: "high",
        falsifier: "",
      }],
      catalogue: { status: "ai_draft_not_vetted", use: "scoring_allowed" },
      hm_checks: { ran: true, visible_reasoning: { cause: "invented" } },
    },
  );
  const spokenC = `${scenarioC.signals[0].observation} ${JSON.stringify(scenarioC.questions_for_steward)}`;
  assert.equal(/knepp/i.test(spokenC), false);
  assert.equal(/percentile/i.test(spokenC), false);
  assert.equal(/state a/i.test(spokenC), false);
  assert.notEqual(scenarioC.catalogue.use, "scoring_allowed");
  assert.equal(scenarioC.hm_checks.ran, false);
  assert.equal(scenarioC.hm_checks.visible_reasoning, null);
  assert.equal(scenarioC.signals[0].confidence, "low");

  const scenarioB = sanitiseEiaReturn(baseContext, {
    signals: [{
      process: "mineral",
      observation: "Dung was still intact.",
      confidence: "low",
      falsifier: "Dung broken down within a week would overturn this.",
    }],
    hm_checks: { ran: true, visible_reasoning: { weak_link: "invented check prose" } },
  });
  assert.equal(scenarioB.hm_checks.ran, false);
  assert.equal(scenarioB.hm_checks.reason_if_skipped, "holistic_context_absent");

  const ehi = sanitiseEiaReturn(baseContext, {
    signals: [{
      process: "energy",
      observation: "EHI is 42/100 on this paddock.",
      confidence: "low",
      falsifier: "The record does not contain an index.",
    }],
  });
  assert.equal(/\bEHI\b/.test(ehi.signals[0].observation), false);
  assert.equal(/\b42\b/.test(ehi.signals[0].observation), false);
});

function stubModel(payload) {
  return async (url, opts) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const sent = JSON.parse(opts.body);
    assert.equal(sent.max_tokens <= LIMITS.analyze.maxTokens, true);
    assert.equal(sent.system, EIA_SYSTEM);
    assert.equal(sent.system.includes("calibrated to ecoregion reference area"), false);
    return new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

await check("eia-analyze overview drops grade keys from a stubbed model response", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const previous = globalThis.fetch;
  globalThis.fetch = stubModel({
    narrative: "EHI is 42/100. You should destock. Knepp is the target and this is State A, 35th percentile.",
    ehi: 42,
    journey_stage: "early",
    limiting_process: "water_cycle",
    priority_lever: "Destock the herd",
    processes: {
      water_cycle: {
        observations: [{
          text: "Bare ground was recorded.",
          citation: { survey_id: "survey-1", date: "2024-03-01" },
          confidence: "high",
          falsifier: "Cover after the next rain would overturn this.",
        }],
        questions: [{
          text: "Where does water sit after rain on this paddock?",
          confidence: "medium",
          falsifier: "No sheeting after rain would change the question.",
        }],
        divergence: [],
        gaps: [{ text: "No photo is in the record.", confidence: "low", falsifier: "A photo from this point would fill the gap." }],
      },
      mineral_cycle: {
        observations: [{
          text: "Litter looked thin next to Knepp.",
          citation: { survey_id: "survey-1", date: "2024-03-01" },
          confidence: "low",
          falsifier: "A continuous litter layer would overturn this.",
        }],
        questions: [],
        divergence: [],
        gaps: [],
      },
      energy_flow: { observations: [], questions: [], divergence: [], gaps: [] },
      community_dynamics: { observations: [], questions: [], divergence: [], gaps: [] },
    },
    hm_checks: { ran: true, visible_reasoning: { cause: "invented" } },
  });
  try {
    const res = await eiaAnalyze(jsonRequest("https://hm-eia.netlify.app/.netlify/functions/eia-analyze", {
      ip: "203.0.113.10",
      body: {
        mode: "overview",
        navigation_context: { label: "RBH Stretton", kind: "property" },
        surveys: [{ _apikey: "survey-1", name: "North 20240301", _date: "2024-03-01" }],
        answers_by_survey: { "survey-1": [{ question: "Bare ground", answer: "40%" }] },
        eov_scores: { ehi: 42, water_cycle: 10 },
      },
    }));
    assert.equal(res.status, 200);
    const payload = await res.json();
    assertNoGradeKeys(payload);
    assert.equal(payload.prompt_version, PROMPT_VERSION);
    const spoken = JSON.stringify({
      narrative: payload.narrative,
      processes: payload.processes,
      questions: payload.questions,
    });
    assert.equal(/\bEHI\b/i.test(spoken), false);
    assert.equal(/knepp/i.test(spoken), false);
    assert.equal(/percentile/i.test(spoken), false);
    assert.equal(payload.hm_checks.ran, false);
    assert.ok(payload.processes.water_cycle.observations[0].citation.survey_id);
    assert.ok(Array.isArray(payload.questions));
    assert.equal(payload.questions.length > 0, true);
  } finally {
    globalThis.fetch = previous;
  }
});

await check("eia-analyze mode answer returns an answer field and no grade keys", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const previous = globalThis.fetch;
  globalThis.fetch = stubModel({
    answer: "EHI is 12. You should destock. The water cycle is Severely Degraded.",
    ehi: 12,
    journey_stage: "building",
    limiting_process: "water_cycle",
    priority_lever: "rest the paddock",
    citations: [{ survey_id: "survey-1", date: "2024-03-01", note: "bare ground" }],
  });
  try {
    const res = await eiaAnalyze(jsonRequest("https://hm-eia.netlify.app/.netlify/functions/eia-analyze", {
      ip: "203.0.113.11",
      body: {
        mode: "answer",
        question: "What is the water doing here?",
        navigation_context: { label: "RBH Stretton" },
        surveys: [{ _apikey: "survey-1", _date: "2024-03-01" }],
        answers_by_survey: {},
      },
    }));
    assert.equal(res.status, 200);
    const payload = await res.json();
    assertNoGradeKeys(payload);
    assert.equal(typeof payload.answer, "string");
    assert.equal(payload.answer.length > 0, true);
    assert.equal(/\bEHI\b/.test(payload.answer), false);
    assert.equal(/you should destock/i.test(payload.answer), false);
    assert.equal(payload.answer.includes("No insight available"), false);
  } finally {
    globalThis.fetch = previous;
  }
});

await check("analyze rate limit and body cap trip before the model", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  let calls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"narrative":"ok","processes":{}}' }] }), {
      status: 200,
    });
  };
  try {
    const ip = "203.0.113.12";
    for (let i = 0; i < LIMITS.analyze.rateLimit; i += 1) {
      const res = await eiaAnalyze(jsonRequest("https://hm-eia.netlify.app/.netlify/functions/eia-analyze", {
        ip,
        body: { mode: "overview", navigation_context: { label: "RBH" } },
      }));
      assert.equal(res.status, 200);
    }
    const blocked = await eiaAnalyze(jsonRequest("https://hm-eia.netlify.app/.netlify/functions/eia-analyze", {
      ip,
      body: { mode: "overview" },
    }));
    assert.equal(blocked.status, 429);
    const huge = await eiaAnalyze(jsonRequest("https://hm-eia.netlify.app/.netlify/functions/eia-analyze", {
      ip: "203.0.113.13",
      body: "x".repeat(LIMITS.analyze.maxBodyBytes + 1),
    }));
    assert.equal(huge.status, 413);
    assert.equal(calls, LIMITS.analyze.rateLimit);
  } finally {
    globalThis.fetch = previous;
  }
});

console.log(`\n${passed} checks passed`);

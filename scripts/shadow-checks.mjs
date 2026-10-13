/**
 * Shadow-provider checks. No network. Providers are stubbed.
 *
 *   node scripts/shadow-checks.mjs
 */

import assert from "node:assert/strict";
import eiaAnalyze from "../netlify/functions/eia-analyze.js";
import chat from "../netlify/functions/chat.js";
import eiaCompare from "../netlify/functions/eia-compare.js";
import { EIA_SYSTEM, PROMPT_VERSION } from "../netlify/functions/_shared/eia-prompt.js";
import { DEFAULT_SHADOW_MODEL } from "../netlify/functions/_shared/llm.js";
import { memoryCompareStore, setCompareStoreForTests } from "../netlify/functions/_shared/compare-store.js";

const store = memoryCompareStore();
setCompareStoreForTests(store);

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.COMPARE_ADMIN_TOKEN = "compare-secret";

let passed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`PASS  ${name}`);
    });
}

function request(body, ip) {
  return new Request("https://hm-eia.netlify.app/.netlify/functions/eia-analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nf-client-connection-ip": ip,
    },
    body: JSON.stringify(body),
  });
}

const bundle = {
  mode: "overview",
  navigation_context: { label: "RBH Stretton", kind: "property" },
  surveys: [{ _apikey: "survey-1", name: "North 20240301", _date: "2024-03-01" }],
  answers_by_survey: { "survey-1": [{ question: "Bare ground", answer: "30%" }] },
};

function reading(narrative) {
  return {
    narrative,
    processes: {
      water_cycle: {
        observations: [{
          text: "Bare ground was recorded.",
          citation: { survey_id: "survey-1", date: "2024-03-01" },
          confidence: "medium",
          falsifier: "Cover after rain would overturn this.",
        }],
        questions: [{ text: "Where does water sit after rain?", confidence: "low", falsifier: "A dry surface would change the question." }],
        divergence: [],
        gaps: [],
      },
      mineral_cycle: { observations: [], questions: [], divergence: [], gaps: [] },
      energy_flow: { observations: [], questions: [], divergence: [], gaps: [] },
      community_dynamics: { observations: [], questions: [], divergence: [], gaps: [] },
    },
  };
}

function anthropicResponse(payload, usage = { input_tokens: 11, output_tokens: 7 }) {
  return new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(payload) }],
    usage,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function openAIResponse(payload) {
  return new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
    usage: { prompt_tokens: 20, completion_tokens: 9 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function jobsFor() {
  const jobs = [];
  return { jobs, context: { waitUntil(job) { jobs.push(job); } } };
}

async function settle(bucket) {
  await Promise.all(bucket.jobs);
}

await check("shadow off makes no second call and writes no comparison", async () => {
  process.env.SHADOW_ENABLED = "false";
  delete process.env.SHADOW_PROVIDER_BASE_URL;
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return anthropicResponse(reading("A question, not a verdict."));
  };
  const bucket = jobsFor();
  try {
    const res = await eiaAnalyze(request(bundle, "198.51.100.1"), bucket.context);
    assert.equal(res.status, 200);
    await settle(bucket);
    assert.deepEqual(calls, ["https://api.anthropic.com/v1/messages"]);
    assert.equal((await store.list({ prefix: "runs/" })).blobs.length, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

await check("shadow on returns the primary unchanged and stores both sanitised outputs", async () => {
  process.env.SHADOW_ENABLED = "false";
  const previous = globalThis.fetch;
  globalThis.fetch = async () => anthropicResponse(reading("Primary reading."));
  let primaryBody;
  try {
    const alone = await eiaAnalyze(request(bundle, "198.51.100.2"));
    primaryBody = await alone.json();
  } finally {
    globalThis.fetch = previous;
  }

  process.env.SHADOW_ENABLED = "true";
  process.env.SHADOW_PROVIDER_BASE_URL = "https://openrouter.ai/api/v1";
  delete process.env.SHADOW_MODEL;
  process.env.SHADOW_API_KEY = "shadow-key";
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const sent = JSON.parse(opts.body);
    calls.push({ url: String(url), sent, authorization: opts.headers.Authorization || "" });
    if (String(url).includes("anthropic")) return anthropicResponse(reading("Primary reading."));
    return openAIResponse(reading("Shadow reading with an extra question."));
  };
  const bucket = jobsFor();
  try {
    const started = Date.now();
    const res = await eiaAnalyze(request(bundle, "198.51.100.3"), bucket.context);
    assert.ok(Date.now() - started < 1000);
    const body = await res.json();
    assert.deepEqual(body, primaryBody);
    assert.equal(body.prompt_version, PROMPT_VERSION);
    assert.equal("shadow" in body, false);
    await settle(bucket);

    const primaryCall = calls.find((call) => call.url.includes("anthropic"));
    const shadowCall = calls.find((call) => call.url.includes("openrouter"));
    assert.ok(primaryCall);
    assert.ok(shadowCall);
    assert.equal(primaryCall.sent.system, EIA_SYSTEM);
    assert.equal(shadowCall.sent.messages[0].content, EIA_SYSTEM);
    assert.equal(primaryCall.sent.messages[0].content, shadowCall.sent.messages[1].content);
    assert.equal(shadowCall.sent.model, DEFAULT_SHADOW_MODEL);
    assert.equal(shadowCall.authorization, "Bearer shadow-key");

    const listed = await store.list({ prefix: "runs/" });
    assert.equal(listed.blobs.length, 1);
    const record = await store.get(listed.blobs[0].key, { type: "json" });
    assert.equal(record.property, "RBH Stretton");
    assert.equal(record.prompt_version, PROMPT_VERSION);
    assert.equal(record.input_hash.length, 20);
    assert.equal(record.primary.model, "claude-sonnet-4-20250514");
    assert.equal(record.shadow.model, DEFAULT_SHADOW_MODEL);
    assert.equal(record.primary.sanitised.narrative, primaryBody.narrative);
    assert.match(record.shadow.sanitised.narrative, /Shadow reading/);
    assert.equal(record.primary.usage.input_tokens, 11);
    assert.equal(record.shadow.usage.output_tokens, 9);
    assert.equal(record.primary.checks.schema_valid, true);
    assert.equal(record.primary.checks.valid_citation_percent, 100);
    assert.equal(record.primary.latency_ms >= 0, true);
  } finally {
    globalThis.fetch = previous;
  }
});

await check("a shadow timeout does not delay or change the primary response", async () => {
  process.env.SHADOW_ENABLED = "true";
  process.env.SHADOW_PROVIDER_BASE_URL = "https://openrouter.ai/api/v1";
  process.env.SHADOW_TIMEOUT_MS = "300";
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("anthropic")) return anthropicResponse(reading("Primary reading."));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort);
    });
  };
  const bucket = jobsFor();
  try {
    const started = Date.now();
    const res = await eiaAnalyze(request(bundle, "198.51.100.4"), bucket.context);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 150, `primary waited ${elapsed}ms`);
    const body = await res.json();
    assert.equal(body.narrative, "Primary reading.");
    assert.equal(res.status, 200);
    await settle(bucket);
    const listed = await store.list({ prefix: "runs/" });
    const records = [];
    for (const blob of listed.blobs) records.push(await store.get(blob.key, { type: "json" }));
    const timed = records.find((record) => record.shadow && !record.shadow.ok);
    assert.ok(timed, "expected a stored shadow failure");
    assert.match(timed.shadow.error, /timed out/i);
    assert.equal(timed.primary.sanitised.narrative, "Primary reading.");
  } finally {
    globalThis.fetch = previous;
    delete process.env.SHADOW_TIMEOUT_MS;
  }
});

await check("comparison view requires the admin token, saves marks, and exports csv", async () => {
  const listed = await store.list({ prefix: "runs/" });
  const key = listed.blobs[0].key;
  const denied = await eiaCompare(new Request(`https://hm-eia.netlify.app/.netlify/functions/eia-compare?key=${encodeURIComponent(key)}`));
  assert.equal(denied.status, 401);

  const authed = await eiaCompare(new Request("https://hm-eia.netlify.app/.netlify/functions/eia-compare", {
    headers: { "x-compare-token": "compare-secret" },
  }));
  assert.equal(authed.status, 200);
  const list = await authed.json();
  assert.ok(list.runs.length >= 1);
  assert.equal(list.runs[0].primary_checks.schema_valid, true);

  const saved = await eiaCompare(new Request("https://hm-eia.netlify.app/.netlify/functions/eia-compare", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-compare-token": "compare-secret" },
    body: JSON.stringify({
      key,
      marks: {
        "primary:water_cycle:observations:0": { grounded: true, new: true, useful: false, overreach: false },
      },
    }),
  }));
  assert.equal(saved.status, 200);
  const record = await store.get(key, { type: "json" });
  assert.equal(record.marks["primary:water_cycle:observations:0"].grounded, true);
  assert.equal(record.marks["primary:water_cycle:observations:0"].useful, false);

  const csvRes = await eiaCompare(new Request("https://hm-eia.netlify.app/.netlify/functions/eia-compare?format=csv", {
    headers: { "x-compare-token": "compare-secret" },
  }));
  const csv = await csvRes.text();
  assert.match(csv, /valid_citation_percent/);
  assert.match(csv, /claude-sonnet-4-20250514/);
  assert.match(csv, /Bare ground was recorded/);
  assert.match(csv, /true/);
});

await check("chat shadow off does not call the second provider", async () => {
  process.env.SHADOW_ENABLED = "false";
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "A question first." }] }), { status: 200 });
  };
  try {
    const res = await chat(new Request("https://hm-eia.netlify.app/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-nf-client-connection-ip": "198.51.100.5" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What is the water doing?" }] }),
    }));
    const body = await res.json();
    assert.equal(body.response, "A question first.");
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = previous;
  }
});

console.log(`\n${passed} checks passed`);

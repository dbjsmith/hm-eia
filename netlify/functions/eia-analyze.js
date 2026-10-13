import { preflight, jsonResponse } from "./_shared/cors.js";
import { LIMITS } from "./_shared/limits.js";
import { clientIp, takeToken } from "./_shared/rate-limit.js";
import { ANSWER_SCHEMA, DISCLAIMER, EIA_SYSTEM, PROMPT_VERSION, READING_SCHEMA } from "./_shared/eia-prompt.js";
import { emptyStripTally, sanitiseEiaReturn, stripGradeKeys } from "./_shared/eia-sanitiser.js";
import { callAnthropic, deferBackground, envGet, readLlmConfig, startShadow } from "./_shared/llm.js";
import { getCompareStore } from "./_shared/compare-store.js";
import {
  buildComparisonRecord,
  inputHash,
  readingSchemaValid,
  sideRecord,
  surveyIdsFrom,
} from "./_shared/compare-record.js";

/**
 * EIA Reading.
 * mode "overview" returns the four ecosystem processes as questions.
 * mode "answer" returns { answer } for a steward question, cited and questions-first.
 * No EHI, journey stage, limiting process, or priority lever.
 * GeoDataTrack is never written to from this function.
 */

const PROCESS_KEYS = ["water_cycle", "mineral_cycle", "energy_flow", "community_dynamics"];
const PROCESS_LABELS = {
  water_cycle: "Water cycle",
  mineral_cycle: "Mineral cycle",
  energy_flow: "Energy flow",
  community_dynamics: "Community dynamics",
};

function requestContext(body) {
  const nav = body.navigation_context || {};
  const propertyName = nav.label || body.ground?.property_name || "";
  return {
    constraints: {
      ...(body.constraints || {}),
      no_foreign_property_names: true,
      no_stm_state_as_fact: true,
      return_as: "signals_and_questions",
    },
    consent: {
      ...(body.consent || {}),
      aggregate_ok: false,
    },
    holistic_context: body.holistic_context || { present: false },
    navigation_context: nav,
    ground: {
      ...(body.ground || {}),
      property_name: propertyName,
      // Phase 0 does not treat an index as verified, even if the client sent one.
      ehi_if_present: null,
    },
    catalogue: body.catalogue || { status: "missing" },
  };
}

function evidenceBlock(surveys, answersBySurvey) {
  const list = Array.isArray(surveys) ? surveys.slice(0, 15) : [];
  const lines = [];
  let answerCount = 0;
  for (const survey of list) {
    const id = survey._apikey || survey.apikey || survey.id || "unknown-survey";
    const date = survey._date || survey.date || survey.survey_date || "date-not-recorded";
    const name = survey.name || survey.label || "";
    lines.push(
      `Survey id: ${id} | date: ${date} | name: ${name} | status: ${survey.survey_status || "unspecified"}`,
    );
    const answers = (answersBySurvey && (answersBySurvey[id] || answersBySurvey[survey._apikey])) || [];
    for (const answer of answers) {
      if (answerCount >= 50) break;
      if (answer == null || answer.answer === null || answer.answer === undefined || answer.answer === "") continue;
      lines.push(`  Q: ${answer.question || ""}`);
      lines.push(`  A: ${answer.answer}`);
      answerCount += 1;
    }
  }
  return lines.join("\n") || "No survey answers were provided.";
}

function overviewUser(body) {
  const nav = body.navigation_context || {};
  const propertyName = nav.label || "this property";
  const kind = nav.kind || "property";
  return `## This ground
Name: ${propertyName}
Context: ${kind}
Surveys in this request: ${Array.isArray(body.surveys) ? body.surveys.length : 0}

## Evidence (platform record only — do not invent ids or dates)
${evidenceBlock(body.surveys, body.answers_by_survey)}

## Task
${READING_SCHEMA}`;
}

function answerUser(body) {
  const nav = body.navigation_context || {};
  return `## This ground
Name: ${nav.label || "this property"}
Context: ${nav.kind || "property"}

## Evidence (platform record only — do not invent ids or dates)
${evidenceBlock(body.surveys, body.answers_by_survey)}

## Steward question
${String(body.question || "").slice(0, 4000)}

## Task
${ANSWER_SCHEMA}`;
}

function parseModelJson(rawText) {
  const cleaned = String(rawText || "")
    .replace(/```json\n?/gi, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(cleaned);
}

function asItem(item) {
  if (typeof item === "string") {
    return { text: item, citation: null, confidence: "low", falsifier: "" };
  }
  if (!item || typeof item !== "object") return null;
  const text = item.text || item.observation || item.question || item.ask || "";
  if (!String(text).trim()) return null;
  const citation =
    item.citation && typeof item.citation === "object"
      ? {
          survey_id: item.citation.survey_id || item.citation.surveyId || null,
          date: item.citation.date || null,
        }
      : null;
  const confidence = ["low", "medium", "high"].includes(item.confidence) ? item.confidence : "low";
  return {
    text: String(text),
    citation,
    confidence,
    falsifier: item.falsifier ? String(item.falsifier) : "",
  };
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function normaliseReading(parsed) {
  const processes = {};
  for (const key of PROCESS_KEYS) {
    const src = parsed.processes?.[key] || {};
    processes[key] = {
      observations: listOf(src.observations).map(asItem).filter(Boolean),
      questions: listOf(src.questions).map(asItem).filter(Boolean),
      divergence: listOf(src.divergence || src.divergence_prompts).map(asItem).filter(Boolean),
      gaps: listOf(src.gaps).map(asItem).filter(Boolean),
    };
  }
  return {
    narrative: typeof parsed.narrative === "string" ? parsed.narrative : "",
    processes,
    signals: Array.isArray(parsed.signals) ? parsed.signals : undefined,
    questions_for_steward: parsed.questions_for_steward,
    catalogue: parsed.catalogue,
    hm_checks: parsed.hm_checks,
    uncertainty: parsed.uncertainty,
  };
}

function flatQuestions(processes) {
  const questions = [];
  for (const key of PROCESS_KEYS) {
    for (const item of processes[key].questions) {
      questions.push({
        question: item.text,
        lens_label: PROCESS_LABELS[key],
        farmer_value: item.falsifier ? `What would overturn this: ${item.falsifier}` : "",
      });
    }
  }
  return questions.slice(0, 8);
}

function finaliseOverview(parsed, reqContext, tally = null) {
  const cleaned = sanitiseEiaReturn(reqContext, parsed, tally);
  const reading = normaliseReading(cleaned);
  const again = sanitiseEiaReturn(reqContext, reading);
  stripGradeKeys(again);
  const processes = again.processes;
  return {
    prompt_version: PROMPT_VERSION,
    disclaimer: DISCLAIMER,
    narrative:
      again.narrative ||
      "This is a reading, not a verdict. The questions below are invitations to look.",
    processes,
    questions: flatQuestions(processes),
    uncertainty: again.uncertainty || [],
    hm_checks: again.hm_checks,
    catalogue: again.catalogue,
    never_include: again.never_include,
  };
}

function finaliseAnswer(parsed, reqContext, tally = null) {
  const draft = {
    answer: typeof parsed.answer === "string" ? parsed.answer : "",
    citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    questions_for_steward: parsed.questions_for_steward,
    catalogue: parsed.catalogue,
    hm_checks: parsed.hm_checks,
    signals: parsed.signals,
    narrative: typeof parsed.narrative === "string" ? parsed.narrative : "",
  };
  const cleaned = sanitiseEiaReturn(reqContext, draft, tally);
  stripGradeKeys(cleaned);
  const answer = String(cleaned.answer || cleaned.narrative || "").trim();
  return {
    prompt_version: PROMPT_VERSION,
    disclaimer: DISCLAIMER,
    answer:
      answer ||
      "I do not have a cited reading for that yet. What do you see on this ground that the surveys do not show?",
    citations: Array.isArray(cleaned.citations) ? cleaned.citations : [],
    uncertainty: cleaned.uncertainty || [],
    hm_checks: cleaned.hm_checks,
    never_include: cleaned.never_include,
  };
}

function fallbackOverview() {
  return {
    narrative: "I could not shape a reading just now. The surveys are still the record.",
    processes: {},
  };
}

function fallbackParsed(mode) {
  if (mode === "answer") {
    return {
      answer: "I could not read a cited reply just now. What do you see on the ground that the surveys do not show?",
    };
  }
  return fallbackOverview();
}

function shapeParsed(text, mode) {
  if (!text) return { parsed: fallbackParsed(mode), schemaValid: false };
  try {
    const parsed = parseModelJson(text);
    return { parsed, schemaValid: readingSchemaValid(parsed, mode) };
  } catch {
    return { parsed: fallbackParsed(mode), schemaValid: false };
  }
}

async function storeComparison({
  config,
  shadowPromise,
  mode,
  ctx,
  body,
  user,
  primaryResult,
  primaryParsed,
  primaryPayload,
  primaryTally,
  primarySchemaValid,
}) {
  if (!shadowPromise) return;
  let shadowResult;
  try {
    shadowResult = await shadowPromise;
  } catch (err) {
    console.error("[eia-shadow]", err.message);
    shadowResult = {
      ok: false,
      model: config.shadowModel,
      text: "",
      error: err.message,
      latencyMs: null,
      usage: { input_tokens: null, output_tokens: null },
    };
  }
  const shadowShaped = shadowResult.ok ? shapeParsed(shadowResult.text, mode) : { parsed: null, schemaValid: false };
  const shadowTally = emptyStripTally();
  const shadowPayload = shadowShaped.parsed
    ? mode === "answer"
      ? finaliseAnswer(shadowShaped.parsed, ctx, shadowTally)
      : finaliseOverview(shadowShaped.parsed, ctx, shadowTally)
    : null;
  const property = ctx.navigation_context?.label || ctx.ground?.property_name || "unspecified";
  const surveyIds = surveyIdsFrom(body.surveys);
  const runAt = new Date().toISOString();
  const record = buildComparisonRecord({
    property,
    runAt,
    hash: inputHash(user),
    mode,
    primary: sideRecord({
      result: primaryResult,
      parsed: primaryParsed,
      sanitised: primaryPayload,
      tally: primaryTally,
      surveyIds,
      mode,
      schemaValid: primarySchemaValid && primaryResult.ok,
    }),
    shadow: sideRecord({
      result: shadowResult,
      parsed: shadowShaped.parsed,
      sanitised: shadowPayload,
      tally: shadowTally,
      surveyIds,
      mode,
      schemaValid: shadowShaped.schemaValid && shadowResult.ok,
    }),
  });
  const store = await getCompareStore();
  if (!store) {
    console.error("[eia-shadow] comparison store unavailable");
    return;
  }
  await store.setJSON(record.key, record);
  console.log("[eia-shadow] stored", record.key);
}

export default async (req, context) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method not allowed" }, 405);

  const limit = takeToken("analyze", clientIp(req), LIMITS.analyze.rateLimit, LIMITS.analyze.rateWindowMs);
  if (!limit.ok) {
    return jsonResponse(
      req,
      {
        error: "Rate limit exceeded",
        limit: LIMITS.analyze.rateLimit,
        window_minutes: LIMITS.analyze.rateWindowMs / 60000,
      },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  const raw = await req.text();
  if (raw.length > LIMITS.analyze.maxBodyBytes) {
    return jsonResponse(req, { error: "Request too large", max_bytes: LIMITS.analyze.maxBodyBytes }, 413);
  }

  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse(req, { error: "Invalid JSON" }, 400);
  }

  const mode = body.mode == null || body.mode === "overview" ? "overview" : body.mode === "answer" ? "answer" : null;
  if (!mode) return jsonResponse(req, { error: "Unknown mode" }, 400);
  if (mode === "answer" && !String(body.question || "").trim()) {
    return jsonResponse(req, { error: "Missing question" }, 400);
  }

  const config = readLlmConfig();
  if (!config.anthropicKey) return jsonResponse(req, { error: "ANTHROPIC_API_KEY not set" }, 500);

  const ctx = requestContext(body);
  const user = mode === "answer" ? answerUser(body) : overviewUser(body);
  const messages = [{ role: "user", content: user }];
  const fetchImpl = globalThis.fetch;

  const shadowPromise = startShadow(config, {
    system: EIA_SYSTEM,
    messages,
    maxTokens: LIMITS.analyze.maxTokens,
    fetchImpl,
  });

  let primaryResult;
  try {
    primaryResult = await callAnthropic({
      apiKey: config.anthropicKey,
      model: config.primaryModel,
      system: EIA_SYSTEM,
      messages,
      maxTokens: LIMITS.analyze.maxTokens,
      fetchImpl,
    });
  } catch (err) {
    console.error("[eia-analyze]", err.message);
    primaryResult = {
      ok: false,
      model: config.primaryModel,
      text: "",
      error: err.message,
      latencyMs: null,
      usage: { input_tokens: null, output_tokens: null },
    };
  }

  const shaped = primaryResult.ok ? shapeParsed(primaryResult.text, mode) : { parsed: fallbackParsed(mode), schemaValid: false };
  const tally = emptyStripTally();
  const payload = mode === "answer"
    ? finaliseAnswer(shaped.parsed, ctx, tally)
    : finaliseOverview(shaped.parsed, ctx, tally);
  stripGradeKeys(payload);

  deferBackground(context, () => storeComparison({
    config,
    shadowPromise,
    mode,
    ctx,
    body,
    user,
    primaryResult,
    primaryParsed: shaped.parsed,
    primaryPayload: payload,
    primaryTally: tally,
    primarySchemaValid: shaped.schemaValid,
  }));

  console.log("[eia-analyze]", { mode, prompt_version: PROMPT_VERSION, uncertainty: payload.uncertainty?.length || 0 });
  return jsonResponse(req, payload, 200);
};

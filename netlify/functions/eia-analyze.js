import { preflight, jsonResponse } from "./_shared/cors.js";
import { LIMITS } from "./_shared/limits.js";
import { clientIp, takeToken } from "./_shared/rate-limit.js";
import { ANSWER_SCHEMA, DISCLAIMER, EIA_SYSTEM, PROMPT_VERSION, READING_SCHEMA } from "./_shared/eia-prompt.js";
import { sanitiseEiaReturn, stripGradeKeys } from "./_shared/eia-sanitiser.js";

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

function envGet(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env && typeof Netlify.env.get === "function") {
      const value = Netlify.env.get(name);
      if (value) return value;
    }
  } catch {
    /* local tests have no Netlify global */
  }
  return process.env[name] || "";
}

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

async function callModel({ apiKey, user, maxTokens, fetchImpl }) {
  const resp = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system: EIA_SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const message = data?.error?.message || "Claude API error";
    const error = new Error(message);
    error.status = resp.status;
    throw error;
  }
  return (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
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

function finaliseOverview(parsed, reqContext) {
  const cleaned = sanitiseEiaReturn(reqContext, parsed);
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

function finaliseAnswer(parsed, reqContext) {
  const draft = {
    answer: typeof parsed.answer === "string" ? parsed.answer : "",
    citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    questions_for_steward: parsed.questions_for_steward,
    catalogue: parsed.catalogue,
    hm_checks: parsed.hm_checks,
    signals: parsed.signals,
    narrative: typeof parsed.narrative === "string" ? parsed.narrative : "",
  };
  const cleaned = sanitiseEiaReturn(reqContext, draft);
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

export default async (req) => {
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

  const apiKey = envGet("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonResponse(req, { error: "ANTHROPIC_API_KEY not set" }, 500);

  const ctx = requestContext(body);
  const user = mode === "answer" ? answerUser(body) : overviewUser(body);

  let parsed;
  try {
    const text = await callModel({
      apiKey,
      user,
      maxTokens: LIMITS.analyze.maxTokens,
      fetchImpl: globalThis.fetch,
    });
    parsed = parseModelJson(text);
  } catch (err) {
    console.error("[eia-analyze]", err.message);
    parsed = mode === "answer"
      ? { answer: "I could not read a cited reply just now. What do you see on the ground that the surveys do not show?" }
      : fallbackOverview();
  }

  const payload = mode === "answer" ? finaliseAnswer(parsed, ctx) : finaliseOverview(parsed, ctx);
  stripGradeKeys(payload);
  console.log("[eia-analyze]", { mode, prompt_version: PROMPT_VERSION, uncertainty: payload.uncertainty?.length || 0 });
  return jsonResponse(req, payload, 200);
};

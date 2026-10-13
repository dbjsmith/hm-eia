import { preflight, jsonResponse } from "./_shared/cors.js";
import { LIMITS } from "./_shared/limits.js";
import { clientIp, takeToken } from "./_shared/rate-limit.js";
import { DISCLAIMER, EIA_SYSTEM, PROMPT_VERSION } from "./_shared/eia-prompt.js";
import { emptyStripTally, sanitiseFreeText } from "./_shared/eia-sanitiser.js";
import { callAnthropic, deferBackground, readLlmConfig, startShadow } from "./_shared/llm.js";
import { getCompareStore } from "./_shared/compare-store.js";
import { buildComparisonRecord, inputHash, sideRecord } from "./_shared/compare-record.js";

/**
 * Relational chat. Uses the same versioned system prompt as eia-analyze.
 * Does not score, and does not write to GeoDataTrack.
 */

const CHAT_SANITISE_REQ = {
  constraints: { no_foreign_property_names: true, no_stm_state_as_fact: true },
  consent: { aggregate_ok: false },
  holistic_context: { present: false },
  ground: { ehi_if_present: null },
  catalogue: { status: "missing" },
};

function normaliseMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return { error: "messages must be a non-empty array" };
  }
  if (messages.length > LIMITS.chat.maxMessages) {
    return { error: `At most ${LIMITS.chat.maxMessages} messages` };
  }
  const clean = [];
  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      return { error: "Each message needs role user or assistant" };
    }
    if (typeof message.content !== "string") return { error: "Message content must be a string" };
    if (message.content.length > LIMITS.chat.maxMessageChars) {
      return { error: `Each message must be at most ${LIMITS.chat.maxMessageChars} characters` };
    }
    clean.push({ role: message.role, content: message.content });
  }
  return { messages: clean };
}

export default async (req, context) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method not allowed" }, 405);

  const limit = takeToken("chat", clientIp(req), LIMITS.chat.rateLimit, LIMITS.chat.rateWindowMs);
  if (!limit.ok) {
    return jsonResponse(
      req,
      {
        error: "Rate limit exceeded",
        limit: LIMITS.chat.rateLimit,
        window_minutes: LIMITS.chat.rateWindowMs / 60000,
      },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  const raw = await req.text();
  if (raw.length > LIMITS.chat.maxBodyBytes) {
    return jsonResponse(req, { error: "Request too large", max_bytes: LIMITS.chat.maxBodyBytes }, 413);
  }

  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse(req, { error: "Invalid JSON" }, 400);
  }

  const normalised = normaliseMessages(body.messages);
  if (normalised.error) return jsonResponse(req, { error: normalised.error }, 400);

  const config = readLlmConfig();
  if (!config.anthropicKey) return jsonResponse(req, { error: "API key not configured" }, 500);

  const fetchImpl = globalThis.fetch;
  const shadowPromise = startShadow(config, {
    system: EIA_SYSTEM,
    messages: normalised.messages,
    maxTokens: LIMITS.chat.maxTokens,
    fetchImpl,
  });

  let primaryResult;
  try {
    primaryResult = await callAnthropic({
      apiKey: config.anthropicKey,
      model: config.primaryModel,
      system: EIA_SYSTEM,
      messages: normalised.messages,
      maxTokens: LIMITS.chat.maxTokens,
      fetchImpl,
    });
  } catch (err) {
    console.error("[chat]", err.message);
    deferBackground(context, () => storeChatComparison({
      config,
      shadowPromise,
      messages: normalised.messages,
      primaryResult: {
        ok: false,
        model: config.primaryModel,
        text: "",
        error: err.message,
        latencyMs: null,
        usage: { input_tokens: null, output_tokens: null },
      },
      sanitised: null,
      tally: emptyStripTally(),
    }));
    return jsonResponse(req, { error: "Internal error" }, 500);
  }

  if (!primaryResult.ok) {
    deferBackground(context, () => storeChatComparison({
      config,
      shadowPromise,
      messages: normalised.messages,
      primaryResult,
      sanitised: null,
      tally: emptyStripTally(),
    }));
    return jsonResponse(req, { error: primaryResult.error || "Anthropic API error" }, primaryResult.status || 502);
  }

  const tally = emptyStripTally();
  const cleaned = sanitiseFreeText(primaryResult.text, CHAT_SANITISE_REQ, tally);
  const payload = {
    response: cleaned.text,
    prompt_version: PROMPT_VERSION,
    disclaimer: DISCLAIMER,
    uncertainty: cleaned.uncertainty,
  };

  deferBackground(context, () => storeChatComparison({
    config,
    shadowPromise,
    messages: normalised.messages,
    primaryResult,
    sanitised: payload,
    tally,
  }));

  return jsonResponse(req, payload);
};

async function storeChatComparison({ config, shadowPromise, messages, primaryResult, sanitised, tally }) {
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
  const shadowTally = emptyStripTally();
  const shadowCleaned = shadowResult.ok ? sanitiseFreeText(shadowResult.text, CHAT_SANITISE_REQ, shadowTally) : null;
  const shadowPayload = shadowCleaned
    ? { response: shadowCleaned.text, prompt_version: PROMPT_VERSION, uncertainty: shadowCleaned.uncertainty }
    : null;
  const record = buildComparisonRecord({
    property: "chat",
    runAt: new Date().toISOString(),
    hash: inputHash(JSON.stringify(messages)),
    mode: "chat",
    primary: sideRecord({
      result: primaryResult,
      parsed: sanitised,
      sanitised,
      tally,
      surveyIds: new Set(),
      mode: "chat",
      schemaValid: Boolean(sanitised?.response),
    }),
    shadow: sideRecord({
      result: shadowResult,
      parsed: shadowPayload,
      sanitised: shadowPayload,
      tally: shadowTally,
      surveyIds: new Set(),
      mode: "chat",
      schemaValid: Boolean(shadowPayload?.response),
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

export const config = {
  path: "/api/chat",
};

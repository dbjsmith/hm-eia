import { preflight, jsonResponse } from "./_shared/cors.js";
import { LIMITS } from "./_shared/limits.js";
import { clientIp, takeToken } from "./_shared/rate-limit.js";
import { DISCLAIMER, EIA_SYSTEM, PROMPT_VERSION } from "./_shared/eia-prompt.js";
import { sanitiseFreeText } from "./_shared/eia-sanitiser.js";

/**
 * Relational chat. Uses the same versioned system prompt as eia-analyze.
 * Does not score, and does not write to GeoDataTrack.
 */

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

export default async (req) => {
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

  const apiKey = envGet("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonResponse(req, { error: "API key not configured" }, 500);

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: LIMITS.chat.maxTokens,
        system: EIA_SYSTEM,
        messages: normalised.messages,
      }),
    });

    const data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      return jsonResponse(req, { error: data.error?.message || "Anthropic API error" }, anthropicRes.status);
    }

    const text = data.content?.[0]?.text || "";
    const cleaned = sanitiseFreeText(text, {
      constraints: { no_foreign_property_names: true, no_stm_state_as_fact: true },
      consent: { aggregate_ok: false },
      holistic_context: { present: false },
      ground: { ehi_if_present: null },
      catalogue: { status: "missing" },
    });

    return jsonResponse(req, {
      response: cleaned.text,
      prompt_version: PROMPT_VERSION,
      disclaimer: DISCLAIMER,
      uncertainty: cleaned.uncertainty,
    });
  } catch (err) {
    console.error("[chat]", err.message);
    return jsonResponse(req, { error: "Internal error" }, 500);
  }
};

export const config = {
  path: "/api/chat",
};

/**
 * Model providers.
 *
 * Primary is Anthropic. PRIMARY_MODEL overrides the model id
 * (default claude-sonnet-4-20250514).
 *
 * Shadow is any OpenAI-compatible chat completions endpoint
 * (OpenRouter, Together, Groq, Ollama, vLLM). It runs only when
 * SHADOW_ENABLED is true. The suggested default model id is an OpenRouter-style
 * Llama 3.3 70B Instruct. Ollama and others need SHADOW_MODEL set to their own id.
 *
 * SHADOW_TIMEOUT_MS defaults to 25 seconds. The shadow call is aborted then;
 * it never changes the primary HTTP response.
 */

export const DEFAULT_PRIMARY_MODEL = "claude-sonnet-4-20250514";
export const DEFAULT_SHADOW_MODEL = "meta-llama/llama-3.3-70b-instruct";
export const DEFAULT_SHADOW_TIMEOUT_MS = 25000;

export function envGet(name) {
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

function flagOn(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes";
}

export function readLlmConfig() {
  const timeoutRaw = Number(envGet("SHADOW_TIMEOUT_MS"));
  return {
    primaryModel: envGet("PRIMARY_MODEL") || DEFAULT_PRIMARY_MODEL,
    anthropicKey: envGet("ANTHROPIC_API_KEY") || "",
    shadowEnabled: flagOn(envGet("SHADOW_ENABLED")),
    shadowBaseUrl: envGet("SHADOW_PROVIDER_BASE_URL").replace(/\/+$/, ""),
    shadowModel: envGet("SHADOW_MODEL") || DEFAULT_SHADOW_MODEL,
    shadowApiKey: envGet("SHADOW_API_KEY") || "",
    shadowTimeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_SHADOW_TIMEOUT_MS,
  };
}

export function emptyUsage() {
  return { input_tokens: null, output_tokens: null };
}

export function chatCompletionsUrl(base) {
  const trimmed = String(base || "").replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function usageFrom(data, inputKey, outputKey) {
  const usage = data?.usage || {};
  const input = usage[inputKey];
  const output = usage[outputKey];
  return {
    input_tokens: Number.isFinite(input) ? input : null,
    output_tokens: Number.isFinite(output) ? output : null,
  };
}

export async function callAnthropic({ apiKey, model, system, messages, maxTokens, fetchImpl, signal }) {
  const started = Date.now();
  const resp = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  const latencyMs = Date.now() - started;
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      model,
      text: "",
      error: data?.error?.message || "Claude API error",
      latencyMs,
      usage: usageFrom(data, "input_tokens", "output_tokens"),
    };
  }
  const text = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return {
    ok: true,
    status: resp.status,
    model,
    text,
    error: "",
    latencyMs,
    usage: usageFrom(data, "input_tokens", "output_tokens"),
  };
}

export async function callOpenAICompatible({ baseUrl, apiKey, model, system, messages, maxTokens, fetchImpl, signal }) {
  const url = chatCompletionsUrl(baseUrl);
  const started = Date.now();
  if (!url) {
    return {
      ok: false,
      status: 0,
      model,
      text: "",
      error: "SHADOW_PROVIDER_BASE_URL is not set",
      latencyMs: 0,
      usage: emptyUsage(),
    };
  }
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const resp = await fetchImpl(url, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  const data = await resp.json().catch(() => ({}));
  const latencyMs = Date.now() - started;
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      model,
      text: "",
      error: data?.error?.message || `Shadow provider HTTP ${resp.status}`,
      latencyMs,
      usage: usageFrom(data, "prompt_tokens", "completion_tokens"),
    };
  }
  const text = data?.choices?.[0]?.message?.content || "";
  return {
    ok: true,
    status: resp.status,
    model,
    text: typeof text === "string" ? text : JSON.stringify(text),
    error: "",
    latencyMs,
    usage: usageFrom(data, "prompt_tokens", "completion_tokens"),
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`shadow timed out after ${ms}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function startShadow(config, { system, messages, maxTokens, fetchImpl }) {
  if (!config.shadowEnabled) return null;
  const controller = new AbortController();
  const timeoutMs = config.shadowTimeoutMs;
  const guarded = callOpenAICompatible({
    baseUrl: config.shadowBaseUrl,
    apiKey: config.shadowApiKey,
    model: config.shadowModel,
    system,
    messages,
    maxTokens,
    fetchImpl,
    signal: controller.signal,
  }).catch((err) => ({
    ok: false,
    status: 0,
    model: config.shadowModel,
    text: "",
    error: err.name === "AbortError" ? `shadow timed out after ${timeoutMs}ms` : err.message,
    latencyMs: timeoutMs,
    usage: emptyUsage(),
  }));
  return withTimeout(guarded, timeoutMs).catch((err) => {
    controller.abort();
    return {
      ok: false,
      status: 0,
      model: config.shadowModel,
      text: "",
      error: err.message,
      latencyMs: timeoutMs,
      usage: emptyUsage(),
    };
  });
}

export function deferBackground(context, work) {
  const job = Promise.resolve().then(work).catch((err) => {
    console.error("[eia-shadow]", err.message);
  });
  if (context && typeof context.waitUntil === "function") context.waitUntil(job);
  return job;
}

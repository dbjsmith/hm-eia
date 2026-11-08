/**
 * Explicit EOV test policy. Nothing here is a selected model or an approved budget.
 *
 * Every field stays empty unless the operator sets it. There is no default model,
 * no price table, and no tokeniser. Declared token integers are compared later;
 * they are not counted by a provider or a local tokeniser.
 */

function positiveInt(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function readEovPolicy(env = process.env) {
  const model = typeof env.EIA_EOV_MODEL === "string" && env.EIA_EOV_MODEL.trim()
    ? env.EIA_EOV_MODEL.trim()
    : null;
  const currency = typeof env.EIA_EOV_BUDGET_CURRENCY === "string" && /^[A-Z]{3}$/.test(env.EIA_EOV_BUDGET_CURRENCY)
    ? env.EIA_EOV_BUDGET_CURRENCY
    : null;
  const ceilingMinor = positiveInt(env.EIA_EOV_BUDGET_MINOR);
  const maxCallMinor = positiveInt(env.EIA_EOV_MAX_CALL_MINOR);
  const maxInputTokens = positiveInt(env.EIA_EOV_MAX_INPUT_TOKENS);
  const maxOutputTokens = positiveInt(env.EIA_EOV_MAX_OUTPUT_TOKENS);
  const approved = env.EIA_EOV_BUDGET_APPROVED === "true";
  const configured = Boolean(
    approved
    && model
    && currency
    && ceilingMinor
    && maxCallMinor
    && maxInputTokens
    && maxOutputTokens
    && maxCallMinor <= ceilingMinor,
  );
  return {
    approved,
    configured,
    model,
    currency,
    ceilingMinor,
    maxCallMinor,
    maxInputTokens,
    maxOutputTokens,
  };
}

export function policyGap(policy) {
  if (!policy?.approved) return "budget_unapproved";
  if (!policy.model) return "model_unconfigured";
  if (!policy.currency || !policy.ceilingMinor || !policy.maxCallMinor || policy.maxCallMinor > policy.ceilingMinor) {
    return "budget_unconfigured";
  }
  if (!policy.maxInputTokens || !policy.maxOutputTokens) return "token_policy_unapproved";
  return null;
}

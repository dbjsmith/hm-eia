/**
 * Approved 9 Nov 2026 test envelope. These constants describe the cap.
 * They do not select a live model, write env, or call a provider.
 *
 * Prices are the published base rates for claude-sonnet-5-5: $2 / MTok input
 * and $10 / MTok output. Amounts are integer millionths of a US dollar.
 * 12,000 input tokens cost 24,000 micro-USD ($0.024). 2,000 output tokens
 * cost 20,000 micro-USD ($0.020). One call at both ceilings is 44,000
 * micro-USD. Three such calls are 132,000 micro-USD, under the 200,000
 * micro-USD ($0.20) ceiling.
 *
 * Token admission compares declared integers with those ceilings. It does
 * not count tokens and does not treat byte length as a token count.
 */

export const TEST_MODEL_ID = "claude-sonnet-5-5";
export const TEST_MAX_CALLS = 3;
export const TEST_MAX_INPUT_TOKENS = 12000;
export const TEST_MAX_OUTPUT_TOKENS = 2000;
export const TEST_CEILING_MICRO_USD = 200_000;
export const INPUT_MICRO_USD_PER_TOKEN = 2;
export const OUTPUT_MICRO_USD_PER_TOKEN = 10;

export function worstCaseMicroUsd() {
  return TEST_MAX_INPUT_TOKENS * INPUT_MICRO_USD_PER_TOKEN
    + TEST_MAX_OUTPUT_TOKENS * OUTPUT_MICRO_USD_PER_TOKEN;
}

export function admitDeclaredTokens(usage) {
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens) || inputTokens < 1 || outputTokens < 1) {
    return { ok: false, reason: "token_undeclared" };
  }
  if (inputTokens > TEST_MAX_INPUT_TOKENS || outputTokens > TEST_MAX_OUTPUT_TOKENS) {
    return { ok: false, reason: "token_limit_rejected" };
  }
  return {
    ok: true,
    inputTokens,
    outputTokens,
    worstCaseMicroUsd: worstCaseMicroUsd(),
    accounting: "declared_not_counted",
  };
}

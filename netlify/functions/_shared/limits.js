/**
 * Spend and abuse caps for the two Anthropic-backed functions.
 *
 * These are per-function-instance, in-memory limits (see rate-limit.js).
 * They are not a global budget. A monthly spend cap on the Anthropic API
 * key has to be set in the Anthropic console by the key owner (Darren).
 * This repo cannot set that cap.
 *
 * analyze: 8 requests / IP / 10 minutes, body ≤ 180 KiB, max_tokens 1500
 * chat:    20 requests / IP / 10 minutes, body ≤ 48 KiB, max_tokens 800,
 *          at most 20 messages, each ≤ 8000 characters
 */

export const LIMITS = {
  analyze: {
    maxTokens: 1500,
    maxBodyBytes: 180 * 1024,
    rateLimit: 8,
    rateWindowMs: 10 * 60 * 1000,
  },
  chat: {
    maxTokens: 800,
    maxBodyBytes: 48 * 1024,
    maxMessages: 20,
    maxMessageChars: 8000,
    rateLimit: 20,
    rateWindowMs: 10 * 60 * 1000,
  },
};

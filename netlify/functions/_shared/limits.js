/**
 * Burst caps for the two Anthropic-backed functions.
 *
 * Three layers, and none of them replaces the monthly spend cap in the
 * Anthropic console (Darren sets that; this repo cannot):
 *   1. In-memory, per instance, per IP (rate-limit.js). Resets on a cold start.
 *   2. Netlify function rateLimit on the config export, per IP, across instances.
 *   3. A daily site-wide counter in the Blobs store eia-spend (spend-guard.js).
 *
 * analyze: 8 requests / IP / 10 minutes, body ≤ 180 KiB, max_tokens 1500
 * chat:    20 requests / IP / 10 minutes, body ≤ 48 KiB, max_tokens 800,
 *          at most 20 messages, each ≤ 8000 characters
 * daily:   EIA_DAILY_ANALYZE_CAP (default 80), EIA_DAILY_CHAT_CAP (default 200)
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

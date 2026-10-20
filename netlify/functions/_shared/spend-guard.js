/**
 * Site-wide daily ceiling for Anthropic-backed calls.
 *
 * The in-memory limiter in rate-limit.js resets when an instance cold-starts.
 * Netlify's function rateLimit is per IP and at most 180 seconds. This counter
 * lives in the Netlify Blobs store "eia-spend" so a new instance still sees
 * today's total.
 *
 * It can overshoot by a few requests if two instances increment together.
 * It is not a substitute for the monthly spend cap in the Anthropic console.
 * If the store cannot be opened, the call is refused.
 */

import { envGet } from "./llm.js";

const STORE_NAME = "eia-spend";

let testStore;

export function setSpendStoreForTests(store) {
  testStore = store;
}

export function memorySpendStore() {
  const map = new Map();
  return {
    async setJSON(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async get(key, options = {}) {
      if (!map.has(key)) return null;
      const value = map.get(key);
      if (options.type === "json") return value;
      return JSON.stringify(value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

export function dailyCap(channel) {
  const name = channel === "chat" ? "EIA_DAILY_CHAT_CAP" : "EIA_DAILY_ANALYZE_CAP";
  const fallback = channel === "chat" ? 200 : 80;
  const n = Number(envGet(name));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export async function getSpendStore() {
  if (testStore !== undefined) return testStore;
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore({ name: STORE_NAME, consistency: "strong" });
  } catch (err) {
    console.error("[spend-guard]", err.message);
    return null;
  }
}

export async function takeDailyAllowance(channel, now = new Date()) {
  const store = await getSpendStore();
  if (!store) {
    return { ok: false, status: 503, error: "Spend guard is not available" };
  }
  const day = now.toISOString().slice(0, 10);
  const key = `spend/${day}`;
  const current = (await store.get(key, { type: "json" })) || { analyze: 0, chat: 0, day };
  const cap = dailyCap(channel);
  const used = Number(current[channel] || 0);
  if (used >= cap) {
    return { ok: false, status: 429, error: "Daily spend guard reached", cap, used };
  }
  current[channel] = used + 1;
  current.day = day;
  await store.setJSON(key, current);
  return { ok: true, remaining: cap - current[channel], cap };
}

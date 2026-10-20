/**
 * Comparison records live in a site-scoped Netlify Blobs store named
 * "eia-comparisons". Tests inject a memory store and never touch the network.
 * If Blobs is not configured, the write is skipped and logged. The steward
 * response does not depend on it.
 */

const STORE_NAME = "eia-comparisons";

let testStore = null;

export function setCompareStoreForTests(store) {
  testStore = store;
}

export function memoryCompareStore() {
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
    async list({ prefix } = {}) {
      const blobs = [];
      for (const key of map.keys()) {
        if (!prefix || key.startsWith(prefix)) blobs.push({ key, etag: "memory" });
      }
      return { blobs };
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

export async function getCompareStore() {
  if (testStore) return testStore;
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore({ name: STORE_NAME, consistency: "strong" });
  } catch (err) {
    console.error("[compare-store]", err.message);
    return null;
  }
}

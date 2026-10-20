import { timingSafeEqual } from "node:crypto";
import { corsDecision, jsonResponse, preflight } from "./_shared/cors.js";
import { envGet } from "./_shared/llm.js";
import { getCompareStore } from "./_shared/compare-store.js";
import { cleanMarks, comparisonsToCsv, isExpired, propertySlug, summariseRecord } from "./_shared/compare-record.js";

/**
 * Admin comparison API. Refuses every request unless COMPARE_ADMIN_TOKEN
 * is set and presented as x-compare-token or Authorization: Bearer.
 * The token is not read from the query string.
 */

function presentedToken(req) {
  const header = req.headers.get("x-compare-token");
  if (header) return header.trim();
  const auth = req.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

function tokenMatches(given, expected) {
  if (!expected || !given) return false;
  const left = Buffer.from(String(given));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function loadAll(store, now = Date.now()) {
  const listed = await store.list({ prefix: "runs/" });
  const records = [];
  for (const blob of (listed.blobs || []).slice(0, 200)) {
    const record = await store.get(blob.key, { type: "json" });
    if (!record) continue;
    if (isExpired(record, now)) {
      if (typeof store.delete === "function") await store.delete(blob.key);
      continue;
    }
    records.push(record);
  }
  records.sort((a, b) => String(b.run_at).localeCompare(String(a.run_at)));
  return records;
}

async function deleteMatching(store, { key, propertyApikey }) {
  if (key) {
    const existing = await store.get(key, { type: "json" });
    if (!existing) return { deleted: 0, missing: true };
    await store.delete(key);
    return { deleted: 1, missing: false };
  }
  const want = String(propertyApikey || "").trim().toLowerCase();
  const prefix = `runs/${propertySlug(propertyApikey)}/`;
  const listed = await store.list({ prefix: "runs/" });
  let deleted = 0;
  for (const blob of listed.blobs || []) {
    const record = await store.get(blob.key, { type: "json" });
    const apikey = String(record?.property_apikey || "").trim().toLowerCase();
    if (blob.key.startsWith(prefix) || (want && apikey === want)) {
      await store.delete(blob.key);
      deleted += 1;
    }
  }
  return { deleted, missing: false };
}

function csvResponse(req, csv) {
  const decision = corsDecision(req);
  if (!decision.allow) {
    return new Response(JSON.stringify({ error: "Origin not allowed" }), {
      status: 403,
      headers: { "Content-Type": "application/json", Vary: "Origin" },
    });
  }
  const headers = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="eia-comparisons.csv"',
    Vary: "Origin",
  };
  if (decision.reflect) headers["Access-Control-Allow-Origin"] = decision.reflect;
  return new Response(csv, { status: 200, headers });
}

export default async (req) => {
  if (req.method === "OPTIONS") return preflight(req);

  const expected = envGet("COMPARE_ADMIN_TOKEN");
  if (!expected) return jsonResponse(req, { error: "Comparison view is not configured" }, 503);
  if (!tokenMatches(presentedToken(req), expected)) {
    return jsonResponse(req, { error: "Unauthorised" }, 401);
  }

  const store = await getCompareStore();
  if (!store) return jsonResponse(req, { error: "Comparison store unavailable" }, 503);

  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("format") === "csv") {
    return csvResponse(req, comparisonsToCsv(await loadAll(store)));
  }

  if (req.method === "GET") {
    const key = url.searchParams.get("key");
    if (key) {
      const record = await store.get(key, { type: "json" });
      if (!record || isExpired(record)) {
        if (record && typeof store.delete === "function") await store.delete(key);
        return jsonResponse(req, { error: "Not found" }, 404);
      }
      return jsonResponse(req, record, 200);
    }
    const records = await loadAll(store);
    return jsonResponse(req, { runs: records.map(summariseRecord) }, 200);
  }

  if (req.method === "DELETE") {
    const key = url.searchParams.get("key");
    const propertyApikey = url.searchParams.get("property_apikey");
    if (!key && !propertyApikey) return jsonResponse(req, { error: "Missing key or property_apikey" }, 400);
    if (typeof store.delete !== "function") return jsonResponse(req, { error: "Comparison store cannot delete" }, 503);
    const result = await deleteMatching(store, { key, propertyApikey });
    if (result.missing) return jsonResponse(req, { error: "Not found" }, 404);
    return jsonResponse(req, { deleted: result.deleted }, 200);
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(req, { error: "Invalid JSON" }, 400);
    }
    if (!body?.key) return jsonResponse(req, { error: "Missing key" }, 400);
    const existing = await store.get(body.key, { type: "json" });
    if (!existing) return jsonResponse(req, { error: "Not found" }, 404);
    existing.marks = { ...(existing.marks || {}), ...cleanMarks(body.marks) };
    await store.setJSON(existing.key, existing);
    return jsonResponse(req, { key: existing.key, marks: existing.marks }, 200);
  }

  return jsonResponse(req, { error: "Method not allowed" }, 405);
};

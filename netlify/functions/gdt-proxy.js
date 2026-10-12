import { preflight, jsonResponse } from "./_shared/cors.js";
import { buildGdtGetUrl } from "./_shared/gdt-allow.js";

/**
 * Read-only relay to GeoDataTrack.
 * The browser POSTs { path, params, token, base }. This function issues
 * a single GET to an allow-listed https://*.geodatatrack.com /oauth/* URL.
 * It never forwards POST, PUT, PATCH, or DELETE. The access token is not logged.
 */

export default async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { error: "Invalid request body" }, 400);
  }

  const { path, token, base, method } = body || {};
  const params = body && body.params && typeof body.params === "object" ? body.params : {};

  if (method && String(method).toUpperCase() !== "GET") {
    return jsonResponse(req, { error: "Only GET is allowed" }, 400);
  }
  if (!path) return jsonResponse(req, { error: "Missing path" }, 400);
  if (!token) return jsonResponse(req, { error: "Missing token" }, 400);
  if (!base) return jsonResponse(req, { error: "Missing base URL" }, 400);

  const url = buildGdtGetUrl(base, path, params);
  if (!url) {
    return jsonResponse(
      req,
      { error: "Base or path is not allowed. Only HTTPS GeoDataTrack /oauth/ reads are accepted." },
      400,
    );
  }

  console.log(`gdt-proxy GET ${url.host}${url.pathname}`);

  let gdtResp;
  try {
    gdtResp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: String(token).startsWith("Bearer ") ? String(token) : `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (fetchErr) {
    console.error("gdt-proxy fetch error:", fetchErr.message);
    return jsonResponse(req, { error: "Network error reaching GeoDataTrack" }, 502);
  }

  const responseText = await gdtResp.text();
  console.log(`gdt-proxy ← HTTP ${gdtResp.status} (${responseText.length} bytes)`);

  if (!responseText) {
    return jsonResponse(req, { error: `GeoDataTrack returned an empty body (HTTP ${gdtResp.status})` }, 502);
  }

  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    return jsonResponse(
      req,
      { error: `GeoDataTrack returned non-JSON (HTTP ${gdtResp.status})`, status: gdtResp.status },
      502,
    );
  }

  if (!gdtResp.ok) {
    return jsonResponse(
      req,
      {
        error: responseData.message || responseData.error || `GeoDataTrack HTTP ${gdtResp.status}`,
        gdt_status: gdtResp.status,
      },
      gdtResp.status,
    );
  }

  return jsonResponse(req, responseData);
};

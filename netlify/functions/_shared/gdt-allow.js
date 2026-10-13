/**
 * GeoDataTrack read allow-list.
 * HTTPS only. Hosts: app.geodatatrack.com, api.geodatatrack.com,
 * and any other https subdomain of geodatatrack.com.
 * Upstream calls are GET and the path must be /oauth/*.
 * Nothing in this module writes to GeoDataTrack.
 */

const EXACT_HOSTS = new Set(["app.geodatatrack.com", "api.geodatatrack.com"]);

export function isAllowedGdtBase(base) {
  if (typeof base !== "string" || !base.trim()) return false;
  let url;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;

  const host = url.hostname.toLowerCase();
  if (!host || host.includes("%") || host.includes("..")) return false;

  const subdomain = host.endsWith(".geodatatrack.com") && host !== "geodatatrack.com";
  if (!EXACT_HOSTS.has(host) && !subdomain) return false;

  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/api/v1") return false;
  return true;
}

export function isAllowedOauthPath(path) {
  if (typeof path !== "string") return false;
  if (!path.startsWith("/oauth/")) return false;
  if (path.includes("..") || path.includes("\\") || path.includes("//")) return false;
  if (path.includes("?") || path.includes("#") || path.includes("%")) return false;
  return /^\/oauth\/[a-z0-9][a-z0-9_\-/]*$/i.test(path);
}

function hostAllowed(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || host.includes("%") || host.includes("..")) return false;
  if (EXACT_HOSTS.has(host)) return true;
  return host.endsWith(".geodatatrack.com") && host !== "geodatatrack.com";
}

export function buildGdtGetUrl(base, path, params) {
  if (!isAllowedGdtBase(base) || !isAllowedOauthPath(path)) return null;
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const url = new URL(`${basePath}${path}`, baseUrl.origin);
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!hostAllowed(url.hostname)) return null;
  if (url.pathname !== `${basePath}${path}`) return null;
  if (params && typeof params === "object") {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (typeof key !== "string" || !/^[a-z0-9_]+$/i.test(key)) return null;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

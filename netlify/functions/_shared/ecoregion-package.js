/**
 * Read-only ecoregion.net client.
 *
 * Order: API, then the static package file, then the built-in PA0409 fixture.
 * Timeout 8 seconds. This module never writes.
 *
 * The private gdt-geosat PR #1 client was not readable from this environment
 * (GitHub 404). This is a reconstruction of that read path, not a copy of
 * its prompt.
 */

export const ECOREGION_ORIGIN = "https://ecoregion.net";
export const PACKAGE_TIMEOUT_MS = 8000;

const PA0409_FIXTURE = {
  eco_id: "PA0409",
  catalogue: {
    status: "ai_draft_not_vetted",
    use: "scaffold_only",
    scoring_allowed: false,
  },
  indicators: 15,
  note: "Local fixture. Scaffold only. Not a score and not a verdict.",
};

const FIXTURES = {
  PA0409: PA0409_FIXTURE,
};

function ecoIdOk(ecoId) {
  return /^[A-Za-z0-9_-]{2,32}$/.test(ecoId);
}

async function readJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!resp || resp.status < 200 || resp.status >= 300) return null;
    const pkg = await resp.json();
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return null;
    return pkg;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadEcoregionPackage(ecoId, options = {}) {
  const id = String(ecoId || "").trim();
  if (!ecoIdOk(id)) return { ok: false, source: "none", package: null };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || PACKAGE_TIMEOUT_MS;
  const attempts = [
    { source: "api", url: `${ECOREGION_ORIGIN}/api/ecoregion-package?eco_id=${encodeURIComponent(id)}` },
    { source: "static", url: `${ECOREGION_ORIGIN}/packages/${encodeURIComponent(id)}.json` },
  ];
  for (const attempt of attempts) {
    const pkg = await readJson(fetchImpl, attempt.url, timeoutMs);
    if (pkg) return { ok: true, source: attempt.source, package: pkg };
  }
  if (FIXTURES[id]) return { ok: true, source: "fixture", package: FIXTURES[id] };
  return { ok: false, source: "none", package: null };
}

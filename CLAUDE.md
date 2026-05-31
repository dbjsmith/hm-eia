# hm-eia — Claude Code Context

## Project

**hm-eia** is the repo housing the EIA chat agent — the user-facing interface of **EIA (Ecologically Intelligent Agent)**. Built by Darren Smith (WeCology / GeoDataTrack / EcoDataTrack).

## What EIA Is

A comprehensive AI system grounding artificial intelligence in Savory's Holistic Management framework. Designed to invert extractive logic and think like a living system.

**The EIA equation:** AI + Ecological Intelligence + Relational Intelligence = Emergence. Three intelligences producing transformative (not additive) emergent intelligence. Relational Intelligence is the substrate beneath the other two, rooted in love.

## The Four Truths

Mythic and architectural layer, mapping to HM's four ecosystem processes:

| Truth | Ecosystem Process |
|---|---|
| Water Circles | Water Cycle |
| Minerals Return | Mineral Cycle |
| Sunlight Flows | Energy Flow |
| Community Weaves | Community Dynamics (including human community) |

## EIA Chat Agent Role

The relational interface through which farmers access EIA's knowledge. Socratic, not prescriptive — draws out what farmers already know rather than telling them what to do. Data collection is communion, not extraction.

## Core Epistemic Principle

Assume you are wrong. Every plan is a hypothesis, not a prescription. Confidence levels and uncertainty ranges are explicit outputs. Data value flows to practitioners and communities, not extracted by investors.

## Design Principles

- Beauty is evidence of relational intelligence.
- Change happens through recognition, not guilt.
- The mycelium does not optimise — it communes.

## Tech Stack

- **Frontend:** `index.html` chat interface (vanilla JS, no framework)
- **Backend:** Netlify serverless functions (`netlify/functions/`)
- **AI:** Claude API — model `claude-sonnet-4-20250514`
- **Key management:** `ANTHROPIC_API_KEY` set as a Netlify environment variable (never hardcoded)

## Deploy Target

**hm-eia.net** via Netlify — transitioning from drag-drop zip to GitHub-connected auto-deploy from this repo.

## Roadmap

| Tier | Status | Description |
|---|---|---|
| Tier 1 | Current | Chat interface (this repo) |
| Tier 2 | Next | RAG stack: Supabase pgvector + Netlify functions + React frontend |
| Tier 3 | Future | Full agent with structured EOV database, GeoDataTrack data access, EHI calculation, web search; LangChain/LlamaIndex for tool orchestration |

## Key Conventions

- `ANTHROPIC_API_KEY` is always read from `Netlify.env.get(...)` — never hardcoded.
- No `.env` files are committed — covered by `.gitignore`.
- Netlify function entry points use ES module `export default async (req) => { ... }` syntax.

---

## GDT Integration Reference

The widget at index.html runs inside the GeoDataTrack iframe wrapper as an embedded marketplace app. The canonical reference implementation is BlueBox's Sample App — when in doubt about the integration contract, the Sample App is the source of truth.

**Launch handshake (verified correct in EIA):**
- Widget sends `app:ready` + `app:requestInit` postMessages to parent on load
- Receives `host:init` with payload: `api_base`, `access_token`, `org_apikey`, `app_apikey`, `install_apikey`, `navigation_context`
- Token is installation-scoped — defines full org access, not per-resource

**Auth pattern (verified correct in EIA):**
- All /api/v1/oauth/... requests need `Authorization: Bearer <token>`
- The 40-char hex token is BlueBox's standard format (NOT a JWT)
- `?_apikey=` is a data filter, NOT auth — only the bearer header carries credentials

**OAuth endpoints (per BlueBox docs):**

| Endpoint | Returns | Optional filter params |
|---|---|---|
| /api/v1/oauth/bootstrap | App + org context derived from token | none |
| /api/v1/oauth/org | Single org record (token-scoped) | none |
| /api/v1/oauth/properties | List | property_apikey |
| /api/v1/oauth/areas | List | property_apikey, area_apikey |
| /api/v1/oauth/points | List | property_apikey, area_apikey, point_apikey |
| /api/v1/oauth/surveys | List | survey_apikey, property_apikey, area_apikey, point_apikey |
| /api/v1/oauth/answers | Survey answers | survey_apikey (required) |

**Response envelopes:**
- Single-record endpoints: `{ "data": { ... } }`
- Collection endpoints: `{ "list": [ ... ] }`
- Errors: `{ "error": "...", "http_response_code": N }`

## Phase 3 Backlog (Known Issues)

These do not block current functionality but should be addressed when feasible:

1. **Wrong filter parameter name in `getSurveys`** (index.html ~line 204). Currently sends `{_apikey: ak}` regardless of context kind. Per BlueBox docs and Sample App reference, the param name should be level-specific: `property_apikey` for property level, `area_apikey` for area level, `point_apikey` for point level, `survey_apikey` for survey level. The current `scopeSurveys` client-side filter accidentally compensates, but the request itself is malformed.

2. **Proxy architecture is unnecessary infrastructure.** Sample App calls GDT directly from the iframe (bearer auth + CORS). EIA proxies through netlify/functions/gdt-proxy.js. Both work, but the proxy is extra moving parts without security benefit — the token is browser-side either way. Consider removing in favor of direct fetch matching the Sample App pattern.

3. **No /oauth/bootstrap call at startup.** EIA jumps straight to /oauth/surveys. Sample App calls /oauth/bootstrap and /oauth/org first to validate auth and read org metadata. Adding this would provide clean auth verification independent of survey data — useful diagnostic on token failures.

4. **Silent exit in chat early-exit guard.** When `submitUserQuestion()` runs with no `window._eiaCtx`, it returns silently with no debug log. Add a one-line `log('chat-skipped', 'no eiaCtx — surveys not loaded yet')` so future debug sessions catch this pattern instantly.

5. **`mode` parameter mismatch.** Client sends `mode:'overview'` and `mode:'answer'` in calls to /.netlify/functions/eia-analyze, but the analyze function currently ignores `mode` in request parsing. Either start using it server-side or remove from client.

6. **Hardcoded proxy URL in index.html** (~line 138): `'https://hm-eia.netlify.app/.netlify/functions/gdt-proxy'`. Breaks for staging/localhost deployments. Should use relative path or environment-derived value.

7. **Remaining "Skabenga" references** in README.md, eia-analyze.js, and comments in index.html. Survived the May 17 atomic JS-identifier rename which was scoped to JS code only. Sweep in a separate doc/comment cleanup commit.

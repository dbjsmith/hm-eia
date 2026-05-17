# hm-eia — Claude Code Context

## Project

**hm-eia** is the repo housing **Skabenga**, the user-facing agent for **EIA (Ecologically Intelligent Agent)**. Built by Darren Smith (WeCology / GeoDataTrack / EcoDataTrack).

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

## Skabenga's Role

The relational interface through which farmers access EIA's knowledge. Socratic, not prescriptive — draws out what farmers already know rather than telling them what to do. Data collection as communion, not extraction.

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

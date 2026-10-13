# hm-eia

WeCology EIA Core + Skabenga App

This is the main site for testing EIA integration.

## Shadow model (compare, do not show)

Stewards always receive the primary Anthropic reply. When shadow mode is on, the same evidence bundle and the same `eia-system-v3` prompt are also sent to an OpenAI-compatible model. That second reply is sanitised with the same rules, stored for comparison, and never returned to the page.

The in-memory rate limit still counts one request. A shadow run does spend a second model's tokens.

### Env vars

Set these in the Netlify UI (or in the shell for `netlify dev`). This repo does not set them.

| Var | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes, for any live reply | Primary provider key |
| `PRIMARY_MODEL` | no | Anthropic model id. Default `claude-sonnet-4-20250514` |
| `SHADOW_ENABLED` | no | `true` to run the second model. Default off |
| `SHADOW_PROVIDER_BASE_URL` | when shadow is on | OpenAI-compatible root, without `/chat/completions` |
| `SHADOW_MODEL` | no | Model id for that provider. Default `meta-llama/llama-3.3-70b-instruct` (Llama 3.3 70B Instruct, OpenRouter-style). Ollama and other hosts use their own ids, so set this |
| `SHADOW_API_KEY` | no | Bearer token when the provider requires one. Ollama on your own machine often needs none |
| `SHADOW_TIMEOUT_MS` | no | Abort the shadow call after this many milliseconds. Default 25000. The primary reply is not held for it |
| `COMPARE_ADMIN_TOKEN` | to open the comparison view | Long random secret. The view stays closed when this is empty |

`ALLOWED_ORIGINS` still restricts browser CORS. A monthly spend cap on the Anthropic key is set in the Anthropic console, not here.

### OpenRouter

```
SHADOW_ENABLED=true
SHADOW_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
SHADOW_MODEL=meta-llama/llama-3.3-70b-instruct
SHADOW_API_KEY=sk-or-...
```

Qwen 2.5 72B Instruct on the same endpoint is `qwen/qwen-2.5-72b-instruct`. Together and Groq use the same shape with their own base URL and model id.

### Self-hosted Ollama

Ollama's OpenAI-compatible API listens on port 11434. Pull a model first (`ollama pull llama3.3:70b`), then:

```
SHADOW_ENABLED=true
SHADOW_PROVIDER_BASE_URL=http://127.0.0.1:11434/v1
SHADOW_MODEL=llama3.3:70b
```

Leave `SHADOW_API_KEY` empty. `127.0.0.1` works with `netlify dev` on the machine running Ollama. A deployed Netlify function cannot reach that address; point `SHADOW_PROVIDER_BASE_URL` at a host the function can call (or keep shadow off in production and use OpenRouter).

vLLM and other OpenAI-compatible servers use the same two variables: the server root, and that server's model id.

### Comparison view

Open `/compare.html` and pass the admin token as `?token=` or type it into the form. The page sends it as `x-compare-token` and removes it from the address bar. Runs are listed with citation percent, grade / prescription / STM-as-fact strip counts, and schema validity. Each item can be marked grounded, new, useful, or overreach. Those marks are saved in the same Blobs store. CSV export is on that page (`?format=csv` on `/.netlify/functions/eia-compare`).

Records live in the Netlify Blobs store `eia-comparisons`, keyed by property, run time, and an input hash.

### Privacy

Shadow mode sends the same client data (survey answers and the steward's question) to a second provider. Pilot consent, including TruQuest's consent for RBH, has to cover that second recipient. A self-hosted Ollama or vLLM process keeps the second copy on hardware you run, and does not add another company's API to the path.

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
| `ANTHROPIC_API_KEY` | yes, for any live reply | Primary provider key. Also set a monthly spend cap in the Anthropic console |
| `EIA_AUTH_SECRET` | yes, before chat or analyze will answer | HMAC secret for short-lived sessions. If this and `EIA_APP_SECRET` are both unset, those endpoints return 503 |
| `EIA_CHAT_PASSPHRASE` | for standalone `/chat.html` | Checked on the server. The page exchanges it for a session at `/api/eia-session` |
| `EIA_APP_SECRET` | only for a server-side caller | Shared bearer for Skabenga or another app. Do not put it in the browser |
| `EIA_SESSION_TTL_SECONDS` | no | Session lifetime. Default 7200 |
| `EIA_DAILY_ANALYZE_CAP` | no | Site-wide analyze calls per UTC day. Default 80. Stored in Blobs `eia-spend` |
| `EIA_DAILY_CHAT_CAP` | no | Site-wide chat calls per UTC day. Default 200 |
| `PRIMARY_MODEL` | no | Anthropic model id. Default `claude-sonnet-4-20250514` |
| `SHADOW_ENABLED` | no | `true` is not enough on its own. Default off |
| `SHADOW_ALLOWED_PROPERTIES` | to shadow a property | Comma-separated GeoDataTrack property apikeys. Empty by default, so nothing is shadowed |
| `SHADOW_CONSENT_REF` | to shadow a property | Words that name the consent, for example `TruQuest letter 20/10/2026`. Stored on each comparison record |
| `SHADOW_CHAT_ALLOWED` | no | Chat is never shadowed unless this is `true` and the session's property is on the allow-list |
| `SHADOW_PROVIDER_BASE_URL` | when shadow is on | OpenAI-compatible root. `127.0.0.1`, `localhost`, and `::1` are allowed. Any other host must be listed in `SHADOW_PROVIDER_HOSTS` |
| `SHADOW_PROVIDER_HOSTS` | for a non-local provider | Comma-separated hostnames, for example `openrouter.ai` |
| `SHADOW_MODEL` | no | Default `meta-llama/llama-3.3-70b-instruct`. Set this for Ollama (`llama3.3:70b`) |
| `SHADOW_API_KEY` | no | Bearer token when the provider requires one |
| `SHADOW_TIMEOUT_MS` | no | Abort the shadow call after this many milliseconds. Default 25000 |
| `SHADOW_RETENTION_DAYS` | no | How long comparison records are kept. Default 180. Expired records are deleted on read |
| `COMPARE_ADMIN_TOKEN` | to open the comparison view | Long random secret. Send it as `x-compare-token` or `Authorization: Bearer`. A `?token=` query is ignored |

`ALLOWED_ORIGINS` still restricts browser CORS. CORS is not authentication.

### OpenRouter

```
SHADOW_ENABLED=true
SHADOW_ALLOWED_PROPERTIES=<property apikey confirmed by GeoDataTrack>
SHADOW_CONSENT_REF=TruQuest letter dd/mm/2026
SHADOW_PROVIDER_HOSTS=openrouter.ai
SHADOW_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
SHADOW_MODEL=meta-llama/llama-3.3-70b-instruct
SHADOW_API_KEY=sk-or-...
```

OpenRouter can route a request to another company. The consent letter needs to name that. Qwen 2.5 72B Instruct on the same endpoint is `qwen/qwen-2.5-72b-instruct`.

### Self-hosted Ollama

Ollama's OpenAI-compatible API listens on port 11434. Pull a model first (`ollama pull llama3.3:70b`), then:

```
SHADOW_ENABLED=true
SHADOW_ALLOWED_PROPERTIES=<property apikey>
SHADOW_CONSENT_REF=<where the consent is written>
SHADOW_PROVIDER_BASE_URL=http://127.0.0.1:11434/v1
SHADOW_MODEL=llama3.3:70b
```

Leave `SHADOW_API_KEY` empty. `127.0.0.1` works with `netlify dev` on the machine running Ollama. A deployed Netlify function cannot reach that address; point `SHADOW_PROVIDER_BASE_URL` at a host the function can call (or keep shadow off in production and use OpenRouter).

vLLM and other OpenAI-compatible servers use the same two variables: the server root, and that server's model id.

### Comparison view

Open `/compare.html` and type the admin token into the form. The page sends it as `x-compare-token`. Runs are listed with citation percent, grade / prescription / STM-as-fact strip counts, and schema validity. Each item can be marked grounded, new, useful, or overreach. Delete one run from that page, or delete every run for a property with `DELETE ?property_apikey=` on `/.netlify/functions/eia-compare`. CSV export is `?format=csv` on that function.

Records live in the Netlify Blobs store `eia-comparisons`, keyed by property apikey, run time, and an input hash. They expire after `SHADOW_RETENTION_DAYS` (default 180).

### Privacy

Shadow mode sends survey answers and the steward's question to a second provider only when `SHADOW_ENABLED` is true, `SHADOW_CONSENT_REF` is set, the provider host is allow-listed, and the property apikey on the server-verified session is in `SHADOW_ALLOWED_PROPERTIES`. The browser cannot put a property on that list. Chat text is not sent unless `SHADOW_CHAT_ALLOWED=true` as well. A self-hosted Ollama or vLLM process keeps the second copy on hardware you run.

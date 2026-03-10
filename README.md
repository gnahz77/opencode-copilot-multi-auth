# opencode-copilot-cli-auth

Package on npm: https://www.npmjs.com/package/@zhzy0077/opencode-copilot-cli-auth

This fork replaces the older GitHub Copilot chat-auth flow with the newer Copilot CLI-style OAuth flow and makes `opencode` use the live Copilot model metadata for your account.

## How to use

Add the plugin to your `opencode` config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@zhzy0077/opencode-copilot-cli-auth@0.0.15"
  ]
}
```

Then start `opencode` and log in to the `github-copilot` provider. The plugin handles the Copilot CLI-style device flow and will reuse the stored GitHub OAuth token afterward.

For local development before publishing, you can load the file directly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/index.mjs"
  ]
}
```

Important: if the file path contains `opencode-copilot-auth`, current `opencode` builds may skip loading it because of a hardcoded plugin-name filter. Use a path that does not contain that substring.

## What changed in this fork

- Auth flow: uses the Copilot CLI-style OAuth client flow and keeps the GitHub OAuth token directly.
- Entitlement: fetches `/copilot_internal/user` and uses the entitlement-provided Copilot API base URL.
- Token exchange: does not call `/copilot_internal/v2/token`.
- Request profile: uses the newer `copilot-developer-cli` headers instead of the older chat profile.
- Model metadata: fetches the live Copilot `/models` response during auth loading and patches the in-memory `opencode` provider model objects.

## Context window and model limits

The main practical difference from upstream is that this fork patches live per-model limits from Copilot instead of relying only on static `models.dev` metadata.

That means `opencode` can see the Copilot-advertised values for:

- `limit.context`
- `limit.input`
- `limit.output`

As of March 10, 2026, the live GitHub Copilot `/models` response used by this
fork reports larger context windows than the static `github-copilot` catalog on
[`models.dev`](https://models.dev). The table below compares models that are
available through this fork and also have a direct `models.dev` entry.

| Model                   | This Fork | `models.dev` | Difference |
| ----------------------- | --------: | -----------: | ---------: |
| `claude-opus-4.6`       |   200,000 |      128,000 |    +72,000 |
| `claude-sonnet-4.6`     |   200,000 |      128,000 |    +72,000 |
| `gpt-5-mini`            |   264,000 |      128,000 |   +136,000 |
| `gpt-5.1`               |   264,000 |      128,000 |   +136,000 |
| `claude-sonnet-4`       |   216,000 |      128,000 |    +88,000 |
| `claude-sonnet-4.5`     |   200,000 |      128,000 |    +72,000 |
| `claude-opus-4.5`       |   200,000 |      128,000 |    +72,000 |
| `claude-haiku-4.5`      |   144,000 |      128,000 |    +16,000 |
| `gpt-5.2`               |   264,000 |      128,000 |   +136,000 |
| `gpt-4.1`               |   128,000 |       64,000 |    +64,000 |
| `gemini-3-pro-preview`  |   128,000 |      128,000 |          0 |
| `gemini-2.5-pro`        |   128,000 |      128,000 |          0 |

Models omitted from the table do not have a clean one-to-one entry on
`models.dev`, for example `claude-opus-4.6-1m`, `gpt-4o-mini-2024-07-18`, and
`gpt-4.1-2025-04-14`.

Examples observed with this fork:

- `claude-sonnet-4.6`
  - context window: `200000`
  - prompt/input limit: `168000`
  - output limit: `32000`
- `gpt-5.4`
  - context window: `400000`
  - prompt/input limit: `272000`
  - output limit: `128000`

Without this patching, `opencode` may show stale or smaller limits depending on the static model catalog it started from.

## Claude thinking budget behavior

This fork also changes Copilot Claude request behavior:

- when the `thinking` variant is selected, it sends `thinking_budget: 16000`
- when no variant is selected, it omits `thinking_budget` entirely

This differs from upstream `opencode`, which currently sends `thinking_budget: 4000` for the built-in `thinking` variant.

The plugin intentionally does not try to change the `opencode` core UI. So the visible Claude variant list is still controlled by `opencode` itself; this fork changes the request behavior, not the built-in variant picker labels.

## Publishing

```zsh
./script/publish.ts
```

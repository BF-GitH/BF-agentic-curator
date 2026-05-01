# BF Agentic Curator

A SillyTavern extension that runs multiple AI writers in parallel and uses a judge LLM to filter out consensus patterns (slop) and keep only unique elements (signal).

## How It Works

1. **Writer 1** generates via SillyTavern's native connection (your normal setup)
2. **Writers 2 & 3** fire simultaneously via direct API calls using the same prompt
3. A **Judge** receives all outputs, identifies what they share (consensus = predictable LLM patterns), extracts what's unique to only one (signal = surprising, specific, alive), and synthesizes a single response built from signal only

The result replaces the original message. All writer outputs are stored in message metadata for reference.

## Why

LLM roleplay has a consensus problem. Ask three models to continue the same scene and they'll produce eerily similar responses — the same emotional arcs, the same physical gestures, the same safe resolutions. This extension breaks that pattern by treating similarity as a signal to cut, not keep.

## Installation

1. Copy the `bf-agentic-curator` folder to your SillyTavern's `data/default-user/extensions/third-party/` directory
2. Restart SillyTavern
3. Enable the extension in the Extensions panel

## Configuration

Open the **BF Agentic Curator** panel in Extensions settings. Four tabs:

### General
- **Shared API Settings** — Default provider and API key used when a writer/judge doesn't have its own
- **Behavior** — Minimum writers required, timeout, toast notifications

### Writers
- Writer 1 uses your existing SillyTavern connection — no config needed
- **Writer 2 & 3** — Set provider (OpenRouter / Anthropic / OpenAI-compatible), model, API key, temperature, and max tokens
- Each writer can have a different **system prompt** (append to existing or replace entirely) to push diversity

### Judge
- Provider, model, API key, temperature, max tokens for the judge call
- **Custom Judge Prompt** — Fully editable. Leave blank to use the built-in anti-consensus filter. Supports `{response_a}`, `{response_b}`, `{response_c}` placeholders

### Tools
- **Debug log** — Live timestamped log of pipeline activity (writer timings, judge results, errors)
- **Reset All** — Factory reset all settings

## Supported Providers

| Provider | Notes |
|---|---|
| **OpenRouter** | Recommended. Permissive CORS, wide model selection |
| **Anthropic** | Direct API. Uses `anthropic-dangerous-direct-browser-access` header for browser calls |
| **OpenAI-Compatible** | Any endpoint that follows the OpenAI chat completions format |

## Tips

- Use **different models** or **different temperatures** across writers for maximum diversity
- Use **system prompt suffixes** to push each writer in a different direction (e.g., one focused on dialogue, one on action, one on internal monologue)
- The judge works best with a capable model (Claude, GPT-4o, etc.) since it needs to analyze and synthesize
- Set **Min Writers** to 2 if you want the pipeline to still work when one writer fails
- Enable **Debug Mode** in the Tools tab to see exactly what each writer produced and how long it took

## Requirements

- SillyTavern (recent version with `CHAT_COMPLETION_PROMPT_READY` event support)
- API key(s) for your chosen provider(s)
- At least one writer (2 or 3) configured in addition to your native SillyTavern connection

## License

MIT

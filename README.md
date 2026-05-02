# BF Agentic Curator

**Kill the cliche. Keep the strange.**

A SillyTavern extension that runs multiple AI writers in parallel, identifies what they all default to (the consensus — predictable, safe, generic), throws it away, and builds one response from what's left: the surprising, specific, alive parts that only one writer found.

[![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/bf_gith)

---

## The Problem

Ask three LLMs to continue the same roleplay scene. You'll get eerily similar responses — the same emotional arcs, the same "ghost of a smile," the same safe resolutions, the same breath-catching jaw-clenching lip-biting stage directions. That similarity isn't a coincidence. It's the model's path of least resistance. It's slop.

## The Fix

BF Agentic Curator treats that similarity as a signal to **cut**, not keep.

1. **Writer 1** generates via your normal SillyTavern connection
2. **Writers 2 & 3** fire simultaneously via direct API calls — same prompt, different models/settings
3. A **Judge** receives all outputs, identifies shared patterns (dead on arrival), extracts what's unique (the signal), and assembles one response from the surviving material

The result replaces the original message. The whole process is invisible to the reader — they just get a better response.

## Features

- **Dynamic model selection** — pulls directly from SillyTavern's OpenRouter model list, always up to date
- **ST backend proxy** — no API key entry needed, uses your existing SillyTavern keys automatically
- **6 built-in judge presets** — from strict semantic overlap detection to "rescue the strange," plus a hybrid combining the best of all approaches
- **Per-writer chat completion presets** — each writer can use a different ST preset for different generation styles
- **Extension presets** — save/load entire configurations (writer models, judge settings, everything) with one click
- **Live debug log** — full visibility into what each writer produced, what the judge decided, timing, and prompt details
- **Skip button** — abort the judge pipeline mid-run if you don't want to wait
- **Swipe support** — works correctly with SillyTavern's swipe feature

## Installation

1. Copy `bf-agentic-curator` to `data/default-user/extensions/third-party/`
2. Restart SillyTavern
3. Enable in the Extensions panel

## Quick Start

1. Open the **BF Agentic Curator** panel in Extensions
2. Enable the extension
3. Go to the **Writers** tab — enable Writer 2, pick a model (the dropdown shows your ST models)
4. Go to the **Judge** tab — pick a model and choose a judge preset
5. Send a message. The extension handles everything else.

No API key entry needed if you're already connected to OpenRouter in SillyTavern.

## Configuration

### General Tab
- **Extension Presets** — save/load/delete named configurations
- **Shared API Settings** — default provider and API key fallback
- **Behavior** — minimum writers required, pipeline timeout, toast notifications

### Writers Tab
- **Writer 1** uses your existing SillyTavern connection — zero config
- **Writers 2 & 3** — model (from ST's list), provider, optional API key override, temperature, max tokens
- **Chat Completion Preset** per writer — use different ST presets for different generation styles
- **System Prompt Suffix** — append instructions to push each writer in a different direction

### Judge Tab
- Model, provider, temperature, max tokens
- **Judge Prompt Preset** dropdown with 7 options:
  - **Default** — the original anti-consensus filter
  - **Red Pen** — catches the judge's own autopilot tendencies
  - **Scalpel** — bans specific LLM comfort verbs by name (whisper, murmur, trail off...)
  - **Manuscript Editor** — kills tonal consensus, not just content overlap
  - **Semantic Overlap** — strictest pattern matching ("barely a whisper" = "spoke softly")
  - **Rescue the Strange** — includes a self-test: "does this read like AI prose? Then you failed"
  - **Hybrid** — best elements from all five combined
- **Custom** — write your own judge prompt from scratch

### Tools Tab
- **Debug log** — timestamped pipeline activity with expandable full-text details
- **Reset All** — factory reset

## Tips

- Use **different models** across writers for maximum diversity — that's the whole point
- Use **system prompt suffixes** to push each writer in a different direction (dialogue-focused, action-heavy, internal monologue)
- The judge works best with a capable model (Claude Sonnet/Opus, GPT-4o) since it needs to analyze and synthesize
- Try the **Hybrid** judge preset first — it combines the strongest ideas from all five approaches
- Set **Min Writers** to 2 so the pipeline still works if one writer fails
- Enable **Debug Mode** to see exactly what each writer produced and what the judge kept

## Requirements

- SillyTavern (recent version)
- At least one writer (2 or 3) configured with a model
- API keys configured in SillyTavern (the extension uses ST's stored keys automatically)

## Support

Find this useful? Consider supporting development:

[![Ko-fi](https://img.shields.io/badge/Buy_me_a_coffee-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/bf_gith)

## License

MIT

# pi-jev-router

A [TypeSafe Jev](https://docs.typesafe.ai)-powered intent router for the [pi coding agent](https://github.com/badlogic/pi-mono).

**⚠️ READ THIS FIRST — shadow mode is the default.** Out of the box, this extension changes *nothing* about how pi behaves. Every input is routed by Jev in the background and logged, but every turn still goes to your normal model. It looks like it "does nothing" — that is intentional. Read [Recommended rollout](#recommended-rollout) before enabling act mode.

## The problem

In an agentic harness like pi, typing a trivial request such as `ls -la` still costs a full frontier-model turn: the system prompt, the tool definitions, the entire session history, and several seconds of latency — just so the LLM can decide to call the `bash` tool. For a dev workflow, a large fraction of turns are exactly this kind of trivial request.

pi-jev-router puts a fast, structured decision layer **before** the big model: Jev (a "System One" model — no text generation, just calibrated decisions) classifies each input, and only the turns that actually need reasoning reach the big model.

## How it works

Every user input triggers **one parallel Jev call** (~700 input tokens, ~300 ms, ~$0.00003) with five typed questions:

| Question | Type | Returns |
|---|---|---|
| `route` | Choice | `no_llm` / `small_task` / `reasoning` / `clarify` + full probability distribution + confidence |
| `no_judgment` | Noul | probability that a single read-only shell command fully satisfies the request |
| `clarity` | Score | ambiguity of the request |
| `complexity` | Score | how much work it involves |
| `category` | Choice | command / question / code_change / debug / research / chat / other |

Based on the answer, the request is dispatched:

```
Jev answers
│
├─ route=no_llm, confidence ≥ 0.9, noul ≥ 0.7          [strict tier]
│     → small LLM formulates ONE read-only command
│     → validated against a default-deny allowlist
│     → executed locally, output shown, agent loop never starts
│
├─ (no_llm | small_task), confidence ≥ 0.7,            [mid tier]
│  category ∈ {command, question}
│     → small LLM sees the recent conversation + previous local
│       executions, then either:
│       • "!<command>"  → validated + executed locally
│       • a direct answer → displayed + injected into session context
│       • "NONE"        → fall through to the big model
│
└─ everything else (clarify, reasoning, low confidence, rejected commands)
      → pass through to your normal pi model (unchanged behavior)
```

### Judgment vs. policy

A key mental model: **Jev does not dispatch — it judges.** Each question measures a *semantic property of the request itself* (can a single command suffice? how ambiguous? what kind of thing is it?). What turns those judgments into a dispatch decision is **this extension's policy layer**: the gates, the tier structure, and the allowlist.

```
Jev judgment                     →  policy (this code)               →  handler
noul ≥ 0.7, conf ≥ 0.9           →  "commandable with certainty"     →  strict local execution
conf ≥ 0.7, category dispatchable →  "probably commandable"           →  mid tier (small LLM)
everything else                  →  "too risky or too rich"           →  your normal model
```

This separation has three consequences worth knowing:

1. **Changing routing policy never touches Jev.** When we discovered that `category: chat` requests with high `noul` should reach the mid tier, the fix was one line of policy — not a prompt change. A fork with a different pipeline (no small model, for instance) reuses the same Jev judgments with a different dispatch table.
2. **Confidence stays a pure signal about the request.** If Jev classified "local / small / big" directly, its confidence would conflate two things: doubt about the request, and doubt about your infrastructure. Separated, it stays interpretable.
3. **The thresholds are your risk policy.** They live in `config.json` precisely so you can calibrate them against your own logs without touching the judgment layer.

### Design principles

- **Fail-safe, always.** Every failure path (Jev unreachable, small model down, a command that fails validation) falls through to your normal model. The router can only make things *faster or equal*, never worse.
- **Default-deny command validation.** The small model's command is checked against a fixed allowlist of read-only binaries (`ls`, `cat`, `tail`, `grep`, `du`, `git status`, …), with forbidden characters (`; | & > < $ ( )`), forbidden tokens (`rm`, `sudo`, `bash`, `xargs`, …), and dangerous flags (`--exec`, `--delete`, …). Anything suspicious → big model.
- **The local tier is context-blind; the mid tier is not.** Local execution cannot know what was said earlier in the session — that's why confidence below the strict gate goes to the mid tier (context-aware) instead of straight to the big model.
- **OS-portable by fallback, not by enumeration.** Availability of a binary is checked on PATH before execution, the allowlist is platform-aware (`free` is Linux-only, …), and a command that exists but fails on the local system (GNU vs BSD flag differences, missing libraries…) falls through to the big model, which can adapt. No attempt is made to enumerate every OS's quirks — the fail-safe path handles them.
- **This router does not add permission controls.** It only dispatches. On the pass path, your requests go to the model exactly as they would without it. If you want destructive-command gating (confirm before `rm`, `sudo`, …), that is a separate concern at the `tool_call` level — see pi's `confirm-destructive` extension example.
- **Session coherence.** Locally-handled turns are injected back into the session as a compact trace (`[jev-router] executed locally: ls -la …`), so later big-model turns know what already happened — without triggering a turn. Append-only, so prompt caching is unaffected.
- **The big model is never configured here.** It stays whatever pi uses (`/model`). Only the small model is configured in this extension's config.

## Install

Requirements:
- [pi](https://github.com/badlogic/pi-mono) with at least one provider authenticated (the OpenRouter key in `~/.pi/agent/auth.json` is reused for the small model)
- A [TypeSafe API key](https://console.typesafe.ai/keys)

```bash
# 1. Clone / copy this repo
git clone https://github.com/<you>/pi-jev-router.git

# 2. Symlink it into pi's global extensions (or copy it)
ln -s "$(pwd)/pi-jev-router" ~/.pi/agent/extensions/jev-router

# 3. Provide your TypeSafe key (either way works)
export TYPESAFE_API_KEY=...                 # in your shell profile
# or
mkdir -p ~/.pi/agent/jev-router
echo "TYPESAFE_API_KEY=..." > ~/.pi/agent/jev-router/.env

# 4. Create your config (never committed, see .gitignore)
cp ~/.pi/agent/extensions/jev-router/config.example.json ~/.pi/agent/jev-router/config.json

# 5. Restart pi
```

On startup you should see: `jev-router loaded — mode: shadow, small: google/gemini-2.5-flash, key: found`.

## Recommended rollout

Do **not** jump straight to act mode. The economics of this router depend on *your* distribution of trivial vs. non-trivial turns, and only your logs can tell you whether the gates are right for you.

1. **Stay in shadow mode** (the default) and work normally for a session or two. The status bar shows each routing decision; nothing else changes.
2. Run **`/jev:stats`** — route distribution, average confidence, latency percentiles, cumulative Jev cost, and the number of turns that would have been handled locally.
3. If the numbers look right, edit `~/.pi/agent/jev-router/config.json` and set `"mode": "act"`.
4. Watch for `fallback` decisions (a command the small model proposed but validation rejected) — each one is logged with the reason; tighten or extend the allowlist accordingly.

## Configuration

`~/.pi/agent/jev-router/config.json` (all fields optional, defaults in `config.example.json`):

| Field | Default | Meaning |
|---|---|---|
| `mode` | `"shadow"` | `"shadow"`: route + log only, always pass through. `"act"`: actually dispatch |
| `smallModel` | `google/gemini-2.5-flash` | OpenRouter model id used to formulate commands / answer mid-tier questions |
| `disableReasoning` | `true` | send `reasoning: {exclude: true}` — no thinking tokens on a formulation task |
| `confidenceGate` | `0.9` | minimum route confidence for the strict tier |
| `noulGate` | `0.7` | minimum `no_judgment` for the strict tier |
| `smallTaskGate` | `0.7` | minimum confidence for the mid tier |
| `midTier` | `true` | enable the context-aware middle tier |
| `smallModelTimeoutMs` | `10000` | small model request timeout |
| `injectLocalResults` | `true` | inject a trace of locally-handled turns into session context |
| `injectMaxChars` | `500` | max injected characters per trace |

## Commands

- **`/jev:stats`** — aggregate the log: routes, decisions by tier, confidence, latency p50/p95, cumulative Jev cost
- **`/jev:toggle`** — instantly disable/enable routing without leaving pi

## What you should expect

Measured on a real dev session (your numbers will differ — that's why shadow mode exists):

- Jev routing call: ~700 tokens, ~300 ms (p50), ~$0.00003 per call
- Small-model formulation: ~100–200 tokens, ~150 ms
- Strict-eligible turns (trivial commands): handled in < 1 s total, **zero tokens on your big model**
- One benchmark: `git status` routed at confidence 0.99; an anaphoric follow-up ("*et* les fichiers cachés ?") correctly dropped to 0.78 → mid tier

## Privacy

- The routing log (`~/.pi/agent/jev-router/log.jsonl`) contains your raw requests — it stays on your machine and is gitignored
- Your TypeSafe key is read from the environment or `~/.pi/agent/jev-router/.env` — never hardcoded
- The OpenRouter key is reused from pi's own `auth.json` — nothing new to configure

## License

MIT — see [LICENSE](LICENSE).

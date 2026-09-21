# pi-jev-router

A [TypeSafe Jev](https://docs.typesafe.ai)-powered intent router for the [pi coding agent](https://github.com/badlogic/pi-mono).

## The honest premise

Read this first, because the original pitch was wrong. **pi already handles `!command` natively** (output goes to the model) and `!!command` (output not sent). So "typing `ls -la` costs a full frontier-model turn" was never quite the problem: prefix with `!` and it doesn't.

What pi does *not* give you is the bridge between those two worlds:

- You type a **natural-language intention** ("show me the last 10 lines of the log", "and the hidden files?") — `!` requires you to already know the command.
- The router turns that intention into **one validated read-only command**, executed in under a second, with **zero tokens on your frontier model**, and the output lands in your session context for later turns.
- Knowledge questions ("what's the difference between --hard and --soft?") get answered by a cheap small model instead of a full frontier turn.

Everything else — rich coding requests, ambiguity, reasoning — **passes through to your normal model unchanged**. The router can only make things faster or equal, never worse.

**It will rarely fire if** your sessions are conversational and multi-step (measured: 1.6% of turns were locally handleable on a real conversational session). Run it in shadow mode for a real work week and let `/jev-router:stats` decide — see [Reading the stats](#reading-the-stats).

## How it works

Every user input can be handled at four tiers, cheapest first:

```
input
│
├─ L0 (free)          raw text IS a validated read-only command
│                     → validateCommand(raw) → execute. Zero model calls.
│                     (only fires when your text is literally the command;
│                      "git status" → executed, "git status please" → L1)
│
├─ strict tier        Jev: no_llm, conf ≥ 0.9, noul ≥ 0.7
│                     → small LLM formulates ONE command
│                     → strict validation → execute locally
│
├─ mid tier           conf ≥ 0.6, category dispatchable, context-aware
│                     → small LLM: validated command OR direct answer
│                       (answers are injected into the session with an
│                       explicit "unverified" mention, so the big model
│                       has them at the next turn)
├─ small tier (opt-in) small_task + task category, conf ≥ smallTurnGate
│                     → the turn ITSELF runs on the small model via
│                       pi.setModel: a real pi turn with tools (edits,
│                       commands) — model/tools restored afterwards
│
└─ pass               everything else → your normal pi model, unchanged
```

One parallel Jev call (~1000 input tokens, ~300–500 ms, ~$0.00004) carries five typed questions: `route`, `no_judgment` (noul), `clarity`, `complexity`, `category`.

### Judgment vs. policy

**Jev does not dispatch — it judges.** Each question measures a semantic property of the request. What turns judgments into dispatch decisions is the policy layer (`decide()` in `lib.ts`): the gates, the tier structure, the allowlist. Changing policy never touches Jev; confidence stays a pure signal about the request; thresholds are your risk policy, calibratable against your own logs.

## Design principles

- **Fail-safe, always.** Every failure path (Jev unreachable, small model down, validation refused, deadline exceeded) falls through to your normal model. In act mode the whole dispatch races a **latency budget** (`deadlineMs`, default 1200 ms): losing the race means immediate pass-through. Nothing an entry adds before your model starts exceeds the budget.
- **Default-deny command validation — on every tier, including L0.** Fixed allowlist of read-only binaries, git subcommand-restricted, forbidden characters (`; | & > < $ ( )` and newlines), dangerous tokens, dangerous flags. A mid-tier hole where commands skipped validation was caught in testing precisely because the small model's own refusal had been the only guard. Never rely on that.
- **Sensitive paths are denied outright.** `~/.ssh/**`, `~/.pi/agent/auth.json`, `.env*`, `*.env`, `/proc/*/environ`, `*credential*`, `id_rsa`/`id_ed25519`/`id_ecdsa`, `.git-credentials` — no allowlisted binary may point at them. Also blocked: `git -c` (config overrides like `core.fsmonitor=<cmd>` execute arbitrary binaries).
- **Router command outputs never recirculate to Jev or the small model.** Router traces contribute only the prompt quote and the command line to the recent-conversation context — never their output. (Your frontier model does see them via the injected trace, exactly like pi's native `!cmd`.) Without this, a locally-executed `cat` would silently send its output to TypeSafe (and, via the mid tier, to the small-model provider) on the next call.
- **Small-model answers never recirculate to Jev or the small model.** Mid-tier answers are injected into session context with an explicit `[jev-router] answered by small model (UNVERIFIED …)` mention — your frontier model reads them at the next turn — but the recent-conversation context sent to TypeSafe/OpenRouter carries only the label line and the prompt quote, never the answer text itself.
- **Trust gating.** With `requireTrustedProject`, all local execution — and the small-turn tier — is refused in a project explicitly marked untrusted in `~/.pi/agent/trust.json` (fail-open when no saved decision exists, matching pi's own semantics — format read best-effort, marked unverified in docs/plan.md).
- **pi native commands are never intercepted.** Inputs starting with `/`, `!`, `!!` go to pi's own flow untouched.
- **Session coherence.** Locally-handled turns are injected back into the session as a compact trace (including a quote of your prompt), so later big-model turns know what already happened — without triggering a turn. Mid-tier small-model answers are injected the same way, marked UNVERIFIED. Append-only, so prompt caching is unaffected.
- **The small turn is the only tier with tool access — opt-in, bounded, and visible.** `smallTurn: true` lets Jev-dispatched quick tasks (`small_task`, task category, conf ≥ `smallTurnGate`) run as a **real pi turn** on `smallTurnModel`: full session, tools, edits possible (see [The two small models](#the-two-small-models-dont-confuse-them) for how this differs from the mid-tier one-shot model). Unlike router executions, its tool calls go through pi's normal `tool_call` events, so your permission guards see them. Model, thinking level and tools (`smallTurnTools`) are restored on `agent_settled`; if you switch models manually during a small turn, the restore is skipped. Default off because it is the router's only tier where a model can mutate your project.
- **The big model is never configured here.** It stays whatever pi uses (`/model`).
- **OS-portable by fallback, not by enumeration.** Binary availability is checked on PATH at execution time; a command that exists but fails on this system falls through to the big model, which can adapt.

## Security & privacy — what leaves your machine

Worth reading in full, because the router adds providers pi doesn't use. Three data flows, stated precisely:

- **Everything you type goes to TypeSafe (Jev), every turn** — that is the router's function: it cannot classify what it doesn't see. Your input plus up to 6 recent conversation messages (each truncated to ~300 chars), including casual replies like "yes". If you don't want a sentence to reach TypeSafe, don't type it while the router is enabled (`/jev-router:toggle` stops even that).
- **Mid-tier requests go to OpenRouter** (the small model), with that same recent context.
- **Small turns give the small-turn model a full view of the session** — it runs as a real pi turn, so it sees everything your frontier model would (that is the point). Data goes to the provider of `smallTurnModel` through pi's own authenticated providers; the router adds no extra copy.
- **Router outputs go nowhere near Jev or the small model.** Command outputs and mid-tier small-model answers are shown to you and injected into the session (your frontier model sees them, like pi's native `!cmd`) — but the recent-conversation context sent to TypeSafe/OpenRouter carries only the command line (for commands) or the label + prompt quote (for answers), never the content itself.
- **Fragments of your normal model's tool results may reach Jev** via the recent-conversation context (the last 6 session entries, ~300 chars each) — same information your frontier model already sees, but going to an extra provider. This is inherent to context-aware routing; the router-specific hole (its own command outputs recirculating) is the one closed above.
- **Router executions bypass pi's `tool_call` event.** If you run a permission guard (e.g. a confirm-destructive extension), it will NOT see commands executed by this router. The router only dispatches; it adds no permission controls. Its own defense is the default-deny validation above — not a sandbox.
- **The routing log** (`~/.pi/agent/jev-router/log.jsonl`) contains your raw requests and stays on your machine (gitignored).
- Keys: TypeSafe from env/`~/.pi/agent/jev-router/.env`, OpenRouter reused from pi's `auth.json`. Never logged, never committed.

## Install

Requirements: [pi](https://github.com/badlogic/pi-mono) with at least one provider authenticated, and a [TypeSafe API key](https://console.typesafe.ai/keys).

```bash
# Option A: pi package install (package.json carries the pi manifest)
pi install git:toorop/pi-jev-router

# Option B: manual symlink
ln -s "$(pwd)/pi-jev-router/index.ts" ~/.pi/agent/extensions/jev-router/index.ts

# TypeSafe key (either way)
export TYPESAFE_API_KEY=...                 # in your shell profile
# or
mkdir -p ~/.pi/agent/jev-router
echo "TYPESAFE_API_KEY=..." > ~/.pi/agent/jev-router/.env

cp config.example.json ~/.pi/agent/jev-router/config.json
```

On startup you should see:

```
jev-router loaded — mode: shadow, small: google/gemini-2.5-flash, smallturn: google/gemini-2.5-flash, key: found
```

Tests: `npm test` (Node ≥ 22.6, no dependencies).

## The two small models (don't confuse them)

The config has **two distinct small models with two very different roles**. They can be the same model id — that's a coincidence of defaults, not the same mechanism:

| | `smallModel` (mid tier) | `smallTurnModel` (small tier, opt-in) |
|---|---|---|
| **Role** | One-shot *exécutant*: formulates ONE read-only command, or answers one question | *Turn carrier*: does the task — a real pi turn |
| **Called how** | Direct HTTP to OpenRouter, outside the session | `pi.setModel()` — pi runs the turn natively |
| **Sees** | Your request + last ~6 messages (~300 chars each) | The full session, like your frontier model would |
| **Tools** | None. Its only possible outputs: a command (validated before execution) or a short answer | Whatever tools are active (`smallTurnTools` can restrict them) — including edits |
| **In session context** | Answer injected, marked `UNVERIFIED` | Its whole turn, natively — nothing to inject |
| **Afterwards** | Nothing to clean up | Model, thinking level and tools restored automatically |
| **Default** | On (part of `midTier`) | Off (`smallTurn: false`) — the only tier where a model can mutate your project |

Startup line cheat-sheet: `mode:` is shadow/act; `small:` is the mid-tier one-shot model; `smallturn:` is the small-turn carrier (`off` when disabled); `key:` is the TypeSafe/Jev key.

## Recommended rollout

1. **Stay in shadow mode** (the default) and work normally — the status bar shows each routing decision; nothing else changes. Shadow also *simulates* the L0 free tier in the log (`decision: handled_local, tier: l0, simulated: true`) so you can measure the free-tier opportunity rate before enabling it.
2. Run **`/jev-router:stats`** after a real session.
3. If the local-handleable rate justifies it, set `"mode": "act"` in `~/.pi/agent/jev-router/config.json`.
4. Watch `fallback` decisions — each logs the rejected command; tighten the allowlist only deliberately.

## Configuration

`~/.pi/agent/jev-router/config.json` (all optional, defaults in `config.example.json`):

| Field | Default | Meaning |
|---|---|---|
| `mode` | `"shadow"` | `"shadow"`: route + log only. `"act"`: actually dispatch |
| `smallModel` | `google/gemini-2.5-flash` | OpenRouter model id for one-shot formulation/answers (mid tier — never carries a turn) |
| `disableReasoning` | `true` | no thinking tokens on a formulation task |
| `confidenceGate` | `0.9` | min route confidence for the strict tier |
| `noulGate` | `0.7` | min `no_judgment` for the strict tier (and chat→mid) |
| `smallTaskGate` | `0.6` | min confidence for the mid tier |
| `midTier` | `true` | enable the context-aware middle tier |
| `smallTurn` | `false` | opt-in: dispatch quick tasks as a real turn on the small model |
| `smallTurnGate` | `0.7` | min route confidence for the small-turn tier |
| `smallTurnModel` | `google/gemini-2.5-flash` | pi-registry model carrying small turns as real pi turns — a different mechanism from `smallModel` (see [The two small models](#the-two-small-models-dont-confuse-them)) |
| `smallTurnTools` | `null` | `null` keeps your active tools for the small turn; an array restricts them for that turn |
| `deadlineMs` | `1200` | latency budget: Jev + formulation raced against this; on loss → pass-through |
| `jevTimeoutMs` | `3000` | Jev HTTP timeout (background cap after a deadline loss) |
| `smallModelTimeoutMs` | `10000` | small model request timeout |
| `l0` | `true` | free tier: raw text validated and executed with zero model calls |
| `requireTrustedProject` | `true` | refuse all local execution in explicitly untrusted projects |
| `scanToolResults` | `true` | shadow experiment 7A: log-only tool_result size/origin scan |
| `injectLocalResults` | `true` | inject a trace of locally-handled commands and mid-tier answers into session context |
| `injectMaxChars` | `500` | max injected characters for command output and answer traces |

## Commands

- **`/jev-router:stats`** — stats for **today** (local timezone); `/jev-router:stats all` or `/jev-router:stats 2026-09-20` for other periods. Shadow and act are reported **separately** — never mix them.
- **`/jev-router:mode`** — switch `shadow` ↔ `act` (persists to config.json); `/jev-router:mode shadow` or `/jev-router:mode act` to set explicitly. Takes effect on the next input, no restart needed.
- **`/jev-router:toggle`** — instantly disable/enable routing entirely (kill switch, not persisted).

## Reading the stats

Example (real session):

```
jev-router — 2026-09-20 (62 log entries, 0 errors)
[act] 62 routed — local rate 1.6% (1 avoided big-model turns)
  route:    reasoning:27  clarify:24  small_task:8  no_llm:3
  decision: pass:61  handled_local:1
  confidence hist: 0.0:12  0.1:8  0.2:9  ...
  noul hist:       ...
  latency p50/p95: 428/843 ms
  Jev in: 62,341 tokens → est. cost $0.0026
  paid turns after pass: 40 turns · 1.2M in (+210k cache-read) · $3.42 real cost
```

How to read it, honestly:

- **local rate** is the number that decides the project. Under ~15%: keep shadow or uninstall.
- **paid turns after pass** is the real cost of the turns the router let through — compare it against what local handling avoided.
- **confidence/noul histograms** exist for one purpose: place gates in distribution troughs, never on a cluster (see Calibration).
- **latency p50/p95** is added latency on *every* routed input — in act mode bounded by `deadlineMs`.

## Calibration

Current gates (`confidenceGate` 0.9, `noulGate` 0.7, `smallTaskGate` 0.6) were set during development (September 2026) from a small corpus; the measured distributions are too sparse to justify a move. Re-calibrate after a shadow-mode work week: place each gate in a trough of its histogram, never on a cluster — Jev probabilities wobble slightly between identical calls, so a threshold sitting on a frontier is a coin flip. Replay a corpus at least three times before citing a rate. Record threshold + date + justifying measurement in the code comment (`lib.ts`) and here.

Real calibration lessons so far: knowledge-question answers are cheap to correct (mid-tier gate 0.6, not 0.7); `chat` + high noul is a command in disguise; anaphora without context is correctly a `clarify`; phrasing and arithmetic belong to the big model.

## Known UX differences in act mode

- **Your prompt is quoted, not echoed** for locally-handled turns: pi does not record inputs an extension handles, so the injected trace carries your prompt as a quoted line (`> your request`) inside the `[jev-router]` block.
- **Mid-tier answers enter context, marked unverified.** Injected with an explicit UNVERIFIED mention so later big-model turns have the answer (it was requested — it is context) while knowing it is unverified small-model prose. The answer text itself never reaches Jev or the small model again (see above).
- **The footer tells you everything**: `local · l0: git status · 3ms`, `local · strict ← no_llm 0.97: date · 450ms`, `pass → big (deadline 1200ms)`, `fallback → big (…)`.
- **Shadow inputs are never dropped.** An input arriving while a Jev call is in flight is routed and logged anyway (this used to be silently discarded, biasing exactly the short-burst population the router targets).

## What you should expect

Measured, real numbers (2026-09-20, act session): Jev routing ~1000 tokens, p50 428 ms / p95 843 ms, $0.00004/call; locally-handled commands < 1 s total with zero frontier tokens; mid-tier answers 1–3 s on the small model. In act mode, added latency before your normal model starts is bounded by `deadlineMs`.

## License

MIT — see [LICENSE](LICENSE).
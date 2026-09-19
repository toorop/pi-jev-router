# pi-jev-router

A [TypeSafe Jev](https://docs.typesafe.ai)-powered intent router for the [pi coding agent](https://github.com/badlogic/pi-mono).

**⚠️ READ THIS FIRST — shadow mode is the default.** Out of the box, this extension changes *nothing* about how pi behaves. Every input is routed by Jev in the background and logged, but every turn still goes to your normal model. It looks like it "does nothing" — that is intentional. Read [Recommended rollout](#recommended-rollout) before enabling act mode.

## Who this is for — and who it's not for

Be honest with yourself here; the economics only work for some workflows.

**It pays when your inputs are imperative and heterogeneous:**
- You drive pi with short commands ("relance les tests", "git status", "commit ça", "montre le diff")
- You use voice input, which naturally produces short imperative requests
- You run automated flows through pi (CI bots, scripts, pipelines) where volume × per-turn cost matters
- You mix commands and knowledge questions and want both answered in under a second

**It will rarely fire — and is not worth running — if:**
- Your inputs are rich natural-language requests and *the model* does the tooling as part of its reasoning. Commands the big model issues during a turn never pass through this router; it only sees *your* input.
- Your sessions are almost entirely multi-step coding work.

**The rule:** run it in shadow mode for a real work week, then look at `/jev:stats`. If locally-handleable turns are under ~15% of your inputs, keep it in shadow or uninstall it — the fail-safe design guarantees you lose nothing by keeping it, but the numbers should decide. This router earns its keep on *distribution*, and only your logs know your distribution.

Outside the harness, the same Jev pattern (cheap calibrated classification before expensive generation) shines in high-volume automation: issue triage, webhook classification, comment moderation, batch log analysis. That is where per-decision cost actually compounds.

## The problem

In an agentic harness like pi, typing a trivial request such as `ls -la` still costs a full frontier-model turn: the system prompt, the tool definitions, the entire session history, and several seconds of latency — just so the LLM can decide to call the `bash` tool.

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
├─ (no_llm | small_task), confidence ≥ 0.6,            [mid tier]
│  category ∈ {command, question} (or chat with high noul)
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
Jev judgment                      →  policy (this code)                →  handler
noul ≥ 0.7, conf ≥ 0.9            →  "commandable with certainty"      →  strict local execution
conf ≥ 0.6, category dispatchable →  "probably commandable"            →  mid tier (small LLM)
everything else                   →  "too risky or too rich"           →  your normal model
```

This separation has three consequences worth knowing:

1. **Changing routing policy never touches Jev.** When we discovered that `category: chat` requests with high `noul` should reach the mid tier, the fix was one line of policy — not a prompt change. A fork with a different pipeline (no small model, for instance) reuses the same Jev judgments with a different dispatch table.
2. **Confidence stays a pure signal about the request.** If Jev classified "local / small / big" directly, its confidence would conflate two things: doubt about the request, and doubt about your infrastructure. Separated, it stays interpretable.
3. **The thresholds are your risk policy.** They live in `config.json` precisely so you can calibrate them against your own logs without touching the judgment layer.

### Design principles

- **Fail-safe, always.** Every failure path (Jev unreachable, small model down, a command that fails validation) falls through to your normal model. The router can only make things *faster or equal*, never worse.
- **Default-deny command validation — on every tier.** The small model's command is checked against a fixed allowlist of read-only binaries (`ls`, `cat`, `tail`, `grep`, `du`, `git status`, …), with forbidden characters (`; | & > < $ ( )`), forbidden tokens (`rm`, `sudo`, `bash`, `xargs`, …), and dangerous flags (`--exec`, `--delete`, …). This applies to the mid tier too — a hole where mid-tier commands skipped validation was caught in testing precisely because the *small model's own refusal* had been the only guard. Never rely on that.
- **The local tier is context-blind; the mid tier is not.** Local execution cannot know what was said earlier in the session — that's why confidence below the strict gate goes to the mid tier (context-aware) instead of straight to the big model.
- **Session coherence.** Locally-handled turns are injected back into the session as a compact trace (including a quote of your prompt), so later big-model turns know what already happened — without triggering a turn. Append-only, so prompt caching is unaffected.
- **The big model is never configured here.** It stays whatever pi uses (`/model`). Only the small model is configured in this extension's config.
- **OS-portable by fallback, not by enumeration.** Availability of a binary is checked on PATH before execution, the allowlist is platform-aware (`free` is Linux-only, …), and a command that exists but fails on the local system (GNU vs BSD flag differences, missing libraries…) falls through to the big model, which can adapt.
- **This router does not add permission controls.** It only dispatches. On the pass path, your requests go to the model exactly as they would without it. If you want destructive-command gating (confirm before `rm`, `sudo`, …), that is a separate concern at the `tool_call` level — see pi's `confirm-destructive` extension example.

## Install

Requirements:
- [pi](https://github.com/badlogic/pi-mono) with at least one provider authenticated (the OpenRouter key in `~/.pi/agent/auth.json` is reused for the small model)
- A [TypeSafe API key](https://console.typesafe.ai/keys)

```bash
# 1. Clone this repo
git clone https://github.com/<you>/pi-jev-router.git

# 2. Symlink it into pi's global extensions (or copy it)
ln -s "$(pwd)/pi-jev-router/index.ts" ~/.pi/agent/extensions/jev-router/index.ts
mkdir -p ~/.pi/agent/extensions/jev-router

# 3. Provide your TypeSafe key (either way works)
export TYPESAFE_API_KEY=...                 # in your shell profile
# or
mkdir -p ~/.pi/agent/jev-router
echo "TYPESAFE_API_KEY=..." > ~/.pi/agent/jev-router/.env

# 4. Create your config (never committed, see .gitignore)
cp config.example.json ~/.pi/agent/jev-router/config.json

# 5. Restart pi
```

On startup you should see: `jev-router loaded — mode: shadow, small: google/gemini-2.5-flash, key: found`.

## Recommended rollout

Do **not** jump straight to act mode. The economics of this router depend on *your* distribution of trivial vs. non-trivial turns, and only your logs can tell you whether the gates are right for you.

1. **Stay in shadow mode** (the default) and work normally for a session or two — ideally a real work week. The status bar shows each routing decision; nothing else changes.
2. Run **`/jev:stats`** — route distribution, decisions by tier, average confidence, latency percentiles, cumulative Jev cost, and the number of turns that would have been handled locally.
3. If the numbers look right, edit `~/.pi/agent/jev-router/config.json` and set `"mode": "act"`.
4. Watch for `fallback` decisions (a command the small model proposed but validation rejected) — each one is logged with the rejected command; tighten or extend the allowlist accordingly.

## Configuration

`~/.pi/agent/jev-router/config.json` (all fields optional, defaults in `config.example.json`):

| Field | Default | Meaning |
|---|---|---|
| `mode` | `"shadow"` | `"shadow"`: route + log only, always pass through. `"act"`: actually dispatch |
| `smallModel` | `google/gemini-2.5-flash` | OpenRouter model id used to formulate commands / answer mid-tier questions |
| `disableReasoning` | `true` | send `reasoning: {exclude: true}` — no thinking tokens on a formulation task |
| `confidenceGate` | `0.9` | minimum route confidence for the strict tier |
| `noulGate` | `0.7` | minimum `no_judgment` for the strict tier |
| `smallTaskGate` | `0.6` | minimum confidence for the mid tier |
| `midTier` | `true` | enable the context-aware middle tier |
| `smallModelTimeoutMs` | `10000` | small model request timeout |
| `injectLocalResults` | `true` | inject a trace of locally-handled turns into session context |
| `injectMaxChars` | `500` | max injected characters for command output traces |

## Commands

- **`/jev:stats`** — aggregate the log: routes, decisions by tier, confidence, latency p50/p95, cumulative Jev cost
- **`/jev:toggle`** — instantly disable/enable routing without leaving pi

## Known UX differences in act mode

- **Your prompt is quoted, not echoed.** pi does not record inputs that an extension handles (handled = agent loop skipped), so the injected trace carries your prompt as a quoted line (`> your request`). It stays visible in the transcript and in the LLM context — but inside the `[jev-router]` block rather than as a native user message. pi offers no way to record a user message without triggering a turn (`sendUserMessage` always triggers one).
- **The footer tells you everything.** Every branch displays its decision in the status bar: `local · strict ← no_llm 0.97: date · 450ms`, `answered · mid ← small_task 0.71 · 2984ms`, `pass → big (clarify 0.92) · 385ms`. The `←` shows the Jev judgment that fed the decision.

## Calibration lessons (real cases from development)

These are the cases that shaped the current gates — useful templates for calibrating yours:

- **Same request, different confidence.** "c'est quoi la différence entre --hard et --soft" scored 0.71, then 0.67, then 0.68 across sessions — right on the original 0.7 gate. Lesson: knowledge-question *answers* are cheap to correct (ask again), unlike wrongly-executed commands — so the mid-tier gate was lowered to 0.6 while command safety stays gated elsewhere.
- **`chat` + high `noul` = a command in disguise.** "dis moi la date" was categorized `chat` with a flat distribution, but `noul` 0.72 said a single command would do. The mid tier now accepts `chat` when `noul` is high.
- **Phrasing and arithmetic belong to the big model.** "donne-moi la date *en la formulant dans une phrase*" and "combien de jours entre aujourd'hui et l'an 2000" scored low `noul` (0.49, 0.5) — a command alone genuinely does not satisfy them. The router passed both, correctly. This matches Jev's documented limits: it does not generate prose, and it does not do math.
- **Anaphora without context is a clarify.** "montre-moi les 10 dernières lignes de *ce fichier*" in a fresh session: Jev detects the missing referent even though it has no conversation context. With context (mid tier sees the traces), the same pattern resolves correctly.
- **A destructive request can fool the router's first line.** "supprime le fichier /tmp/test.txt" scored `no_llm` 0.75. The small model refused on its own (read-only mandate), and the command-validation layer caught it — after the fix described above. Triple defense: Jev's gates, the small model's mandate, the allowlist. Each can fail; none is alone responsible.

## What you should expect

Measured on a real dev session (your numbers will differ — that's why shadow mode exists):

- Jev routing call: ~700 tokens, ~300 ms (p50), ~$0.00003 per call
- Small-model formulation: ~100–200 tokens, ~150 ms
- Strict-eligible turns (trivial commands): handled in < 1 s total, **zero tokens on your big model**
- Mid-tier answers: ~1–3 s, a few hundred tokens on the small model instead of a full frontier turn
- One benchmark: `git status` routed at confidence 0.99; an anaphoric follow-up ("*et* les fichiers cachés ?") correctly dropped to 0.78 → mid tier

## Privacy

- The routing log (`~/.pi/agent/jev-router/log.jsonl`) contains your raw requests — it stays on your machine and is gitignored
- Your TypeSafe key is read from the environment or `~/.pi/agent/jev-router/.env` — never hardcoded
- The OpenRouter key is reused from pi's own `auth.json` — nothing new to configure

## License

MIT — see [LICENSE](LICENSE).

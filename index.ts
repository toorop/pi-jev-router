/**
 * pi-jev-router — TypeSafe Jev intent router for the pi coding agent
 *
 * Every user input is routed by Jev (state + typed questions, one parallel
 * call). Based on the route + confidence, the request is either handled
 * locally (no big-model turn at all) or passed through to pi's normal flow.
 *
 * Tiers (see lib.ts for the pure dispatch logic):
 *   L0 (free): raw text passes validateCommand() → execute directly,
 *     zero model calls. Shadow mode logs this as a simulated opportunity.
 *   strict: no_llm + conf >= confidenceGate + noul >= noulGate
 *     → small LLM formulates ONE read-only command → strict validation →
 *     execute, show output, agent loop never starts
 *   mid: context-aware small LLM formulates a validated command; direct
 *     prose answers are shown to the user with an explicit "unverified"
 *     mention and are NEVER injected into session context.
 *   pass: everything else → normal pi model, unchanged behavior.
 *
 * Latency budget: in act mode Jev + small-model formulation race against
 * `deadlineMs`; losing the race means immediate fail-safe pass-through.
 *
 * Security posture (router-internal, independent of user-installed guards):
 *   - default-deny command validation on every tier, including L0
 *   - sensitive-path denylist (keys, credentials, .env, auth.json, /proc)
 *   - command outputs are NEVER sent back to Jev or the small model
 *   - optional trust.json gating of all local execution
 *   - executions bypass pi's tool_call event: permission guards don't see
 *     them (documented, by design — the router only dispatches)
 *
 * Commands: /jev-router:stats [today|all|YYYY-MM-DD], /jev-router:mode, /jev-router:toggle
 * Key resolution: $TYPESAFE_API_KEY → ~/.pi/agent/jev-router/.env
 * OpenRouter key: reused from pi's ~/.pi/agent/auth.json
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULTS, validateCommand, decide, computeStats, percentile, histLine, localDateKey,
  type RouterConfig, type JevAnswer, type LogEntry,
} from "./lib.ts";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ROUTER_DIR = path.join(os.homedir(), ".pi", "agent", "jev-router");
const LOG_FILE = path.join(ROUTER_DIR, "log.jsonl");
const CONFIG_FILE = path.join(ROUTER_DIR, "config.json");
const TRUST_FILE = path.join(os.homedir(), ".pi", "agent", "trust.json");
const TYPESAFE_ENV_FALLBACKS = [path.join(ROUTER_DIR, ".env")];

// Jev cost model: $42 / 1M input tokens (estimate; Jev usage reports input only).
const JEV_COST_PER_MTOK = 42;

let enabled = true;
let typesafeKey: string | null | undefined;
let openrouterKey: string | null = null;
let routing = false; // act-mode guard against overlapping input events
// Decision waiting for its following turn's real cost (pass/fallback paths).
let pendingTurnCost: { ts: string; mode: string } | null = null;

function loadConfig(): RouterConfig {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function loadTypesafeKey(): string | null {
  if (typesafeKey !== undefined) return typesafeKey;
  typesafeKey = process.env.TYPESAFE_API_KEY || null;
  if (!typesafeKey) {
    for (const envPath of TYPESAFE_ENV_FALLBACKS) {
      try {
        const m = fs.readFileSync(envPath, "utf8").match(/^TYPESAFE_API_KEY=(.+)$/m);
        if (m) {
          typesafeKey = m[1].trim();
          break;
        }
      } catch {
        /* missing file, try next */
      }
    }
  }
  return typesafeKey ?? null;
}

function loadOpenrouterKey(): string | null {
  if (openrouterKey) return openrouterKey;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"));
    openrouterKey = auth?.openrouter?.key ?? null;
  } catch {
    openrouterKey = null;
  }
  return openrouterKey;
}

async function log(entry: Record<string, unknown>) {
  try {
    fs.mkdirSync(ROUTER_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    /* never break pi because of logging */
  }
}

function buildQuestions() {
  return {
    route: {
      type: "choice",
      instructions: "How should a coding agent handle this user request?",
      criteria: {
        no_llm:
          "Fully satisfiable by deterministic code or a single read-only shell command; no judgment needed",
        small_task:
          "One quick self-contained action; needs minimal judgment but not a full agent turn",
        reasoning: "Requires multi-step work, file edits, or real reasoning",
        clarify: "Too ambiguous to act on; the user should be asked to clarify first",
      },
    },
    no_judgment: {
      type: "noul",
      instructions:
        "Executing a single read-only shell command would fully satisfy the request, with no judgment required",
    },
    clarity: {
      type: "score",
      instructions: "How clear and unambiguous the request is",
      criteria: ["Very ambiguous, several interpretations", "Somewhat unclear", "Completely clear"],
    },
    complexity: {
      type: "score",
      instructions: "How much work handling this request involves",
      criteria: ["Trivial, seconds", "Simple, one step", "Multi-step", "Complex, sustained work"],
    },
    category: {
      type: "choice",
      instructions: "What kind of request is this?",
      criteria: {
        command: "Run or inspect something in the shell or filesystem",
        question: "Ask about code or system state",
        code_change: "Modify code or files",
        debug: "Diagnose a problem",
        research: "Look something up broadly",
        chat: "Plain conversation, no actionable task",
        other: "Something else",
      },
    },
  };
}

/** Recent conversation for Jev / the mid-tier small model.
 *
 * Router-injected traces contribute their prompt quote and the command line
 * ONLY — never command output. Otherwise a locally-executed command's output
 * would silently recirculate to TypeSafe (and, via the mid tier, to the
 * small-model provider) on the next call.
 */
function recentMessages(ctx: ExtensionContext, max = 6): Array<{ role: string; text: string }> {
  try {
    const entries = (ctx.sessionManager as any).getBranch() ?? [];
    const out: Array<{ role: string; text: string }> = [];
    for (const e of entries) {
      if ((e as any)?.customType === "jev-router") {
        const redacted = String((e as any)?.content ?? "")
          .split("\n")
          .filter((l) => l.startsWith("[") || l.startsWith(">") || l.startsWith("$ "))
          .join("\n")
          .slice(0, 300);
        if (redacted) out.push({ role: "system", text: redacted });
        continue;
      }
      const m = (e as any)?.message ?? e;
      const role = m?.role;
      const raw = m?.content;
      const text =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw.map((c: any) => c?.text ?? "").join(" ")
            : "";
      if (role && text.trim()) out.push({ role, text: text.trim().slice(0, 300) });
    }
    return out.slice(-max);
  } catch {
    return [];
  }
}

async function askJev(
  text: string,
  streaming: string | undefined,
  ctx: ExtensionContext,
  recent?: Array<{ role: string; text: string }>,
  timeoutMs = 3000,
): Promise<{ answers: JevAnswer; usage?: { input_tokens?: number }; model?: string }> {
  const key = loadTypesafeKey();
  if (!key) throw new Error("no TYPESAFE_API_KEY");

  const state = {
    request: text,
    context: {
      streaming: streaming ?? "idle",
      product: "pi coding agent",
      recent_conversation: recent ?? recentMessages(ctx),
    },
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions: buildQuestions() }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    answers: (data.answers ?? {}) as JevAnswer,
    usage: data.usage,
    model: data.model,
  };
}

/** One-shot small-model call: turn the request into ONE read-only command. */
async function formulateCommand(
  request: string,
  cfg: RouterConfig,
): Promise<string | null> {
  const key = loadOpenrouterKey();
  if (!key) throw new Error("no OpenRouter key (pi auth.json)");

  const body: Record<string, unknown> = {
    model: cfg.smallModel,
    max_tokens: 200,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Translate the user request into ONE single read-only shell command (bash). " +
          "Read-only means: no file writes, no redirections, no pipes, no command substitution, no multi-command chains. " +
          "Output ONLY the command text, nothing else. " +
          "If no single safe read-only command can satisfy the request, output exactly: NONE",
      },
      { role: "user", content: request },
    ],
  };
  if (cfg.disableReasoning) body.reasoning = { exclude: true };

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.smallModelTimeoutMs),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const firstLine = content.split("\n").find((l: string) => l.trim()) ?? "";
  return firstLine.trim().replace(/^`+|`+$/g, ""); // strip code fences
}

/** One-shot small-model call with conversation awareness: either formulate
 *  a command ("!cmd") or answer directly. Returns null on NONE/failure. */
async function formulateOrAnswer(
  request: string,
  cfg: RouterConfig,
  recent: Array<{ role: string; text: string }>,
): Promise<{ kind: "command"; cmd: string } | { kind: "answer"; text: string } | null> {
  const key = loadOpenrouterKey();
  if (!key) throw new Error("no OpenRouter key (pi auth.json)");

  const recentBlock = recent.length
    ? "Recent conversation (most recent last):\n" +
      recent.map((m) => `- [${m.role}] ${m.text}`).join("\n") +
      "\n\n"
    : "";

  const body: Record<string, unknown> = {
    model: cfg.smallModel,
    max_tokens: 400,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You assist a coding agent. Given the recent conversation and the user request, decide: " +
          "EITHER output ONE single read-only shell command (bash) on its own line, prefixed with '! '. " +
          "Read-only means: no writes, no redirections, no pipes, no command substitution, no chains. " +
          "Prefer a command when the request asks to run or inspect something. " +
          "OR answer the question directly and concisely in the user's own language (when no command is the right tool). " +
          "Output exactly NONE if you cannot do either safely or the request is too ambiguous. " +
          "No markdown, no preamble, nothing else.",
      },
      { role: "user", content: recentBlock + "User request: " + request },
    ],
  };
  if (cfg.disableReasoning) body.reasoning = { exclude: true };

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.smallModelTimeoutMs),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const data = await res.json();
  const content: string = (data?.choices?.[0]?.message?.content ?? "").trim();
  if (!content || content === "NONE") return null;
  const firstLine = content.split("\n").find((l: string) => l.trim())?.trim() ?? "";
  if (firstLine.startsWith("!")) {
    const cmd = firstLine.slice(1).trim().replace(/^`+|`+$/g, "");
    return cmd ? { kind: "command", cmd } : null;
  }
  // No '!' prefix: treat as a direct answer (strip code fences if any).
  return { kind: "answer", text: content.replace(/^```[a-z]*\n?|\n?```$/g, "").trim() };
}

function runCommand(
  cmd: string,
): Promise<{ output: string; failed: boolean }> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 5000, maxBuffer: 512 * 1024 }, (err: any, stdout, stderr) => {
      const out = stdout?.toString() ?? "";
      // A non-zero exit is only a failure when the tool itself complained
      // (stderr). grep with no match exits 1 with empty stderr — valid answer.
      const failed = (err && stderr?.toString().trim().length > 0) || false;
      const full =
        out + (stderr?.toString() ? `\n[stderr] ${stderr}` : "") + (err && !failed ? `\n[exit ${err.code ?? "?"}]` : "");
      resolve({ output: full.trim(), failed });
    });
  });
}

/** Race a promise against the latency budget. Resolves "deadline" on loss;
 * the losing promise keeps running in the background (harmless: its result
 * is simply not used). */
function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T | "deadline"> {
  return Promise.race([
    p,
    new Promise<"deadline">((r) => setTimeout(() => r("deadline"), Math.max(1, ms))),
  ]);
}

/**
 * Trust gating (best-effort — format marked unverified in docs/plan.md):
 * pi saves project trust decisions by canonical directory in
 * ~/.pi/agent/trust.json. We read it ourselves and block local execution
 * when the cwd (or an ancestor) has an explicit `false` decision. No saved
 * decision or unreadable file → allow (fail-open, matching pi, which only
 * uses trust to guard resource loading).
 */
function localExecutionBlocked(cwd: string, cfg: RouterConfig): string | null {
  if (!cfg.requireTrustedProject) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(TRUST_FILE, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      let dir = path.resolve(cwd);
      for (;;) {
        const v = (raw as Record<string, unknown>)[dir];
        if (v === false) return "project explicitly untrusted (trust.json)";
        if (v === true) return null;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    /* missing/unreadable trust store → allow */
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const cfg = loadConfig();
    const hasKey = !!loadTypesafeKey();
    ctx.ui.notify(
      `jev-router loaded — mode: ${cfg.mode}, small: ${cfg.smallModel}, key: ${hasKey ? "found" : "MISSING"}`,
      hasKey ? "info" : "warning",
    );
  });

  // Mission step 7A (shadow experiment): log-only scan of tool results —
  // tool name, size, and a crude external-origin heuristic on the tool
  // input. No modification, no detection, no action. Distribution report
  // comes from real sessions, per docs/plan.md.
  pi.on("tool_result", async (event: any) => {
    if (!loadConfig().scanToolResults) return;
    try {
      const chars = (Array.isArray(event.content) ? event.content : [])
        .map((c: any) => (typeof c?.text === "string" ? c.text.length : 0))
        .reduce((a: number, b: number) => a + b, 0);
      const input = JSON.stringify(event.input ?? {});
      const external = /https?:\/\/|curl|wget|\bgh\b|fetch/i.test(input);
      await log({
        type: "tool_result_scan",
        ts: new Date().toISOString(),
        tool: event.toolName,
        chars,
        est_tokens: Math.ceil(chars / 4),
        external,
        external_reason: external ? "network reference in tool input" : undefined,
      });
    } catch {
      /* logging is best-effort */
    }
  });

  // Mission step 0: attach the REAL cost of the turn that follows a pass /
  // fallback decision, so stats can distinguish "turn avoided" from
  // "turn paid". The first assistant usage after the decision is the cost.
  pi.on("turn_end", async (event: any) => {
    if (!pendingTurnCost) return;
    const usage = event?.message?.usage;
    if (!usage) return;
    const tc = pendingTurnCost;
    pendingTurnCost = null;
    await log({
      type: "turn_cost",
      ts: new Date().toISOString(),
      decision_ts: tc.ts,
      mode: tc.mode,
      usage: {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        cost: usage.cost?.total,
      },
    });
  });

  pi.on("input", async (event: any, ctx: ExtensionContext) => {
    if (!enabled) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    if (event.images?.length) return { action: "continue" }; // route on text only
    const text = (event.text ?? "").trim();
    if (!text) return { action: "continue" };
    // Never intercept pi's native surfaces: /commands, !cmd and !!cmd are
    // handled by pi itself (user_bash), not by extensions.
    if (text.startsWith("/") || text.startsWith("!")) return { action: "continue" };

    const cfg = loadConfig();
    const t0 = Date.now();

    // ---- SHADOW: never block the turn, never guard against overlap. ----
    // An input arriving while a Jev call is in flight is exactly the
    // short-turn population we need to measure; silently dropping it biases
    // the data. (Mission step 0.)
    if (cfg.mode === "shadow") {
      const recent = recentMessages(ctx);
      // Free L0 opportunity measurement: would the raw text have passed
      // validation? Zero model calls, simulated only.
      const l0cmd = cfg.l0 ? validateCommand(text) : null;
      askJev(text, event.streamingBehavior, ctx, recent, Math.max(cfg.jevTimeoutMs, cfg.deadlineMs + 500))
        .then(async ({ answers, usage, model }) => {
          await log({
            ts: new Date().toISOString(),
            mode: "shadow",
            decision: l0cmd ? "handled_local" : undefined,
            tier: l0cmd ? "l0" : undefined,
            simulated: !!l0cmd,
            command: l0cmd ?? undefined,
            text: text.slice(0, 500),
            latency_ms: Date.now() - t0,
            input_tokens: usage?.input_tokens,
            model,
            answers,
          });
          const r = answers.route;
          if (ctx.ui && r) {
            ctx.ui.setStatus("jev", `${r.choice} ${(r.confidence ?? 0).toFixed(2)} · ${Date.now() - t0}ms`);
          }
        })
        .catch(async (e: any) => {
          await log({ ts: new Date().toISOString(), mode: "shadow", text: text.slice(0, 500), error: String(e?.message ?? e) });
        });
      return { action: "continue" };
    }

    // ---- ACT MODE: the handler awaits, but pi may still deliver a new
    // input event mid-await (unverified) — keep the overlap guard here. ----
    if (routing) return { action: "continue" };

    try {
      // L0 free tier: the raw text IS a validated read-only command →
      // execute with zero model calls. Anything else fails validation and
      // flows into normal routing.
      if (cfg.l0) {
        const l0cmd = validateCommand(text);
        if (l0cmd) {
          const blocked = localExecutionBlocked(ctx.cwd, cfg);
          if (blocked) {
            await log({ ts: new Date().toISOString(), mode: "act", decision: "pass", reason: blocked, tier: "l0", text: text.slice(0, 500) });
            return { action: "continue" };
          }
          const { output, failed } = await runCommand(l0cmd);
          if (!failed) {
            await log({
              ts: new Date().toISOString(), mode: "act", decision: "handled_local", tier: "l0",
              command: l0cmd, output_bytes: output.length, text: text.slice(0, 500),
              latency_ms: Date.now() - t0,
            });
            injectTrace(cfg, text, `executed locally (l0)\n$ ${l0cmd}`, output);
            if (ctx.ui) {
              ctx.ui.setStatus("jev", `local · l0: ${l0cmd.slice(0, 30)} · ${Date.now() - t0}ms`);
              if (cfg.injectLocalResults && output.length > cfg.injectMaxChars) {
                ctx.ui.notify(`$ ${l0cmd}\n\n${output.slice(0, 2500) || "(no output)"}`, "info");
              }
            }
            return { action: "handled" };
          }
          // exists but failed on this system → let the big model adapt
        }
      }

      routing = true;
      const jevTimeoutMs = Math.max(cfg.jevTimeoutMs, cfg.deadlineMs + 500);
      const routed = await raceDeadline(
        askJev(text, event.streamingBehavior, ctx, recentMessages(ctx), jevTimeoutMs),
        cfg.deadlineMs,
      );
      if (routed === "deadline") {
        await log({
          ts: new Date().toISOString(), mode: "act", decision: "pass", reason: "deadline",
          text: text.slice(0, 500), latency_ms: Date.now() - t0,
        });
        pendingTurnCost = { ts: new Date().toISOString(), mode: "act" };
        if (ctx.ui) ctx.ui.setStatus("jev", `pass → big (deadline ${cfg.deadlineMs}ms)`);
        return { action: "continue" };
      }

      const { answers, usage, model } = routed;
      const latencyJev = Date.now() - t0;
      const route = answers.route;
      const tier = decide(answers, cfg);

      // Locally-handled inputs are NOT recorded by pi (handled = agent loop
      // skipped), so the injected trace also carries the user's prompt to
      // keep the session transcript and LLM context coherent.
      const baseLog = {
        ts: new Date().toISOString(),
        mode: "act",
        text: text.slice(0, 500),
        latency_ms: latencyJev,
        input_tokens: usage?.input_tokens,
        model,
        answers,
      };

      if (tier === "pass") {
        await log({ ...baseLog, decision: "pass" });
        pendingTurnCost = { ts: baseLog.ts, mode: "act" };
        if (ctx.ui && route) {
          ctx.ui.setStatus(
            "jev",
            `pass → big (${route.choice} ${(route.confidence ?? 0).toFixed(2)}) · ${latencyJev}ms`,
          );
        }
        return { action: "continue" };
      }

      // Small-model turn, still inside the latency budget: whatever remains
      // of deadlineMs after the Jev call.
      const remaining = cfg.deadlineMs - (Date.now() - t0);
      const outcome = await raceDeadline(
        (async (): Promise<{ kind: "command"; cmd: string } | { kind: "answer"; text: string } | null> => {
          if (tier === "strict") {
            const raw = await formulateCommand(text, cfg);
            const cmd = raw ? validateCommand(raw) : null;
            return cmd ? { kind: "command", cmd } : null;
          }
          return formulateOrAnswer(text, cfg, recentMessages(ctx));
        })(),
        remaining,
      );
      const latencySmall = Date.now() - t0 - latencyJev;

      if (outcome === "deadline") {
        await log({ ...baseLog, decision: "fallback", tier, reason: "deadline" });
        pendingTurnCost = { ts: baseLog.ts, mode: "act" };
        if (ctx.ui) ctx.ui.setStatus("jev", `fallback → big (deadline) · ${latencyJev + latencySmall}ms`);
        return { action: "continue" };
      }
      if (!outcome) {
        // Fail-safe: anything suspicious or NONE goes to the big model.
        await log({ ...baseLog, decision: "fallback", tier });
        pendingTurnCost = { ts: baseLog.ts, mode: "act" };
        if (ctx.ui)
          ctx.ui.setStatus(
            "jev",
            `fallback → big (${route?.choice ?? "?"} ${(route?.confidence ?? 0).toFixed(2)}) · ${latencyJev + latencySmall}ms`,
          );
        return { action: "continue" };
      }

      if (outcome.kind === "answer") {
        // Middle tier, prose answer. NEVER injected into session context:
        // it is unverifiable small-model prose, and anything injected is
        // later read by the big model as fact. Displayed with an explicit
        // unverified mention instead. (Mission step 3, option B.)
        await log({ ...baseLog, decision: "answered_local", tier: "mid", small_latency_ms: latencySmall });
        if (ctx.ui) {
          ctx.ui.notify(
            `[unverified answer from local small model]\n${outcome.text.slice(0, 2500)}`,
            "info",
          );
          ctx.ui.setStatus(
            "jev",
            `answered · mid (unverified) ← ${route?.choice ?? "?"} · ${latencyJev + latencySmall}ms`,
          );
        }
        return { action: "handled" };
      }

      // SECURITY: mid-tier commands come from a generative model and MUST be
      // validated like strict ones — default-deny allowlist, no exceptions.
      // (This hole was caught in testing: a "delete file" request reached the
      // small model, which refused on its own — never rely on that.)
      const cmd = tier === "strict" ? outcome.cmd : validateCommand(outcome.cmd);
      if (!cmd) {
        await log({ ...baseLog, decision: "fallback", tier: "mid", rejected: outcome.cmd, small_latency_ms: latencySmall });
        if (ctx.ui)
          ctx.ui.setStatus(
            "jev",
            `unsafe command rejected → big (${latencyJev + latencySmall}ms)`,
          );
        return { action: "continue" };
      }
      const blocked = localExecutionBlocked(ctx.cwd, cfg);
      if (blocked) {
        await log({ ...baseLog, decision: "pass", reason: blocked, tier, rejected: cmd, small_latency_ms: latencySmall });
        pendingTurnCost = { ts: baseLog.ts, mode: "act" };
        if (ctx.ui) ctx.ui.setStatus("jev", `blocked (${blocked}) → big`);
        return { action: "continue" };
      }
      const { output, failed } = await runCommand(cmd);
      if (failed) {
        // The command exists but failed on this system (bad flags, missing
        // library…). The big model can adapt; log the failed attempt.
        await log({ ...baseLog, decision: "exec_failed", tier, command: cmd, small_latency_ms: latencySmall });
        pendingTurnCost = { ts: baseLog.ts, mode: "act" };
        if (ctx.ui)
          ctx.ui.setStatus("jev", `exec failed → pass · ${latencyJev + latencySmall}ms`);
        return { action: "continue" };
      }
      await log({
        ...baseLog, decision: "handled_local", tier, command: cmd,
        output_bytes: output.length, small_latency_ms: latencySmall,
      });
      injectTrace(cfg, text, `executed locally (${tier})\n$ ${cmd}`, output);
      if (ctx.ui) {
        ctx.ui.setStatus(
          "jev",
          `local · ${tier} ← ${route?.choice ?? "?"} ${(route?.confidence ?? 0).toFixed(2)}: ${cmd.slice(0, 30)} · ${latencyJev + latencySmall}ms`,
        );
        // Notify only when the trace truncated the output — otherwise the
        // trace is the single display.
        if (cfg.injectLocalResults && output.length > cfg.injectMaxChars) {
          ctx.ui.notify(`$ ${cmd}\n\n${output.slice(0, 2500) || "(no output)"}`, "info");
        }
      }
      return { action: "handled" };
    } catch (e: any) {
      await log({
        ts: new Date().toISOString(),
        mode: cfg.mode,
        text: text.slice(0, 500),
        error: String(e?.message ?? e),
      });
      return { action: "continue" }; // never degrade pi on router failure
    } finally {
      routing = false;
    }

    function injectTrace(cfg: RouterConfig, text: string, label: string, content: string) {
      if (!cfg.injectLocalResults) return;
      const maxChars = cfg.injectMaxChars;
      try {
        pi.sendMessage(
          {
            customType: "jev-router",
            content: `[jev-router] ${label}\n> ${text.slice(0, 200)}\n${content.slice(0, maxChars)}${content.length > maxChars ? "\n…(truncated)" : ""}`,
            display: true,
            details: {},
          },
          { triggerTurn: false },
        );
      } catch {
        /* context injection is best-effort */
      }
    }
  });

  pi.registerCommand("jev-router:toggle", {
    description: "Enable/disable jev-router routing",
    handler: async (_args: string, ctx: ExtensionContext) => {
      enabled = !enabled;
      ctx.ui.notify(`jev-router ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  // /jev-router:mode         → toggle shadow <-> act
  // /jev-router:mode shadow  → force shadow (log only, never dispatch)
  // /jev-router:mode act     → force act (actually dispatch)
  // Persists to config.json so the mode survives restarts.
  pi.registerCommand("jev-router:mode", {
    description: "Switch routing mode: shadow <-> act (args: shadow | act)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const arg = (args ?? "").trim().toLowerCase();
      let cfg: RouterConfig;
      try {
        cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
      } catch {
        cfg = { ...DEFAULTS };
      }
      if (arg === "shadow" || arg === "act") {
        cfg.mode = arg;
      } else if (arg) {
        ctx.ui.notify(`jev-router: unknown mode '${args.trim()}' — use 'shadow' or 'act'`, "warning");
        return;
      } else {
        cfg.mode = cfg.mode === "act" ? "shadow" : "act";
      }
      try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
        ctx.ui.notify(
          `jev-router mode: ${cfg.mode}${cfg.mode === "act" ? " (dispatches — latency budget " + cfg.deadlineMs + "ms)" : " (log only, always pass-through)"}`,
          "info",
        );
      } catch (e: any) {
        // config not writable → apply for this session only, say so
        ctx.ui.notify(`jev-router mode: ${cfg.mode} (this session only — config write failed: ${e?.message ?? e})`, "warning");
      }
    },
  });

  pi.registerCommand("jev-router:stats", {
    description: "Routing statistics (default: today — args: all | YYYY-MM-DD)",
    handler: async (args: string, ctx: ExtensionContext) => {
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        ctx.ui.notify("No log yet — route a few messages first.", "info");
        return;
      }

      const entries: LogEntry[] = [];
      for (const l of lines) {
        try {
          entries.push(JSON.parse(l));
        } catch {
          /* ignore */
        }
      }
      if (!entries.length) {
        ctx.ui.notify("No log entries yet.", "info");
        return;
      }

      const arg = (args ?? "").trim();
      const today = localDateKey();
      const dateFilter = !arg || arg === "today" ? today : arg === "all" ? null : arg;
      const scoped = dateFilter ? entries.filter((e) => localDateKey(e.ts) === dateFilter) : entries;
      const scans = scoped.filter((e) => e.type === "tool_result_scan");
      const { errors, modes } = computeStats(scoped);

      if (!Object.keys(modes).length) {
        ctx.ui.notify(`No routing data for ${dateFilter ?? "all time"}.`, "info");
        return;
      }

      const fmt = (o: Record<string, number>) =>
        Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ") || "—";
      const msg: string[] = [
        `jev-router — ${dateFilter ? dateFilter : "all time"} (${scoped.length} log entries, ${errors} errors)`,
      ];
      for (const [mode, m] of Object.entries(modes).sort()) {
        const pct = m.routed ? ((m.local / m.routed) * 100).toFixed(1) : "0.0";
        const lat = m.latencies;
        const cost = (m.tokens * 42) / 1e9;
        msg.push(
          `[${mode}] ${m.routed} routed — local rate ${pct}% (${m.local} avoided big-model turns)`,
          `  route:    ${fmt(m.byRoute)}`,
          `  decision: ${fmt(m.byDecision) || "(shadow — simulated L0 only)"}`,
          `  confidence hist: ${histLine(m.confHist)}`,
          `  noul hist:       ${histLine(m.noulHist)}`,
          `  latency p50/p95: ${percentile(m.latencies, 0.5)}/${percentile(m.latencies, 0.95)} ms`,
          `  Jev in: ${m.tokens} tokens → est. cost $${cost.toFixed(4)}`,
        );
        if (m.turnCosts.count) {
          const tc = m.turnCosts;
          msg.push(
            `  paid turns after pass: ${tc.count} turns · ${tc.input} in (+${tc.cacheRead} cache-read) · ${tc.output} out · $${tc.cost?.toFixed(4) ?? "?"} real cost`,
          );
        }
      }
      if (scans.length) {
        const ext = scans.filter((s) => s.external).length;
        const tot = scans.reduce((a, s) => a + (s.est_tokens ?? 0), 0);
        msg.push(`  tool_result scan (step 7A): ${scans.length} results, ${tot} est. tokens, ${ext} external-origin`);
      }
      ctx.ui.notify(msg.join("\n"), "info");
    },
  });
}
/**
 * pi-jev-router — TypeSafe Jev intent router for the pi coding agent
 *
 * Every user input is routed by Jev (state + typed questions, one parallel
 * call). Based on the route + confidence, the request is either handled
 * locally (no big-model turn at all) or passed through to pi's normal flow.
 *
 * Tiers:
 *   no_llm + conf >= confidenceGate + noul >= noulGate
 *     → small LLM one-shot formulates ONE read-only command
 *     → strict validation (binary allowlist, no operators/substitutions)
 *     → execute, show output, { action: "handled" } (agent loop never starts)
 *   validation fails or gates not met → fail-safe: pass-through to pi
 *   clarify / reasoning / small_task → pass-through (big model, default pi)
 *
 * Config: ~/.pi/agent/jev-router/config.json
 *   mode            "shadow" (log only, always pass-through) | "act"
 *   smallModel      OpenRouter model id used to formulate commands
 *   disableReasoning  send reasoning:{exclude:true} to the small model
 *   confidenceGate  minimum route confidence to act locally
 *   noulGate        minimum no_judgment noul to act locally
 *
 * Commands: /jev:stats, /jev:toggle
 * Key resolution: $TYPESAFE_API_KEY → ~/.pi/agent/jev-router/.env
 * OpenRouter key: reused from pi's ~/.pi/agent/auth.json
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ROUTER_DIR = path.join(os.homedir(), ".pi", "agent", "jev-router");
const LOG_FILE = path.join(ROUTER_DIR, "log.jsonl");
const CONFIG_FILE = path.join(ROUTER_DIR, "config.json");
const TYPESAFE_ENV_FALLBACKS = [path.join(ROUTER_DIR, ".env")];

const DEFAULTS = {
  mode: "shadow" as "shadow" | "act",
  smallModel: "google/gemini-2.5-flash",
  disableReasoning: true,
  confidenceGate: 0.9,
  noulGate: 0.7,
  smallModelTimeoutMs: 10000,
  injectLocalResults: true,
  injectMaxChars: 500,
  // Middle tier: when confidence falls below confidenceGate but stays above
  // smallTaskGate, the small LLM (with recent context) either formulates a
  // command or answers directly — the big model is the last resort only.
  midTier: true,
  smallTaskGate: 0.7,
};

// Default-deny allowlist of read-only binaries. "git" is subcommand-restricted.
// Platform-aware: some binaries only exist on some OSes. The availability
// check at execution time is the real gate; this list just narrows what the
// small model may propose per platform.
const LINUX_ONLY = new Set(["free"]);
const ALLOWED_BINARIES = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "du", "df", "pwd", "date",
  "wc", "file", "stat", "jq", "which", "whoami", "hostname", "uptime",
  "ps", "uname", "git", "pgrep", "pidof",
  ...(process.platform === "linux" ? [...LINUX_ONLY] : []),
]);
const GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "branch", "remote", "show", "tag"]);
// Forbidden characters: chains, redirections, substitution, etc.
const FORBIDDEN_CHARS = /[\n;|&>`<$()]/;
// Standalone tokens that must never appear as arguments.
const DANGEROUS_TOKENS = new Set([
  "rm", "mv", "cp", "touch", "mkdir", "chmod", "chown", "sudo", "sh",
  "bash", "zsh", "eval", "source", "xargs", "tee", "dd", "kill", "ln",
  "curl", "wget", "nc", "ssh", "perl", "python", "python3", "node",
  "awk", "sed", "find", "mount", "umount", "systemctl", "killall",
]);
// Flags that enable writes / arbitrary execution anywhere in the command.
const DANGEROUS_FLAGS = /^-.*?(delete|exec|okay|interpreter|script=)/i;

let enabled = true;
let typesafeKey: string | null | undefined;
let openrouterKey: string | null = null;
let routing = false; // guard against overlapping input events

function loadConfig() {
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
  return typesafeKey;
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

interface JevAnswer {
  route?: { choice: string; probabilities: Record<string, number>; confidence: number };
  no_judgment?: { noul: number };
  clarity?: { score: number; confidence: number };
  complexity?: { score: number; confidence: number };
  category?: { choice: string; confidence: number };
}

function recentMessages(ctx: ExtensionContext, max = 6): Array<{ role: string; text: string }> {
  try {
    const entries = (ctx.sessionManager as any).getBranch() ?? [];
    const out: Array<{ role: string; text: string }> = [];
    for (const e of entries) {
      // Injected router traces count as context too — the small model must
      // know what was already executed locally.
      if ((e as any)?.customType === "jev-router") {
        out.push({ role: "system", text: String((e as any)?.content ?? "").slice(0, 300) });
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
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    answers: (data.answers ?? {}) as JevAnswer,
    usage: data.usage,
    model: data.model,
  };
}

/** Is this binary present on PATH? Cheap, deterministic check. */
function binaryAvailable(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** Strict validation: default-deny. Returns the command or null. */
function validateCommand(cmd: string): string | null {
  const c = cmd.trim();
  if (!c || c === "NONE" || c.length > 300) return null;
  if (c.includes("\n") || FORBIDDEN_CHARS.test(c)) return null;
  const tokens = c.split(/\s+/);
  const bin = path.basename(tokens[0]);
  if (!ALLOWED_BINARIES.has(bin)) return null;
  if (!binaryAvailable(bin)) return null;
  for (const tok of tokens.slice(1)) {
    if (DANGEROUS_TOKENS.has(tok.toLowerCase())) return null;
    if (DANGEROUS_FLAGS.test(tok)) return null;
  }
  if (bin === "git") {
    if (tokens.length < 2 || !GIT_SUBCOMMANDS.has(tokens[1])) return null;
  }
  return c;
}

/** One-shot small-model call: turn the request into ONE read-only command. */
async function formulateCommand(
  request: string,
  cfg: ReturnType<typeof loadConfig>,
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
  cfg: ReturnType<typeof loadConfig>,
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
    exec(cmd, { timeout: 5000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
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

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const cfg = loadConfig();
    const hasKey = !!loadTypesafeKey();
    ctx.ui.notify(
      `jev-router loaded — mode: ${cfg.mode}, small: ${cfg.smallModel}, key: ${hasKey ? "found" : "MISSING"}`,
      hasKey ? "info" : "warning",
    );
  });

  pi.on("input", async (event: any, ctx: ExtensionContext) => {
    if (!enabled || routing) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    if (event.images?.length) return { action: "continue" }; // route on text only
    const text = (event.text ?? "").trim();
    if (!text || text.startsWith("/")) return { action: "continue" };

    const cfg = loadConfig();
    const recent = recentMessages(ctx);
    routing = true;
    const t0 = Date.now();

    try {
      // In shadow mode we don't block the turn; in act mode we must await.
      if (cfg.mode === "shadow") {
        askJev(text, event.streamingBehavior, ctx, recent)
          .then(async ({ answers, usage, model }) => {
            const latency = Date.now() - t0;
            await log({
              ts: new Date().toISOString(),
              mode: "shadow",
              text: text.slice(0, 500),
              latency_ms: latency,
              input_tokens: usage?.input_tokens,
              model,
              answers,
            });
            const r = answers.route;
            if (ctx.ui && r) {
              ctx.ui.setStatus("jev", `${r.choice} ${(r.confidence ?? 0).toFixed(2)} · ${latency}ms`);
            }
          })
          .catch(async (e: any) => {
            await log({ ts: new Date().toISOString(), mode: "shadow", text: text.slice(0, 500), error: String(e?.message ?? e) });
          })
          .finally(() => {
            routing = false;
          });
        return { action: "continue" };
      }

      // ---- ACT MODE ----
      const { answers, usage, model } = await askJev(text, event.streamingBehavior, ctx, recent);
      const latencyJev = Date.now() - t0;
      const route = answers.route;
      const noul = answers.no_judgment?.noul ?? 0;

      const conf = route?.confidence ?? 0;

      // Locally-handled inputs are NOT recorded by pi (handled = agent loop
      // skipped), so the injected trace also carries the user's prompt to
      // keep the session transcript and LLM context coherent.
      const injectTrace = (label: string, content: string) => {
        if (!cfg.injectLocalResults) return;
        try {
          pi.sendMessage(
            {
              customType: "jev-router",
              content: `[jev-router] ${label}\n> ${text.slice(0, 200)}\n${content.slice(0, cfg.injectMaxChars)}${content.length > cfg.injectMaxChars ? "\n…(truncated)" : ""}`,
              display: true,
              details: {},
            },
            { triggerTurn: false },
          );
        } catch {
          /* context injection is best-effort */
        }
      };

      const strictEligible =
        route?.choice === "no_llm" && conf >= cfg.confidenceGate && noul >= cfg.noulGate;
      const category = answers.category?.choice ?? "";
      const midEligible =
        !strictEligible &&
        cfg.midTier &&
        (route?.choice === "no_llm" || route?.choice === "small_task") &&
        conf >= cfg.smallTaskGate &&
        // "chat" is allowed only when a single command would suffice
        // (e.g. "dis moi la date" gets categorized chat with a flat
        // distribution, but noul=0.72 says a command covers it).
        (["command", "question"].includes(category) ||
         (category === "chat" && noul >= cfg.noulGate));

      if (!strictEligible && !midEligible) {
        await log({
          ts: new Date().toISOString(),
          mode: "act",
          decision: "pass",
          text: text.slice(0, 500),
          latency_ms: latencyJev,
          input_tokens: usage?.input_tokens,
          model,
          answers,
        });
        if (ctx.ui && route) {
          ctx.ui.setStatus(
            "jev",
            `→ ${route.choice} ${(route.confidence ?? 0).toFixed(2)} · ${latencyJev}ms`,
          );
        }
        return { action: "continue" };
      }

      // Small-model turn: strict path formulates a command; middle tier is
      // context-aware and may also answer directly.
      const t1 = Date.now();
      const outcome = strictEligible
        ? await (async () => {
            const raw = await formulateCommand(text, cfg);
            return raw ? validateCommand(raw) : null;
          })().then((cmd) => (cmd ? { kind: "command" as const, cmd } : null))
        : await formulateOrAnswer(text, cfg, recent);
      const latencySmall = Date.now() - t1;

      if (!outcome) {
        // Fail-safe: anything suspicious or NONE goes to the big model.
        await log({
          ts: new Date().toISOString(),
          mode: "act",
          decision: "fallback",
          tier: strictEligible ? "strict" : "mid",
          text: text.slice(0, 500),
          latency_ms: latencyJev,
          small_latency_ms: latencySmall,
          input_tokens: usage?.input_tokens,
          answers,
        });
        if (ctx.ui) ctx.ui.setStatus("jev", `fallback (${latencyJev + latencySmall}ms)`);
        return { action: "continue" };
      }

      if (outcome.kind === "answer") {
        // Middle tier: the small model answered directly (no command needed).
        await log({
          ts: new Date().toISOString(),
          mode: "act",
          decision: "answered_local",
          tier: "mid",
          text: text.slice(0, 500),
          latency_ms: latencyJev,
          small_latency_ms: latencySmall,
          input_tokens: usage?.input_tokens,
          answers,
        });
        injectTrace("answered locally", outcome.text);
        if (ctx.ui) {
          ctx.ui.setStatus("jev", `answered · ${latencyJev + latencySmall}ms`);
          // The injected trace already displays the answer — notify only
          // when injection is disabled, to avoid showing it twice.
          if (!cfg.injectLocalResults) ctx.ui.notify(outcome.text.slice(0, 2500), "info");
        }
        return { action: "handled" };
      }

      const cmd = outcome.cmd;
      const { output, failed } = await runCommand(cmd);
      if (failed) {
        // The command exists but failed on this system (bad flags, missing
        // library…). The big model can adapt; log the failed attempt.
        await log({
          ts: new Date().toISOString(),
          mode: "act",
          decision: "exec_failed",
          tier: strictEligible ? "strict" : "mid",
          command: cmd,
          text: text.slice(0, 500),
          latency_ms: latencyJev,
          small_latency_ms: latencySmall,
          answers,
        });
        if (ctx.ui) ctx.ui.setStatus("jev", `exec failed → pass (${latencyJev + latencySmall}ms)`);
        return { action: "continue" };
      }
      await log({
        ts: new Date().toISOString(),
        mode: "act",
        decision: "handled_local",
        tier: strictEligible ? "strict" : "mid",
        command: cmd,
        output_bytes: output.length,
        text: text.slice(0, 500),
        latency_ms: latencyJev,
        small_latency_ms: latencySmall,
        input_tokens: usage?.input_tokens,
        answers,
      });
      injectTrace(`executed locally\n$ ${cmd}`, output);
      if (ctx.ui) {
        ctx.ui.setStatus("jev", `local: ${cmd.slice(0, 40)} · ${latencyJev + latencySmall}ms`);
        if (!cfg.injectLocalResults) {
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
  });

  pi.registerCommand("jev:toggle", {
    description: "Enable/disable jev-router routing",
    handler: async (_args: string, ctx: ExtensionContext) => {
      enabled = !enabled;
      ctx.ui.notify(`jev-router ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerCommand("jev:stats", {
    description: "Show jev-router routing statistics",
    handler: async (_args: string, ctx: ExtensionContext) => {
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        ctx.ui.notify("No log yet — route a few messages first.", "info");
        return;
      }

      const results: any[] = [];
      let errorCount = 0;
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (e.error) errorCount++;
          else results.push(e);
        } catch {
          /* ignore */
        }
      }
      if (!results.length) {
        ctx.ui.notify(`No successful routes yet (${errorCount} errors).`, "info");
        return;
      }

      const byRoute: Record<string, number> = {};
      const byDecision: Record<string, number> = {};
      let confSum = 0;
      let tokSum = 0;
      for (const e of results) {
        const a = e.answers ?? {};
        if (a.route) {
          byRoute[a.route.choice] = (byRoute[a.route.choice] ?? 0) + 1;
          confSum += a.route.confidence ?? 0;
        }
        if (e.decision) byDecision[e.decision] = (byDecision[e.decision] ?? 0) + 1;
        tokSum += e.input_tokens ?? 0;
      }

      const n = results.length;
      const latencies = results.map((e) => e.latency_ms ?? 0).sort((x: number, y: number) => x - y);
      const p50 = latencies[Math.floor(n * 0.5)] ?? 0;
      const p95 = latencies[Math.min(Math.floor(n * 0.95), n - 1)] ?? 0;
      const costUsd = (tokSum * 42) / 1e9;
      const fmt = (o: Record<string, number>) =>
        Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ") || "—";

      const msg = [
        `jev-router — ${n} routed (${errorCount} errors)`,
        `route:    ${fmt(byRoute)}`,
        `decision: ${fmt(byDecision) || "(shadow mode — no decisions logged)"}`,
        `avg confidence: ${(confSum / n).toFixed(3)}`,
        `latency p50/p95: ${p50}/${p95} ms`,
        `Jev tokens: ${tokSum} in → est. cost $${costUsd.toFixed(4)}`,
      ].join("\n");
      ctx.ui.notify(msg, "info");
    },
  });
}

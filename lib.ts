/**
 * Pure routing logic for pi-jev-router — no pi imports, safe to unit-test
 * with `node --test` (Node >= 22.6 type stripping).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RouterConfig {
  mode: "shadow" | "act";
  smallModel: string;
  disableReasoning: boolean;
  confidenceGate: number;
  noulGate: number;
  smallTaskGate: number;
  midTier: boolean;
  deadlineMs: number;
  jevTimeoutMs: number;
  smallModelTimeoutMs: number;
  l0: boolean;
  requireTrustedProject: boolean;
  scanToolResults: boolean;
  injectLocalResults: boolean;
  injectMaxChars: number;
}

export const DEFAULTS: RouterConfig = {
  mode: "shadow",
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
  // 0.6 rather than 0.7: a mediocre mid-tier *answer* is cheap to correct
  // (ask again), unlike a wrongly-executed command. Command safety is still
  // gated elsewhere. (Calibration note, 2026-09-20: gates kept unchanged; the
  // measured distribution so far is too sparse to justify a move — see
  // README "Calibration".)
  midTier: true,
  smallTaskGate: 0.6,
  // Hard ceiling on added latency in act mode: Jev + small-model formulation
  // race against this deadline; losing the race means immediate pass-through
  // to the normal model. Nothing an entry adds before the normal model starts
  // may exceed this budget.
  deadlineMs: 1200,
  // Jev HTTP timeout. Kept above deadlineMs — the deadline race is the real
  // bound; this only caps the background call after a deadline loss.
  jevTimeoutMs: 3000,
  // L0 free tier: before any model call, run validateCommand() on the raw
  // user text. If it passes, execute directly — zero model calls. Only
  // correct when the text *is* the command; anything else fails validation
  // and falls through to normal routing.
  l0: true,
  // Refuse all local execution (L0, strict, mid) in a project explicitly
  // marked untrusted in ~/.pi/agent/trust.json. Fail-open when no decision
  // exists, like pi itself (trust in pi only guards resource loading).
  requireTrustedProject: true,
  // Shadow experiment (mission step 7A): log tool name, size and an
  // external-origin heuristic on every tool_result. Log-only, no
  // modification, no detection, no action.
  scanToolResults: true,
};

export interface JevAnswer {
  route?: { choice: string; probabilities: Record<string, number>; confidence: number };
  no_judgment?: { noul: number };
  clarity?: { score: number; confidence: number };
  complexity?: { score: number; confidence: number };
  category?: { choice: string; confidence: number };
}

// ---------------------------------------------------------------------------
// Command validation — default deny
// ---------------------------------------------------------------------------

// Default-deny allowlist of read-only binaries. "git" is subcommand-restricted.
// Platform-aware: some binaries only exist on some OSes. The availability
// check at execution time is the real gate; this list just narrows what the
// small model may propose per platform.
const LINUX_ONLY = new Set(["free"]);
export const ALLOWED_BINARIES = new Set([
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

// Paths whose *content* is a secret or a credential store. Checked against
// the whole command string: an allowlisted read-only binary ("cat", "grep",
// "head"…) pointed at one of these would exfiltrate the secret into the
// session context — and from there to the model providers. Router-internal
// hygiene; independent of any user-installed permission guard.
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /\.ssh/i,                       // ~/.ssh/**: private keys, known_hosts, authorized_keys
  /\.pi[/\\]agent[/\\]auth\.json/i, // pi's provider key store
  /(^|[\s/\\])\.env/i,          // .env, .env.local, .envrc (dotfile env variants)
  /\.env$/i,                      // any file named *.env
  /[/\\]environ$/i,               // /proc/*/environ
  /credential/i,                  // *credential*, .git-credentials, *_credentials*
  /id_rsa|id_ed25519|id_ecdsa/i,  // common SSH private key names
];

/** Is this binary present on PATH? Cheap, deterministic check. */
export function binaryAvailable(bin: string): boolean {
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
export function validateCommand(cmd: string): string | null {
  const c = cmd.trim();
  if (!c || c === "NONE" || c.length > 300) return null;
  if (c.includes("\n") || FORBIDDEN_CHARS.test(c)) return null;
  if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(c))) return null;
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
    // Bypass attempt: `git -c core.fsmonitor=<cmd> status` executes an
    // arbitrary binary via a config override. Reject any -c option (the
    // subcommand check already rejects "-c" in first position; this covers
    // "git status -c …").
    if (tokens.slice(2).some((t) => /^-c/.test(t))) return null;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Dispatch decision (pure) — Jev judges, this policy dispatches
// ---------------------------------------------------------------------------

export type Tier = "strict" | "mid" | "pass";

export function decide(answers: JevAnswer, cfg: RouterConfig): Tier {
  const route = answers.route;
  if (!route) return "pass";
  const conf = route.confidence ?? 0;
  const noul = answers.no_judgment?.noul ?? 0;
  const category = answers.category?.choice ?? "";

  const strict =
    route.choice === "no_llm" && conf >= cfg.confidenceGate && noul >= cfg.noulGate;
  if (strict) return "strict";

  // "chat" is allowed into the mid tier only when a single command would
  // suffice (e.g. "dis moi la date": categorized chat with a flat
  // distribution, but noul 0.72 says a command covers it).
  const mid =
    cfg.midTier &&
    (route.choice === "no_llm" || route.choice === "small_task") &&
    conf >= cfg.smallTaskGate &&
    (["command", "question"].includes(category) ||
      (category === "chat" && noul >= cfg.noulGate));
  return mid ? "mid" : "pass";
}

// ---------------------------------------------------------------------------
// Log aggregation for /jev:stats (pure)
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: string;
  mode?: string;
  decision?: string;
  error?: unknown;
  latency_ms?: number;
  input_tokens?: number;
  answers?: JevAnswer;
  type?: string; // "turn_cost", "tool_result_scan", …
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: number };
  // tool_result_scan entries (step 7A):
  tool?: string;
  chars?: number;
  est_tokens?: number;
  external?: boolean;
  external_reason?: string;
}

/** Local-timezone YYYY-MM-DD key for a log timestamp (or now). */
export function localDateKey(ts?: string): string {
  const d = ts ? new Date(ts) : new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface ModeStats {
  routed: number;
  byRoute: Record<string, number>;
  byDecision: Record<string, number>;
  confHist: number[]; // 10 buckets, 0.0–1.0
  noulHist: number[];
  latencies: number[];
  tokens: number;
  local: number; // handled_local + answered_local (incl. shadow-simulated L0)
  turnCosts: { count: number; input: number; output: number; cacheRead: number; cost: number };
}

export const HIST_BUCKETS = 10;

function histBucket(v: number | undefined, hist: number[]) {
  if (v === undefined || Number.isNaN(v)) return;
  const i = Math.min(HIST_BUCKETS - 1, Math.max(0, Math.floor(v * HIST_BUCKETS)));
  hist[i]++;
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  // Nearest-rank: index ceil(n*p)-1, clamped into range.
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

export function computeStats(entries: LogEntry[]): { errors: number; modes: Record<string, ModeStats> } {
  let errors = 0;
  const modes: Record<string, ModeStats> = {};
  const get = (mode: string): ModeStats => {
    if (!modes[mode]) {
      modes[mode] = {
        routed: 0, byRoute: {}, byDecision: {},
        confHist: new Array(HIST_BUCKETS).fill(0),
        noulHist: new Array(HIST_BUCKETS).fill(0),
        latencies: [], tokens: 0, local: 0,
        turnCosts: { count: 0, input: 0, output: 0, cacheRead: 0, cost: 0 },
      };
    }
    return modes[mode];
  };

  for (const e of entries) {
    if (e.error) { errors++; continue; }
    const mode = e.mode ?? "unknown";
    if (e.type === "turn_cost") {
      const m = get(mode).turnCosts;
      m.count++;
      m.input += e.usage?.input ?? 0;
      m.output += e.usage?.output ?? 0;
      m.cacheRead += e.usage?.cacheRead ?? 0;
      m.cost += e.usage?.cost ?? 0;
      continue;
    }
    if (e.type === "tool_result_scan") continue; // reported separately, not per-mode
    const m = get(mode);
    m.routed++;
    const a = e.answers ?? {};
    if (a.route) {
      m.byRoute[a.route.choice] = (m.byRoute[a.route.choice] ?? 0) + 1;
      histBucket(a.route.confidence, m.confHist);
    }
    if (a.no_judgment) histBucket(a.no_judgment.noul, m.noulHist);
    if (e.decision) {
      m.byDecision[e.decision] = (m.byDecision[e.decision] ?? 0) + 1;
      if (e.decision === "handled_local" || e.decision === "answered_local") m.local++;
    }
    if (e.latency_ms) m.latencies.push(e.latency_ms);
    m.tokens += e.input_tokens ?? 0;
  }
  for (const m of Object.values(modes)) m.latencies.sort((x, y) => x - y);
  return { errors, modes };
}

export function histLine(hist: number[]): string {
  return hist
    .map((n, i) => (n ? `${(i / HIST_BUCKETS).toFixed(1)}:${n}` : null))
    .filter(Boolean)
    .join("  ") || "—";
}

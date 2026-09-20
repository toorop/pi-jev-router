/**
 * Tests for pi-jev-router pure logic (lib.ts).
 * Run: npm test  →  node --test test/   (Node >= 22.6 type stripping)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS, validateCommand, decide, computeStats, localDateKey, percentile,
  type LogEntry,
} from "../lib.ts";

// ---------------------------------------------------------------------------
// validateCommand — default-deny allowlist + bypass attempts
// ---------------------------------------------------------------------------

const ok = (cmd: string) => assert.equal(validateCommand(cmd), cmd, `expected OK: ${cmd}`);
const no = (cmd: string) => assert.equal(validateCommand(cmd), null, `expected reject: ${cmd}`);

test("allows simple read-only commands", () => {
  ok("ls -la");
  ok("ls");
  ok("cat README.md");
  ok("head -5 foo.txt");
  ok("tail -n 20 bar.log");
  ok("grep -rn pattern src/");
  ok("du -sh .");
  ok("df -h");
  ok("pwd");
  ok("date");
  ok("wc -l *.ts");
  ok("stat index.ts");
  ok("which git");
  ok("whoami");
  ok("uname -a");
  ok("ps aux");
  ok("free -m"); // linux-only binary, we are on linux in CI/dev here
  ok("jq . keys.json");
  ok("file package.json");
});

test("allows restricted git subcommands", () => {
  ok("git status");
  ok("git log --oneline -5");
  ok("git diff HEAD~1");
  ok("git branch -a");
  ok("git remote -v");
  ok("git show abc123");
  ok("git tag");
});

test("rejects non-allowlisted binaries", () => {
  no("rm -rf /");
  no("echo hello");
  no("curl https://example.com");
  no("python3 -V");
  no("node -v");
  no("find . -name x");
  no("sed -n 1p file");
  no("awk '{print}' f");
  no("tar czf a.tgz .");
  no("make");
  no("xargs ls");
});

test("rejects chains, redirections, substitution, operators", () => {
  no("ls; rm x");
  no("cat a | grep b");
  no("cat `id`");
  no("ls $(pwd)");
  no("cat a > /tmp/out");
  no("cat a >> log");
  no("ls & ls");
  no("ls && rm x");
  no("ls || echo hi");
  no("cat a\nrm b"); // newline
  no("echo $HOME"); // substitution
  no("cat ${HOME}/x");
});

test("rejects dangerous argument tokens anywhere in the command", () => {
  no("ls rm");
  no("ls -la sudo");
  no("cat xargs");
  no("grep pattern bash");
});

test("rejects dangerous flags", () => {
  no("ls --delete");
  no("grep --exec=evil pattern");
  no("grep --exec-path x f");
  no("ls --okay f");
  no("git log --interpreter=sh");
});

test("rejects disallowed or shifted git subcommands", () => {
  no("git push");
  no("git commit -m x");
  no("git clean -fd");
  no("git"); // bare git
  no("status git"); // subcommand in wrong position
  // bypass attempt: -c core.fsmonitor=<binary> executes an arbitrary program
  no("git -c core.fsmonitor=evil status");
  no("git -ccore.fsmonitor=evil status");
});

test("rejects sensitive paths (secret/credential exfiltration)", () => {
  no("cat ~/.ssh/id_rsa");
  no("cat /home/u/.ssh/config");
  no("grep Host ~/.ssh/known_hosts");
  no("cat ~/.pi/agent/auth.json");
  no("cat .env");
  no("cat /srv/app/.env");
  no("cat .envrc");
  no("cat deploy.env");
  no("cat /proc/123/environ");
  no("cat ~/.git-credentials");
  no("grep token ~/.aws/credentials");
  no("cat id_rsa");
  no("cat ./id_ed25519");
  no("ls -la ~/.ssh");
});

test("rejects junk", () => {
  no("");
  no("   ");
  no("NONE");
  no("ls " + "a".repeat(300));
  no("ls %3B%20rm%20x".replace("%3B", ";"));
});

// ---------------------------------------------------------------------------
// decide — strict / mid / pass dispatch
// ---------------------------------------------------------------------------

const ans = (route: string, conf: number, noul: number, category: string) => ({
  route: { choice: route, confidence: conf, probabilities: {} },
  no_judgment: { noul },
  category: { choice: category, confidence: 1 },
});

test("strict tier requires no_llm + confidenceGate + noulGate", () => {
  assert.equal(decide(ans("no_llm", 0.95, 0.8, "command"), DEFAULTS), "strict");
  // strict fails on noul, but the mid tier catches it (dispatchable category):
  assert.equal(decide(ans("no_llm", 0.95, 0.5, "command"), DEFAULTS), "mid");
  // conf between smallTaskGate and confidenceGate → mid; below → pass:
  assert.equal(decide(ans("no_llm", 0.85, 0.8, "command"), DEFAULTS), "mid");
  assert.equal(decide(ans("no_llm", 0.5, 0.8, "command"), DEFAULTS), "pass");
  // small_task is never strict, but at high confidence it is mid-eligible:
  assert.equal(decide(ans("small_task", 0.99, 0.9, "command"), DEFAULTS), "mid");
});

test("mid tier takes dispatchable categories at smallTaskGate", () => {
  assert.equal(decide(ans("no_llm", 0.7, 0.8, "command"), DEFAULTS), "mid");
  assert.equal(decide(ans("small_task", 0.65, 0.1, "question"), DEFAULTS), "mid");
  assert.equal(decide(ans("small_task", 0.3, 0.1, "command"), DEFAULTS), "pass"); // conf below
  assert.equal(decide(ans("clarify", 0.95, 0.9, "command"), DEFAULTS), "pass"); // clarify never dispatches
  assert.equal(decide(ans("reasoning", 0.99, 0.9, "command"), DEFAULTS), "pass");
});

test("chat enters mid tier only with high noul", () => {
  assert.equal(decide(ans("small_task", 0.7, 0.72, "chat"), DEFAULTS), "mid");
  assert.equal(decide(ans("small_task", 0.72, 0.2, "chat"), DEFAULTS), "pass");
});

test("mid tier can be disabled by config", () => {
  const cfg = { ...DEFAULTS, midTier: false };
  assert.equal(decide(ans("small_task", 0.8, 0.9, "command"), cfg), "pass");
});

test("missing route is a pass", () => {
  assert.equal(decide({}, DEFAULTS), "pass");
});

// ---------------------------------------------------------------------------
// stats aggregation
// ---------------------------------------------------------------------------

test("computeStats aggregates routes, decisions, histograms and turn costs", () => {
  const mk = (over: Partial<LogEntry>): LogEntry => ({
    ts: "2026-09-20T10:00:00Z", mode: "act",
    answers: { route: { choice: "reasoning", confidence: 0.42, probabilities: {} } },
    ...over,
  });
  const entries: LogEntry[] = [
    mk({ decision: "pass", latency_ms: 400, input_tokens: 1000 }),
    mk({ decision: "pass", latency_ms: 600, input_tokens: 1100 }),
    mk({ decision: "handled_local", tier: "l0", answers: { route: { choice: "no_llm", confidence: 0.99, probabilities: {} }, no_judgment: { noul: 0.95 } } }),
    mk({ error: "boom" }),
    { ts: "2026-09-20T10:05:00Z", mode: "act", type: "turn_cost", usage: { input: 50000, output: 800, cacheRead: 20000, cost: 0.42 } },
    { ts: "2026-09-20T10:06:00Z", mode: "act", type: "tool_result_scan", tool: "bash", chars: 400, est_tokens: 100, external: true },
  ];
  const { errors, modes } = computeStats(entries);
  assert.equal(errors, 1);
  const act = modes.act;
  assert.equal(act.routed, 3);
  assert.equal(act.local, 1);
  assert.equal(act.byRoute.reasoning, 2);
  assert.equal(act.byRoute.no_llm, 1);
  assert.equal(act.byDecision.pass, 2);
  assert.equal(act.tokens, 2100);
  assert.equal(act.latencies.length, 2);
  assert.equal(percentile(act.latencies, 0.5), 400);
  assert.equal(percentile(act.latencies, 0.95), 600);
  assert.equal(act.confHist[Math.floor(0.42 * 10)], 2);
  assert.equal(act.noulHist[Math.floor(0.95 * 10)], 1);
  assert.equal(act.turnCosts.count, 1);
  assert.equal(act.turnCosts.input, 50000);
  assert.equal(act.turnCosts.cost, 0.42);
});

test("localDateKey formats in local time", () => {
  const d = new Date(2026, 8, 20, 23, 30); // Sep 20 2026, 23:30 local
  assert.equal(localDateKey(d.toISOString()), "2026-09-20");
});

test("default config is shadow mode with conservative gates", () => {
  assert.equal(DEFAULTS.mode, "shadow");
  assert.ok(DEFAULTS.confidenceGate > DEFAULTS.smallTaskGate);
  assert.ok(DEFAULTS.deadlineMs < DEFAULTS.jevTimeoutMs);
});
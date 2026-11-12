// Run from this mod's folder: node --test
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { checkTarget, checkTerminal, planAll, restartAgent, restartAll, MAX_POLLS } from "../restart.js";
import { antigravitySession, argvResumeId, claudeSession, conversationIds, codexConfirm, codexPrepare, exitMessageId, grokSession, lstartSeconds, rolloutIds } from "../sessions.js";

const CLAUDE_ID = "9555879a-c76f-47c9-b2f1-1b058d2870e6";
const CODEX_ID = "01a1be1c-1936-78a0-afe1-572570b8abc9";
const OTHER_ID = "01a1be20-0136-74b1-ad7b-e045d5339d62";
const PROC_START = "Mon Nov  9 01:39:35 2026";
const AGY_ID = "79043854-fe5b-4674-a7e6-4df7a30a31ec";
const AGY_OTHER = "c30bdae9-19a1-481c-9c5a-79889a251d1e";
const AGY_DIR = "/Users/me/.gemini/antigravity-cli";
const conversation = (id, suffix = ".db") => `n${AGY_DIR}/conversations/${id}${suffix}`;
const GROK_ID = "01a1cd40-7914-7562-a16b-9fb87be8aa46";
const GROK_START = "Thu Nov 12 00:55:15 2026";
const GROK_FILE = "/Users/me/.grok/active_sessions.json";
// What Grok keeps while it runs; pid_start is the process start in microseconds.
const grokEntry = (overrides = {}) => ({ session_id: GROK_ID, pid: 200, pid_start: 1794444915141436, cwd: "/x", ...overrides });
const grokFiles = (...entries) => ({ [GROK_FILE]: JSON.stringify(entries) });

// What a daemon-mode Codex prints when ctrl+c disconnects it, then the shell prompt.
function exitScreen(id = CODEX_ID, after = ["❯"]) {
  return [
    "some earlier shell output",
    "Disconnected from this task. Any running work continues.",
    "To reconnect, run:",
    `  codex resume ${id}`,
    "Stop the current turn: run codex agents, select this task, and press x.",
    "Token usage so far: total=287,373 input=262,511 (+ 16,593,536 cached) output=24,862 (reasoning 5,720)",
    ...after,
    "",
    "",
  ].join("\n");
}

// The shape `hc get <t> --json` prints, trimmed to what the mod reads.
function terminal({ app = "claude-code", state = "idle", argv = ["/bin/zsh", "-l"], fg = { pid: 200, argv: ["claude"] }, live = "live" } = {}) {
  return { address: "t1", pid: 100, argv, state: live, status: app ? { app, state } : null, foreground: fg };
}

const codexTerminal = (fgArgv) => terminal({ app: "codex", fg: { pid: 200, argv: fgArgv } });
const atPrompt = (term) => ({ ...term, foreground: { pid: term.pid, argv: ["/bin/zsh", "-l"] } });
const rollout = (id) => `n/Users/me/.codex/sessions/2026/11/09/rollout-2026-11-09T11-21-15-${id}.jsonl`;

function claudeRecord(overrides = {}) {
  return JSON.stringify({ pid: 200, sessionId: CLAUDE_ID, procStart: PROC_START, ...overrides });
}

// Fake I/O. `terminals` and `screens` are what successive `hc get` and `hc read` calls
// return; the last one repeats.
function harness({ terminals = [], screens = [""], files = {}, lsof = "", lstart = `${PROC_START}\n` }) {
  const calls = [];
  const gets = [...terminals];
  const reads = [...screens];
  const next = (queue) => (queue.length > 1 ? queue.shift() : queue[0]);
  return {
    calls,
    ops: {
      home: "/Users/me",
      getTerminal: async () => next(gets),
      readScreen: async (t) => { calls.push(["read", t]); return next(reads); },
      keys: async (t, keys) => { calls.push(["keys", t, ...keys]); },
      send: async (t, text) => { calls.push(["send", t, text]); },
      readFile: async (path) => files[path] ?? null,
      exec: async (cmd, args) => {
        if (cmd === "lsof") return { code: 0, stdout: lsof, stderr: "" };
        if (cmd === "env" && args.includes("lstart=")) return { code: 0, stdout: lstart, stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected" };
      },
      sleep: async () => { calls.push(["sleep"]); },
    },
  };
}

const CLAUDE_FILE = { "/Users/me/.claude/sessions/200.json": claudeRecord() };
const sent = (calls) => calls.filter(([name]) => name === "send");

test("checkTarget accepts a local address and refuses none or a remote one", () => {
  assert.equal(checkTarget("t1n"), "t1n");
  assert.throws(() => checkTarget(null), /No terminal is focused/);
  assert.throws(() => checkTarget("vps/t7"), /this computer/);
});

test("checkTerminal passes an idle or done agent in the foreground of a shell", () => {
  assert.equal(checkTerminal(terminal()).label, "Claude");
  assert.equal(checkTerminal(terminal({ state: "done" })).label, "Claude");
  assert.equal(checkTerminal(terminal({ app: "codex", argv: ["/bin/zsh", "-lic", "x", "/bin/zsh", "codex"] })).label, "Codex");
  assert.equal(checkTerminal(terminal({ argv: ["-zsh"] })).label, "Claude");
});

test("checkTerminal refuses everything else", () => {
  const cases = [
    [terminal({ live: "finished" }), /not running/],
    [terminal({ app: null }), /No agent/],
    [terminal({ app: "opencode" }), /Unsupported agent: opencode/],
    [terminal({ state: "working" }), /working, not idle/],
    [terminal({ state: "blocked" }), /blocked, not idle/],
    [terminal({ argv: ["claude"] }), /no shell to return to/],
    [atPrompt(terminal()), /not in the foreground/],
    [terminal({ fg: null }), /not in the foreground/],
  ];
  for (const [term, message] of cases) assert.throws(() => checkTerminal(term), message);
});

test("claudeSession reads the record Claude keeps for its pid", async () => {
  const { ops } = harness({ files: CLAUDE_FILE });
  assert.equal(await claudeSession(terminal(), ops), CLAUDE_ID);
});

test("claudeSession refuses a missing, mismatched, reused or malformed record", async () => {
  const path = "/Users/me/.claude/sessions/200.json";
  const cases = [
    [{}, undefined, /did not record a session/],
    [{ [path]: "{not json" }, undefined, /not valid JSON/],
    [{ [path]: claudeRecord({ pid: 201 }) }, undefined, /does not match/],
    [{ [path]: claudeRecord({ procStart: undefined }) }, undefined, /does not match/],
    [CLAUDE_FILE, "Tue Nov 10 09:00:00 2026\n", /earlier process/],
    [{ [path]: claudeRecord({ sessionId: "abc; rm -rf ~" }) }, undefined, /unexpected format/],
  ];
  for (const [files, lstart, message] of cases) {
    const { ops } = harness({ files, ...(lstart ? { lstart } : {}) });
    await assert.rejects(claudeSession(terminal(), ops), message);
  }
});

test("rolloutIds reads distinct session IDs from lsof -Fn output", () => {
  const out = ["p200", "f36", rollout(CODEX_ID), "f37", rollout(CODEX_ID), "f38", "n/Users/me/.codex/logs_2.sqlite"].join("\n");
  assert.deepEqual(rolloutIds(out), [CODEX_ID]);
  assert.deepEqual(rolloutIds(""), []);
});

test("argvResumeId takes the first UUID after resume", () => {
  assert.equal(argvResumeId(["codex", "resume", CODEX_ID]), CODEX_ID);
  assert.equal(argvResumeId(["codex", "resume", "--no-daemon", "-c", "model=o3", CODEX_ID]), CODEX_ID);
  assert.equal(argvResumeId(["codex", "resume", "--last"]), null);
  assert.equal(argvResumeId(["codex"]), null);
  assert.equal(argvResumeId(undefined), null);
});

test("exitMessageId reads the newest reconnect command right above the prompt", () => {
  assert.equal(exitMessageId(exitScreen()), CODEX_ID);
  assert.equal(exitMessageId(`${exitScreen(OTHER_ID)}\n${exitScreen(CODEX_ID)}`), CODEX_ID);
  assert.equal(exitMessageId(exitScreen(CODEX_ID, ["~/dev/app main", "❯"])), CODEX_ID);
});

test("exitMessageId refuses an old message, a typed command or no message", () => {
  // An older exit, then the person started Codex again: Codex printed nothing this time.
  assert.equal(exitMessageId(exitScreen(OTHER_ID, ["❯ codex", "❯"])), null);
  assert.equal(exitMessageId(exitScreen(OTHER_ID, ["❯ ls", "a", "b", "c", "❯"])), null);
  assert.equal(exitMessageId(`❯ codex resume ${CODEX_ID}\n❯`), null);
  assert.equal(exitMessageId(`  codex resume ${CODEX_ID}\n❯`), null);
  assert.equal(exitMessageId("❯"), null);
  assert.equal(exitMessageId(undefined), null);
});

test("codexPrepare reads the mode and any ID it can before Codex stops", async () => {
  const prepare = (argv, lsof = "") => codexPrepare(codexTerminal(argv), harness({ lsof }).ops);
  assert.deepEqual(await prepare(["codex"]), { id: null, noDaemon: false });
  assert.deepEqual(await prepare(["codex", "resume", CODEX_ID]), { id: CODEX_ID, noDaemon: false });
  assert.deepEqual(await prepare(["codex", "--no-daemon", "resume", CODEX_ID]), { id: CODEX_ID, noDaemon: true });
  assert.deepEqual(await prepare(["codex"], rollout(CODEX_ID)), { id: CODEX_ID, noDaemon: true });
  assert.deepEqual(await prepare(["codex", "resume", OTHER_ID], rollout(CODEX_ID)), { id: CODEX_ID, noDaemon: true });
});

test("codexPrepare refuses before any key when it can't be sure", async () => {
  const prepare = (argv, lsof = "") => codexPrepare(codexTerminal(argv), harness({ lsof }).ops);
  await assert.rejects(prepare(["codex"], `${rollout(CODEX_ID)}\n${rollout(OTHER_ID)}`), /several sessions/);
  // Without a daemon nothing keeps the session after exit: the ID must be known first.
  await assert.rejects(prepare(["codex", "--no-daemon"]), /did not show its session ID/);
});

test("codexConfirm trusts what Codex printed on exit", async () => {
  const daemon = { id: null, noDaemon: false };
  assert.equal(await codexConfirm("t1", daemon, harness({ screens: [exitScreen()] }).ops), CODEX_ID);
  // The session changed inside Codex: the printed ID wins over the argv one.
  assert.equal(await codexConfirm("t1", { id: OTHER_ID, noDaemon: false }, harness({ screens: [exitScreen()] }).ops), CODEX_ID);
  assert.equal(await codexConfirm("t1", { id: OTHER_ID, noDaemon: true }, harness({ screens: [exitScreen()] }).ops), CODEX_ID);
});

test("codexConfirm reads the screen again while the message arrives", async () => {
  const { calls, ops } = harness({ screens: ["❯", exitScreen()] });
  assert.equal(await codexConfirm("t1", { id: null, noDaemon: false }, ops), CODEX_ID);
  assert.deepEqual(calls, [["read", "t1"], ["sleep"], ["read", "t1"]]);
});

test("codexConfirm without a printed ID: --no-daemon keeps its own, a daemon one refuses", async () => {
  assert.equal(await codexConfirm("t1", { id: CODEX_ID, noDaemon: true }, harness({ screens: ["❯"] }).ops), CODEX_ID);
  await assert.rejects(codexConfirm("t1", { id: CODEX_ID, noDaemon: false }, harness({ screens: ["❯"] }).ops), new RegExp(`No resume command was sent.*showed ${CODEX_ID}`));
  await assert.rejects(codexConfirm("t1", { id: null, noDaemon: false }, harness({ screens: ["❯"] }).ops), /No resume command was sent/);
});

test("restart presses ctrl+c until the shell is back, then resumes in the same terminal", async () => {
  const alive = terminal();
  const { calls, ops } = harness({ terminals: [alive, alive, alive, atPrompt(alive)], files: CLAUDE_FILE });
  const result = await restartAgent("t1", ops);
  assert.equal(result.command, `claude --resume ${CLAUDE_ID}`);
  assert.deepEqual(calls, [
    ["keys", "t1", "esc"],
    ["keys", "t1", "ctrl+c"],
    ["sleep"],
    ["keys", "t1", "ctrl+c"],
    ["sleep"],
    ["send", "t1", `claude --resume ${CLAUDE_ID}`],
  ]);
});

test("a daemon-mode Codex resumes the printed session without --no-daemon", async () => {
  const alive = codexTerminal(["codex"]);
  const { calls, ops } = harness({ terminals: [alive, atPrompt(alive)], screens: [exitScreen()] });
  await restartAgent("t1", ops);
  assert.deepEqual(calls, [
    ["keys", "t1", "esc"],
    ["read", "t1"],
    ["send", "t1", `codex resume ${CODEX_ID}`],
  ]);
});

test("a --no-daemon Codex resumes with --no-daemon", async () => {
  const alive = codexTerminal(["codex", "--no-daemon", "resume", CODEX_ID]);
  const { calls, ops } = harness({ terminals: [alive, atPrompt(alive)], screens: ["❯"] });
  await restartAgent("t1", ops);
  assert.deepEqual(calls.at(-1), ["send", "t1", `codex resume --no-daemon ${CODEX_ID}`]);
});

test("a daemon-mode Codex that printed nothing gets no resume command", async () => {
  const alive = codexTerminal(["codex"]);
  const { calls, ops } = harness({ terminals: [alive, atPrompt(alive)], screens: ["❯"] });
  await assert.rejects(restartAgent("t1", ops), /No resume command was sent/);
  assert.deepEqual(sent(calls), []);
});

test("guard and session failures send no key", async () => {
  const cases = [
    [terminal({ state: "working" }), {}],
    [terminal(), {}],
  ];
  for (const [term, files] of cases) {
    const { calls, ops } = harness({ terminals: [term], files });
    await assert.rejects(restartAgent("t1", ops));
    assert.deepEqual(calls, []);
  }
});

test("an agent that never exits gets no resume command", async () => {
  const { calls, ops } = harness({ terminals: [terminal()], files: CLAUDE_FILE });
  await assert.rejects(restartAgent("t1", ops), /did not exit within 5 seconds/);
  assert.deepEqual(sent(calls), []);
  assert.equal(calls.filter(([, , key]) => key === "ctrl+c").length, MAX_POLLS);
});

test("a terminal that ends while stopping gets no resume command", async () => {
  const alive = terminal();
  const { calls, ops } = harness({ terminals: [alive, { ...alive, state: "finished" }], files: CLAUDE_FILE });
  await assert.rejects(restartAgent("t1", ops), /terminal ended/);
  assert.deepEqual(sent(calls), []);
});

test("planAll targets local, live, idle or done Claude and Codex terminals only", () => {
  const listed = (address, agent, status, state = "live") => ({ address, agent, status, state, where: "ray / work" });
  const plan = planAll([
    listed("t1", "claude-code", "idle"),
    listed("t2", "codex", "done"),
    listed("t3", "claude-code", "working"),
    listed("t4", "opencode", "idle"),
    listed("home/t5", "claude-code", "idle"),
    listed("t6", "claude-code", "idle", "finished"),
    listed("t7", null, null),
  ]);
  assert.deepEqual(plan.targets, [
    { address: "t1", label: "Claude", where: "ray / work" },
    { address: "t2", label: "Codex", where: "ray / work" },
  ]);
  assert.equal(plan.skipped, 5);
  assert.deepEqual(planAll(null), { targets: [], skipped: 0 });
});

test("restartAll goes on after a failure and reports each terminal", async () => {
  const alive = terminal();
  const { calls, ops } = harness({
    terminals: [alive, atPrompt(alive), terminal({ state: "working" }), alive, atPrompt(alive)],
    files: CLAUDE_FILE,
  });
  const reports = [];
  const targets = ["t1", "t2", "t3"].map((address) => ({ address, label: "Claude", where: "" }));
  const results = await restartAll(targets, { ...ops, report: (message) => reports.push(message) });
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.match(results[1].error, /Claude is working, not idle/);
  assert.deepEqual(sent(calls), [
    ["send", "t1", `claude --resume ${CLAUDE_ID}`],
    ["send", "t3", `claude --resume ${CLAUDE_ID}`],
  ]);
  assert.equal(calls.some(([, address]) => address === "t2"), false);
  assert.equal(reports[0], "1/3 t1: Stopping Claude…");
});

test("agent-restart-all holds exact copies of the shared modules", () => {
  for (const name of ["restart.js", "sessions.js", "agents.js", "ops.js"]) {
    const here = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
    const there = readFileSync(new URL(`../../agent-restart-all/${name}`, import.meta.url), "utf8");
    assert.equal(there, here, name);
  }
});

test("lstartSeconds reads ps output and refuses anything else", () => {
  assert.equal(lstartSeconds(`${GROK_START}\n`), 1794444915);
  assert.equal(lstartSeconds("Mon Nov  9 01:39:35 2026"), Date.UTC(2026, 10, 9, 1, 39, 35) / 1000);
  assert.equal(lstartSeconds(""), null);
  assert.equal(lstartSeconds("not a date"), null);
  assert.equal(lstartSeconds("Thu Foo 12 00:55:15 2026"), null);
});

test("grokSession reads the entry Grok keeps for its pid", async () => {
  const other = grokEntry({ pid: 999, session_id: "01a1cd3b-f740-7e51-973d-688f545f226f" });
  const { ops } = harness({ files: grokFiles(other, grokEntry()), lstart: `${GROK_START}\n` });
  assert.equal(await grokSession(terminal({ app: "grok" }), ops), GROK_ID);
});

test("grokSession refuses a missing, ambiguous or stale record", async () => {
  const term = terminal({ app: "grok" });
  const cases = [
    [{}, GROK_START, /did not record a session/],
    [{ [GROK_FILE]: "{" }, GROK_START, /not valid JSON/],
    [grokFiles(), GROK_START, /did not record a session/],
    [grokFiles(grokEntry({ pid: 5 })), GROK_START, /did not record a session/],
    [{ [GROK_FILE]: "{}" }, GROK_START, /did not record a session/],
    [grokFiles(grokEntry(), grokEntry({ session_id: "01a1cd3b-f740-7e51-973d-688f545f226f" })), GROK_START, /several sessions/],
    [grokFiles(grokEntry({ pid_start: undefined })), GROK_START, /does not match/],
    [grokFiles(grokEntry()), "Thu Nov 12 00:50:15 2026", /earlier process/],
    [grokFiles(grokEntry()), "", /earlier process/],
    [grokFiles(grokEntry({ session_id: "x; rm -rf ~" })), GROK_START, /unexpected format/],
  ];
  for (const [files, lstart, message] of cases) {
    const { ops } = harness({ files, lstart: `${lstart}\n` });
    await assert.rejects(grokSession(term, ops), message);
  }
});

test("grokSession allows the one second ps rounds off", async () => {
  const { ops } = harness({ files: grokFiles(grokEntry()), lstart: "Thu Nov 12 00:55:16 2026\n" });
  assert.equal(await grokSession(terminal({ app: "grok" }), ops), GROK_ID);
});

test("restart resumes a Grok session with grok --resume", async () => {
  const alive = terminal({ app: "grok" });
  const { calls, ops } = harness({ terminals: [alive, alive, atPrompt(alive)], files: grokFiles(grokEntry()), lstart: `${GROK_START}\n` });
  const result = await restartAgent("t1", ops);
  assert.equal(result.command, `grok --resume ${GROK_ID}`);
  assert.deepEqual(sent(calls), [["send", "t1", `grok --resume ${GROK_ID}`]]);
  assert.deepEqual(calls.filter(([name]) => name === "keys").map(([, , key]) => key), ["esc", "ctrl+c"]);
});

test("a Grok record problem sends no key", async () => {
  const { calls, ops } = harness({ terminals: [terminal({ app: "grok" })], files: grokFiles(), lstart: `${GROK_START}\n` });
  await assert.rejects(restartAgent("t1", ops), /did not record a session/);
  assert.deepEqual(calls, []);
});

test("conversationIds counts each database once and skips other files", () => {
  const out = [
    `n${AGY_DIR}/conversation_summaries.db`,
    `n${AGY_DIR}/brain/${AGY_ID}`,
    conversation(AGY_ID),
    conversation(AGY_ID, ".db-wal"),
    conversation(AGY_ID, ".db-shm"),
    `n/other/antigravity-cli/conversations/${AGY_OTHER}.db`,
    `p123`,
  ].join("\n");
  assert.deepEqual(conversationIds(out), [AGY_ID, AGY_OTHER]);
  assert.deepEqual(conversationIds(""), []);
  assert.deepEqual(conversationIds(undefined), []);
});

test("antigravitySession reads the one conversation the process holds open", async () => {
  const { ops } = harness({ lsof: [conversation(AGY_ID), conversation(AGY_ID, ".db-wal")].join("\n") });
  assert.equal(await antigravitySession(terminal({ app: "antigravity", fg: { pid: 200, argv: ["agy"] } }), ops), AGY_ID);
});

test("antigravitySession refuses no conversation and several", async () => {
  const term = terminal({ app: "antigravity" });
  const none = harness({ lsof: `n${AGY_DIR}/conversation_summaries.db` });
  await assert.rejects(antigravitySession(term, none.ops), /no conversation yet/);
  const two = harness({ lsof: [conversation(AGY_ID), conversation(AGY_OTHER)].join("\n") });
  await assert.rejects(antigravitySession(term, two.ops), /several conversations/);
});

test("restart resumes an Antigravity conversation with agy --conversation", async () => {
  const alive = terminal({ app: "antigravity", fg: { pid: 200, argv: ["agy"] } });
  const { calls, ops } = harness({ terminals: [alive, alive, atPrompt(alive)], lsof: conversation(AGY_ID) });
  const result = await restartAgent("t1", ops);
  assert.equal(result.label, "Antigravity");
  assert.equal(result.command, `agy --conversation=${AGY_ID}`);
  assert.deepEqual(sent(calls), [["send", "t1", `agy --conversation=${AGY_ID}`]]);
  assert.deepEqual(calls.filter(([name]) => name === "keys").map(([, , key]) => key), ["esc", "ctrl+c"]);
});

test("an Antigravity with no conversation sends no key", async () => {
  const { calls, ops } = harness({ terminals: [terminal({ app: "antigravity" })], lsof: "" });
  await assert.rejects(restartAgent("t1", ops), /no conversation yet/);
  assert.deepEqual(calls, []);
});

// Run from this mod's folder: node --test
import assert from "node:assert/strict";
import test from "node:test";
import { checkTarget, checkTerminal, restartAgent, MAX_POLLS } from "../restart.js";
import { argvResumeId, claudeSession, codexSession, rolloutIds } from "../sessions.js";

const CLAUDE_ID = "9555879a-c76f-47c9-b2f1-1b058d2870e6";
const CODEX_ID = "01a1be1c-1936-78a0-afe1-572570b8abc9";
const PROC_START = "Mon Nov  9 01:39:35 2026";

// The shape `hc get <t> --json` prints, trimmed to what the mod reads.
function terminal({ app = "claude-code", state = "idle", argv = ["/bin/zsh", "-l"], fg = { pid: 200, argv: ["claude"] }, live = "live" } = {}) {
  return { address: "t1", pid: 100, argv, state: live, status: app ? { app, state } : null, foreground: fg };
}

const atPrompt = (term) => ({ ...term, foreground: { pid: term.pid, argv: ["/bin/zsh", "-l"] } });

function claudeRecord(overrides = {}) {
  return JSON.stringify({ pid: 200, sessionId: CLAUDE_ID, procStart: PROC_START, ...overrides });
}

// Fake I/O: `terminals` are what successive `hc get` calls return (the last one repeats).
function harness({ terminals, files = {}, lsof = "", lstart = `${PROC_START}\n` }) {
  const calls = [];
  const queue = [...terminals];
  return {
    calls,
    ops: {
      home: "/Users/me",
      getTerminal: async () => (queue.length > 1 ? queue.shift() : queue[0]),
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
    [terminal({ app: "grok" }), /Unsupported agent: grok/],
    [terminal({ state: "working" }), /working, not idle/],
    [terminal({ state: "blocked" }), /blocked, not idle/],
    [terminal({ argv: ["claude"] }), /no shell to return to/],
    [atPrompt(terminal()), /not in the foreground/],
    [terminal({ fg: null }), /not in the foreground/],
  ];
  for (const [term, message] of cases) assert.throws(() => checkTerminal(term), message);
});

test("claudeSession reads the record Claude keeps for its pid", async () => {
  const { ops } = harness({ terminals: [], files: CLAUDE_FILE });
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
    const { ops } = harness({ terminals: [], files, ...(lstart ? { lstart } : {}) });
    await assert.rejects(claudeSession(terminal(), ops), message);
  }
});

test("rolloutIds reads distinct session IDs from lsof -Fn output", () => {
  const out = [
    "p200",
    "f36",
    `n/Users/me/.codex/sessions/2026/11/09/rollout-2026-11-09T11-21-15-${CODEX_ID}.jsonl`,
    "f37",
    `n/Users/me/.codex/sessions/2026/11/09/rollout-2026-11-09T11-21-15-${CODEX_ID}.jsonl`,
    "f38",
    "n/Users/me/.codex/logs_2.sqlite",
  ].join("\n");
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

test("codexSession prefers the open rollout file, then the resume argv, else refuses", async () => {
  const codex = (argv) => terminal({ app: "codex", fg: { pid: 200, argv } });
  const rollout = (id) => `n/Users/me/.codex/sessions/2026/11/09/rollout-2026-11-09T11-21-15-${id}.jsonl`;
  const other = "01a1be20-0136-74b1-ad7b-e045d5339d62";

  assert.equal(await codexSession(codex(["codex", "resume", other]), harness({ terminals: [], lsof: rollout(CODEX_ID) }).ops), CODEX_ID);
  assert.equal(await codexSession(codex(["codex", "resume", CODEX_ID]), harness({ terminals: [] }).ops), CODEX_ID);
  await assert.rejects(codexSession(codex(["codex"]), harness({ terminals: [], lsof: `${rollout(CODEX_ID)}\n${rollout(other)}` }).ops), /several sessions/);
  await assert.rejects(codexSession(codex(["codex"]), harness({ terminals: [] }).ops), /--no-daemon/);
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

test("codex resumes with --no-daemon", async () => {
  const alive = terminal({ app: "codex", fg: { pid: 200, argv: ["codex", "resume", CODEX_ID] } });
  const { calls, ops } = harness({ terminals: [alive, atPrompt(alive)] });
  await restartAgent("t1", ops);
  assert.deepEqual(calls.at(-1), ["send", "t1", `codex resume --no-daemon ${CODEX_ID}`]);
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
  assert.equal(calls.filter(([name]) => name === "send").length, 0);
  assert.equal(calls.filter(([, , key]) => key === "ctrl+c").length, MAX_POLLS);
});

test("a terminal that ends while stopping gets no resume command", async () => {
  const alive = terminal();
  const { calls, ops } = harness({ terminals: [alive, { ...alive, state: "finished" }], files: CLAUDE_FILE });
  await assert.rejects(restartAgent("t1", ops), /terminal ended/);
  assert.equal(calls.filter(([name]) => name === "send").length, 0);
});

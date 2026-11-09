// The restart sequence. It imports nothing from Herdr, so node can test it:
// `ops` does all I/O (hc calls, file reads, programs, waiting, progress).
//
// Order is the safety rule: every check passes before the first key goes to the
// terminal, and so does the session ID, with one exception: a daemon-mode Codex.
// Its daemon keeps the session after Codex exits, and Codex prints the reconnect
// command then, so the ID is read after the exit. If it isn't there, nothing is sent.

import { agentFor } from "./agents.js";
import { requireSessionId } from "./sessions.js";

export const POLL_MS = 400;
export const STOP_TIMEOUT_MS = 5_000;
export const MAX_POLLS = Math.ceil(STOP_TIMEOUT_MS / POLL_MS);

// "done" is "idle" that nobody has looked at yet: both wait for input.
const READY = new Set(["idle", "done"]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "xonsh", "elvish"]);

export function isShell(path) {
  const base = String(path ?? "").split("/").pop();
  return SHELLS.has(base.replace(/^-/, ""));
}

export function checkTarget(address) {
  if (!address) throw new Error("No terminal is focused.");
  if (address.includes("/")) throw new Error("Agent Restart works on this computer's terminals only.");
  return address;
}

export function checkTerminal(term) {
  if (term?.state !== "live") throw new Error("The focused terminal is not running.");
  const app = term.status?.app;
  if (!app) throw new Error("No agent is running in the focused terminal.");
  const agent = agentFor(app);
  if (!agent) throw new Error(`Unsupported agent: ${app}.`);
  const state = term.status.state;
  if (!READY.has(state)) throw new Error(`${agent.label} is ${state}, not idle.`);
  // The terminal's own program must be a shell: if the agent is, exiting it closes the pane.
  if (!isShell(term.argv?.[0])) throw new Error(`${agent.label} has no shell to return to.`);
  const pid = term.foreground?.pid;
  if (!Number.isInteger(pid) || pid === term.pid) throw new Error(`${agent.label} is not in the foreground.`);
  return agent;
}

// The shell is back in the foreground: the agent has exited.
function shellIsBack(term) {
  return term.foreground?.pid === term.pid;
}

async function stopAgent(address, ops) {
  await ops.keys(address, ["esc"]);
  for (let poll = 0; ; poll += 1) {
    const term = await ops.getTerminal(address);
    if (term?.state !== "live") throw new Error("The terminal ended. No resume command was sent.");
    if (shellIsBack(term)) return;
    if (poll >= MAX_POLLS) {
      throw new Error(`The agent did not exit within ${STOP_TIMEOUT_MS / 1000} seconds. No resume command was sent.`);
    }
    // Claude and Codex both quit on a second ctrl+c, so press until the process is gone.
    await ops.keys(address, ["ctrl+c"]);
    await ops.sleep(POLL_MS);
  }
}

export async function restartAgent(address, ops) {
  const report = ops.report ?? (() => {});
  const term = await ops.getTerminal(address);
  const agent = checkTerminal(term);
  const plan = await agent.prepare(term, ops);

  report(`Stopping ${agent.label}…`);
  await stopAgent(address, ops);

  if (agent.confirm) report(`Reading what ${agent.label} printed…`);
  const found = agent.confirm ? await agent.confirm(address, plan, ops) : plan.id;
  const sessionId = requireSessionId(found, agent.label);
  const command = agent.resume(sessionId, plan);

  report(`Resuming ${agent.label}…`);
  await ops.send(address, command);
  return { label: agent.label, sessionId, command };
}

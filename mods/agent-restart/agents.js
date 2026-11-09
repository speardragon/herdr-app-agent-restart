// The agents Agent Restart can restart, keyed by the app name they report (OSC 7501,
// `status.app` in `hc get`). Each one says how to find its live session and how to
// resume it. Add an agent here once its session can be found without guessing.

import { claudeSession, codexSession } from "./sessions.js";

const AGENTS = {
  "claude-code": {
    label: "Claude",
    findSession: claudeSession,
    resume: (id) => `claude --resume ${id}`,
  },
  codex: {
    label: "Codex",
    findSession: codexSession,
    // herdr-core needs Codex without its shared daemon (hc --skill).
    resume: (id) => `codex resume --no-daemon ${id}`,
  },
};

export function agentFor(app) {
  return Object.prototype.hasOwnProperty.call(AGENTS, app) ? AGENTS[app] : null;
}

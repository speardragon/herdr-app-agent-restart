// The agents Agent Restart can restart, keyed by the app name they report (OSC 7501,
// `status.app` in `hc get`). Add an agent here once its session can be found without
// guessing.
//
//   prepare(term, ops)            before any key: what to resume ({ id, ... }); throws if unsure
//   confirm(address, plan, ops)   optional, after the agent exited: the final session ID
//   resume(id, plan)              the shell command that resumes it

import { claudeSession, codexConfirm, codexPrepare, grokSession } from "./sessions.js";

const AGENTS = {
  "claude-code": {
    label: "Claude",
    prepare: async (term, ops) => ({ id: await claudeSession(term, ops) }),
    resume: (id) => `claude --resume ${id}`,
  },
  codex: {
    label: "Codex",
    prepare: codexPrepare,
    confirm: codexConfirm,
    // Keep the mode it ran in: a daemon-mode session lives on in the daemon.
    resume: (id, plan) => (plan.noDaemon ? `codex resume --no-daemon ${id}` : `codex resume ${id}`),
  },
  grok: {
    label: "Grok",
    prepare: async (term, ops) => ({ id: await grokSession(term, ops) }),
    resume: (id) => `grok --resume ${id}`,
  },
};

export function agentFor(app) {
  return Object.prototype.hasOwnProperty.call(AGENTS, app) ? AGENTS[app] : null;
}

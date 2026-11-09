// Finds the session a running agent process is in, from what the agent itself writes.
// It never guesses: a missing, ambiguous or unverifiable answer is an error, and
// restart.js sends no key before this succeeds.

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_PATTERN}$`, "i");
const ROLLOUT = new RegExp(`/sessions/.*rollout-.*-(${UUID_PATTERN})\\.jsonl$`, "i");

// The ID goes into a shell command line, so only a plain UUID is accepted.
export function requireSessionId(value, label) {
  if (typeof value === "string" && UUID.test(value)) return value;
  throw new Error(`${label} reported a session ID in an unexpected format.`);
}

function parseRecord(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON.`);
  }
}

// Claude Code keeps ~/.claude/sessions/<pid>.json while it runs. Its procStart is
// `ps -o lstart` in the C locale and UTC, which tells a live record from a stale one
// whose pid was reused.
export async function claudeSession(term, ops) {
  const pid = term.foreground.pid;
  const text = await ops.readFile(`${ops.home}/.claude/sessions/${pid}.json`);
  if (!text) throw new Error("Claude did not record a session for this process.");
  const record = parseRecord(text, "Claude's session record");
  if (record.pid !== pid || !record.procStart) {
    throw new Error("Claude's session record does not match this process.");
  }
  const started = await ops.exec("env", ["LC_ALL=C", "TZ=UTC", "ps", "-o", "lstart=", "-p", String(pid)]);
  if (started.code !== 0 || started.stdout.trim() !== record.procStart) {
    throw new Error("Claude's session record belongs to an earlier process.");
  }
  return requireSessionId(record.sessionId, "Claude");
}

// Session IDs in the rollout files a process holds open (`lsof -Fn` lines start with "n").
export function rolloutIds(lsofOutput) {
  const ids = String(lsofOutput ?? "")
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => ROLLOUT.exec(line.slice(1))?.[1]?.toLowerCase())
    .filter(Boolean);
  return [...new Set(ids)];
}

// `codex resume <id>`: the first UUID after "resume", past any options.
export function argvResumeId(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const at = list.indexOf("resume");
  if (at < 0) return null;
  return list.slice(at + 1).find((arg) => UUID.test(arg)) ?? null;
}

// Codex started with --no-daemon writes its own rollout file; a daemon-mode Codex
// leaves that to the shared daemon, so only a `codex resume <id>` command line names it.
export async function codexSession(term, ops) {
  const { pid, argv } = term.foreground;
  const open = await ops.exec("lsof", ["-nP", "-p", String(pid), "-Fn"]);
  const ids = rolloutIds(open.stdout);
  if (ids.length > 1) throw new Error("Codex has several sessions open. Restart it by hand.");
  const id = ids[0] ?? argvResumeId(argv);
  if (!id) throw new Error("Codex did not show its session ID. Start Codex with --no-daemon, then try again.");
  return requireSessionId(id, "Codex");
}

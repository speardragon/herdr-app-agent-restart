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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// `ps -o lstart` in the C locale and UTC ("Thu Nov 12 00:55:15 2026") as epoch seconds.
export function lstartSeconds(text) {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(String(text ?? ""));
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (month < 0) return null;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000;
}

// Grok keeps ~/.grok/active_sessions.json while it runs: one entry per process, with the
// session ID, the pid and the process start in microseconds since the epoch. The entry
// goes when Grok exits. A pid that was reused has a different start, so it is refused.
export async function grokSession(term, ops) {
  const pid = term.foreground.pid;
  const text = await ops.readFile(`${ops.home}/.grok/active_sessions.json`);
  if (!text) throw new Error("Grok did not record a session for this process.");
  const entries = parseRecord(text, "Grok's session list");
  const mine = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.pid === pid);
  if (mine.length === 0) throw new Error("Grok did not record a session for this process.");
  if (mine.length > 1) throw new Error("Grok recorded several sessions for this process. Restart it by hand.");
  const [entry] = mine;
  if (!Number.isFinite(entry.pid_start)) throw new Error("Grok's session record does not match this process.");
  const started = await ops.exec("env", ["LC_ALL=C", "TZ=UTC", "ps", "-o", "lstart=", "-p", String(pid)]);
  const actual = started.code === 0 ? lstartSeconds(started.stdout) : null;
  // ps rounds down to a second.
  if (actual === null || Math.abs(actual - Math.floor(entry.pid_start / 1e6)) > 1) {
    throw new Error("Grok's session record belongs to an earlier process.");
  }
  return requireSessionId(entry.session_id, "Grok");
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

const CONVERSATION = new RegExp(`/antigravity-cli/conversations/(${UUID_PATTERN})\\.db$`, "i");

// Conversation IDs in the database files a process holds open (`lsof -Fn` "n" lines).
// The `-wal` and `-shm` files beside a database are not counted.
export function conversationIds(lsofOutput) {
  const ids = String(lsofOutput ?? "")
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => CONVERSATION.exec(line.slice(1))?.[1]?.toLowerCase())
    .filter(Boolean);
  return [...new Set(ids)];
}

// Antigravity opens ~/.gemini/antigravity-cli/conversations/<uuid>.db when a conversation
// starts and holds it while it runs, so lsof ties the process to its conversation. Before
// the first message there is none: nothing to resume. Two are refused, not guessed.
export async function antigravitySession(term, ops) {
  const open = await ops.exec("lsof", ["-nP", "-p", String(term.foreground.pid), "-Fn"]);
  const ids = conversationIds(open.stdout);
  if (ids.length === 0) throw new Error("Antigravity has no conversation yet. There is nothing to resume.");
  if (ids.length > 1) throw new Error("Antigravity has several conversations open. Restart it by hand.");
  return requireSessionId(ids[0], "Antigravity");
}

// `codex resume <id>`: the first UUID after "resume", past any options.
export function argvResumeId(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const at = list.indexOf("resume");
  if (at < 0) return null;
  return list.slice(at + 1).find((arg) => UUID.test(arg)) ?? null;
}

// Before Codex stops: its mode, and any ID it shows. Codex started with --no-daemon
// holds its own rollout file open. A daemon-mode Codex leaves that to the shared daemon,
// which keeps the session after Codex exits; Codex then prints the reconnect command,
// so its ID can wait until then. Without a daemon, the ID must be known now.
export async function codexPrepare(term, ops) {
  const { pid, argv } = term.foreground;
  const open = await ops.exec("lsof", ["-nP", "-p", String(pid), "-Fn"]);
  const ids = rolloutIds(open.stdout);
  if (ids.length > 1) throw new Error("Codex has several sessions open. Restart it by hand.");
  const noDaemon = ids.length === 1 || (Array.isArray(argv) && argv.includes("--no-daemon"));
  const id = ids[0] ?? argvResumeId(argv);
  if (noDaemon && !id) throw new Error("Codex (--no-daemon) did not show its session ID. Restart it by hand.");
  return { id: id ? requireSessionId(id, "Codex") : null, noDaemon };
}

const RECONNECT = "To reconnect, run:";
const RESUME_LINE = new RegExp(`^codex resume (${UUID_PATTERN})$`, "i");
// Codex's own lines after the command; anything else must be the new shell prompt.
const CODEX_TAIL = [/^Stop the current turn/i, /^Token usage/i];
const MAX_PROMPT_LINES = 3;

// What a daemon-mode Codex prints when it disconnects:
//   To reconnect, run:
//     codex resume <uuid>
// Only the newest one counts, and only right above the prompt: an older exit would be
// followed by the command that started Codex again, which mentions codex.
export function exitMessageId(screen) {
  const lines = String(screen ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let at = lines.length - 1;
  while (at >= 0 && !RESUME_LINE.test(lines[at])) at -= 1;
  if (at < 1 || lines[at - 1] !== RECONNECT) return null;
  const prompt = lines.slice(at + 1).filter((line) => !CODEX_TAIL.some((re) => re.test(line)));
  if (prompt.length > MAX_PROMPT_LINES || prompt.some((line) => /\bcodex\b/i.test(line))) return null;
  return RESUME_LINE.exec(lines[at])[1].toLowerCase();
}

// About 2 seconds for the shell screen to show what Codex printed.
export const SCREEN_READS = 8;
export const SCREEN_RETRY_MS = 250;

// After Codex stops: what it printed wins, since the session may have changed inside
// Codex. Without it, only a --no-daemon Codex falls back to the ID it showed before.
export async function codexConfirm(address, plan, ops) {
  for (let read = 0; read < SCREEN_READS; read += 1) {
    if (read > 0) await ops.sleep(SCREEN_RETRY_MS);
    const printed = exitMessageId(await ops.readScreen(address));
    if (printed) return printed;
  }
  if (plan.noDaemon && plan.id) return plan.id;
  const before = plan.id ? ` Before it stopped, Codex showed ${plan.id}; compare it with the screen.` : "";
  throw new Error(`Codex exited, but its reconnect command was not on the screen. No resume command was sent. Run the codex resume command that Codex printed.${before}`);
}

// The real I/O behind restart.js: herdr-core (hc), files and programs on this machine.

import { hc, exec, readTextFile, home } from "herdr";

const EXEC_TIMEOUT_MS = 10_000;

// hc prints {error: {kind, message, hint}} on stderr when it fails.
export function hcError(result) {
  try {
    return JSON.parse(result.stderr).error.message;
  } catch {
    return result.stderr.trim() || `hc exited with code ${result.code}.`;
  }
}

async function hcCall(args) {
  const result = await hc(args);
  if (result.code !== 0) throw new Error(hcError(result));
  return result.stdout;
}

async function getTerminal(address) {
  const out = await hcCall(["get", address, "--json"]);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`hc get ${address} did not print JSON.`);
  }
}

async function listTerminals() {
  const out = await hcCall(["ls", "--json"]);
  try {
    return JSON.parse(out).terminals ?? [];
  } catch {
    throw new Error("hc ls did not print JSON.");
  }
}

// `cx` must be the AsyncContext of the task that runs the restart.
export function herdrOps(cx, report) {
  return {
    home: home(),
    getTerminal,
    listTerminals,
    // The visible screen only (hc read defaults to --lines 0).
    readScreen: (address) => hcCall(["read", address]),
    keys: (address, keys) => hcCall(["keys", address, ...keys]),
    // hc send pastes the text and presses Enter: at a shell prompt, that runs it.
    send: (address, text) => hcCall(["send", address, text]),
    readFile: (path) => readTextFile(path),
    exec: (command, args) => exec(command, args, { timeout: EXEC_TIMEOUT_MS }),
    sleep: (ms) => cx.sleep(ms),
    report,
  };
}

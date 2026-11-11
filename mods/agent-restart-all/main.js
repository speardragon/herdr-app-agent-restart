// Agent Restart All: cmd+shift+r lists every idle Claude Code and Codex agent on this
// computer, asks once, then restarts them one at a time with the agent-restart mod's
// sequence. restart.js, sessions.js, agents.js and ops.js are copies of that mod's
// files: a mod cannot import from another folder. A window, for the same reason as
// agent-restart: a closed overlay cancels the task.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, props, closeOverlay, run, theme } from "herdr";
import { planAll, restartAll } from "./restart.js";
import { herdrOps } from "./ops.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// loading → confirm → running → done; "empty" and "failed" end early.
const BUSY = new Set(["loading", "running"]);

export default class AgentRestartAll extends View {
  init(_props, cx) {
    const now = focused();
    this.origin = now?.shown ?? now?.terminal ?? null;
    this.phase = "loading";
    this.message = "Listing the agents…";
    this.targets = [];
    this.skipped = 0;
    this.results = [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => this.load(cx));
  }

  ops(cx) {
    return herdrOps(cx, (message) => {
      this.message = message;
      cx.notify();
    });
  }

  fail(error, cx) {
    this.phase = "failed";
    this.message = error?.message ?? String(error);
    cx.notify();
  }

  async load(cx) {
    try {
      const plan = planAll(await this.ops(cx).listTerminals());
      this.targets = plan.targets;
      this.skipped = plan.skipped;
      this.phase = plan.targets.length > 0 ? "confirm" : "empty";
      cx.notify();
    } catch (error) {
      this.fail(error, cx);
    }
  }

  async start(cx) {
    this.phase = "running";
    this.message = "Starting…";
    cx.notify();
    try {
      this.results = await restartAll(this.targets, this.ops(cx));
      if (this.results.every((r) => r.ok)) return this.dismiss();
      this.phase = "done";
      cx.notify();
    } catch (error) {
      this.fail(error, cx);
    }
  }

  dismiss() {
    closeOverlay(props().overlay);
    if (!this.origin) return;
    try {
      run("pane.focus", { terminal: this.origin });
    } catch {
      // Best effort: the terminal may no longer be shown.
    }
  }

  onKey(event, cx) {
    cx.stop_propagation();
    if (BUSY.has(this.phase)) return;
    if (this.phase !== "confirm") return this.dismiss();
    if (event.keystroke === "enter") cx.spawn(async (cx) => this.start(cx));
    if (event.keystroke === "escape") this.dismiss();
  }

  headline() {
    const n = this.targets.length;
    const failed = this.results.filter((r) => !r.ok).length;
    if (this.phase === "confirm") return `Restart ${n} idle agent${n === 1 ? "" : "s"}? ${this.skipped} other terminals stay as they are.`;
    if (this.phase === "empty") return "No idle Claude or Codex agent to restart.";
    if (this.phase === "done") return `${n - failed} restarted, ${failed} failed.`;
    return this.message;
  }

  rows(t) {
    if (this.phase === "confirm") {
      return this.targets.map((x) => this.row(t, `${x.address}  ${x.label}`, x.where, t.muted));
    }
    if (this.phase === "done") {
      return this.results.filter((r) => !r.ok).map((r) => this.row(t, `${r.address}  ${r.label}`, r.error, t.blocked));
    }
    return [];
  }

  row(t, head, detail, color) {
    return v_flex()
      .gap(2)
      .child(div().text_color(color).child(head))
      .when(Boolean(detail), (el) => el.child(div().text_size(11).text_color(t.dim).child(detail)));
  }

  hint() {
    if (this.phase === "confirm") return "Enter restarts · Esc cancels";
    return BUSY.has(this.phase) ? "" : "Any key closes";
  }

  render() {
    const t = theme();
    const busy = BUSY.has(this.phase);
    const bad = this.phase === "failed" || this.phase === "done";
    const mark = busy
      ? div().text_color(t.working).frames(SPINNER, 90)
      : div().text_color(bad ? t.blocked : t.foreground).font_semibold().child(bad ? "!" : "↻");
    return v_flex()
      .id("agent-restart-all")
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .size_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .rounded(8)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(mark)
          .child(div().flex_1().text_size(14).font_semibold().text_color(t.foreground).child("Agent Restart All"))
          .child(div().text_size(11).text_color(t.dim).child(this.hint())),
      )
      .child(div().text_color(busy ? t.muted : t.foreground).child(this.headline()))
      .child(v_flex().id("rows").flex_1().min_h(0).gap(8).overflow_y_scrollbar().children(this.rows(t)));
  }
}

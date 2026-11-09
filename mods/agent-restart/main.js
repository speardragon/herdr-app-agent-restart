// Agent Restart: cmd+r restarts the focused idle agent (Claude Code, Codex) and resumes
// the same session in the same terminal. keys.json opens this mod with mod.open; mod.json
// makes it a small window. It closes itself on success and shows the reason on failure.
//
// A window, not a popup or dialog: Esc or a click beside those closes them, and a
// closed overlay cancels this task, possibly after the agent stopped and before resume.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, props, closeOverlay, run, theme } from "herdr";
import { checkTarget, restartAgent } from "./restart.js";
import { herdrOps } from "./ops.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default class AgentRestart extends View {
  init(_props, cx) {
    // Read the target before anything can move focus.
    const now = focused();
    this.target = now?.shown ?? now?.terminal ?? null;
    this.message = "Checking the agent…";
    this.error = null;
    // Keys pressed during the restart come here, not to the agent's terminal.
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => this.restart(cx));
  }

  async restart(cx) {
    const report = (message) => {
      this.message = message;
      cx.notify();
    };
    try {
      const target = checkTarget(this.target);
      await restartAgent(target, herdrOps(cx, report));
      this.dismiss();
    } catch (error) {
      this.error = error?.message ?? String(error);
      cx.notify();
    }
  }

  // Close the window and give the keyboard back to the terminal.
  dismiss() {
    closeOverlay(props().overlay);
    if (!this.target) return;
    try {
      run("pane.focus", { terminal: this.target });
    } catch {
      // Best effort: the terminal may no longer be shown.
    }
  }

  render() {
    const t = theme();
    const failed = this.error !== null;
    const mark = failed
      ? div().text_color(t.blocked).font_semibold().child("!")
      : div().text_color(t.working).frames(SPINNER, 90);
    return v_flex()
      .id("agent-restart")
      .track_focus(this.handle)
      .on_key_down((_event, cx) => {
        if (this.error !== null) this.dismiss();
        cx.stop_propagation();
      })
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
          .child(div().flex_1().text_size(14).font_semibold().text_color(t.foreground).child("Agent Restart"))
          .when(failed, (el) => el.child(div().text_size(11).text_color(t.dim).child("Any key closes"))),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .text_color(failed ? t.foreground : t.muted)
          .child(failed ? this.error : this.message),
      )
      .when(failed, (el) => el.child(h_flex().justify_end().child(this.closeButton(t))));
  }

  closeButton(t) {
    return h_flex()
      .id("close")
      .h(28)
      .px(12)
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(t.input)
      .bg(t.raised)
      .text_size(12)
      .text_color(t.foreground)
      .cursor_pointer()
      .hover((s) => s.opacity(0.88))
      // A window drags on any press its controls don't stop.
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click(() => this.dismiss())
      .child("Close");
  }
}

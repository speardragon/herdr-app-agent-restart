# Agent Restart for the Herdr app

Press `cmd+r` on an idle Claude Code, Codex, Grok or Antigravity agent. The agent exits, and the same
session resumes in the same terminal. `cmd+shift+r` does the same for every idle agent,
one at a time, after you confirm the list.

![Agent Restart](preview.png)

## Install

Ask your agent in the Herdr app to add this mod from this repo. Or copy it by hand:

1. Copy `mods/agent-restart/` and `mods/agent-restart-all/` to `~/.config/herdr-app/mods/`.
2. Add the keys from `keys.json` to the `global` section of `~/.config/herdr-app/keys.json`.
3. Run `herdr-app check` on both mod folders.

## Supported

- Claude Code.
- Grok. The checks work on live terminals; a Grok restart with `cmd+r` is not tested
  in the app yet.
- Codex, with or without `--no-daemon`. A daemon-mode Codex prints its reconnect command
  when it exits; the mod reads it from the screen. A daemon-mode Codex restart is tested
  in the app. A `--no-daemon` Codex restart is not. Restart All was run once in the app.
- Antigravity (`agy`). It needs a conversation: with no message sent, the mod refuses. A
  restart with `cmd+r` is not tested in the app yet.
- Local terminals only. Tested on macOS only.

How it works, what it reads and runs, and its limits: [RECIPE.md](RECIPE.md).

Idea from the Herdr plugin
[hmu332233/herdr-agent-restart](https://github.com/hmu332233/herdr-agent-restart).

## Test

```sh
cd mods/agent-restart && node --test
```

## License

[MIT](LICENSE)

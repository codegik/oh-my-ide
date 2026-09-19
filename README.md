<p align="center">
  <img src="apps/desktop/assets/icon.png" alt="oh-my-ide" width="320">
</p>

<h1 align="center">oh-my-ide</h1>

<p align="center">
  <strong>Run ten Claude Code sessions at once. Never lose one. Always know whose move it is.</strong>
</p>

<p align="center">
  A local-first cockpit for engineers who live in the terminal and have too many of them open.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Arch_Linux-supported-1793D1?logo=archlinux&logoColor=white" alt="Arch Linux supported">
  <img src="https://img.shields.io/badge/macOS-supported-000000?logo=apple&logoColor=white" alt="macOS supported">
  <img src="https://img.shields.io/badge/Wayland-native-FFBC00?logo=wayland&logoColor=black" alt="Wayland native">
</p>

<p align="center">
  <a href="docs/media/demo.mp4">
    <img src="docs/media/demo.gif" alt="oh-my-ide demo: two tracks, each driving its own live Claude Code session" width="100%">
  </a>
  <br>
  <sub>1.5× speed. <a href="docs/media/demo.mp4">Watch the full-quality MP4</a>.</sub>
</p>

---

## Does this sound familiar?

- You have **twelve terminal tabs** of Claude sessions open, and you can't remember which one was
  the security review.
- A terminal closed, or the laptop rebooted, and **the session went with it**.
- Someone asked you something in Slack. You told Claude to investigate. Twenty minutes later
  the answer is ready, and you've **lost the Slack thread, the PR and the reason you asked**.
- It's 9am and you **don't know where to start**, because nothing tells you which of your 40
  open loops is waiting on you and which is waiting on the machine.

oh-my-ide solves this with one idea: the **Track**.

## The Track

A Track is an open loop, meaning something you owe someone (or yourself). It keeps
everything about that loop in one place:

| | |
|---|---|
| **Question** | What the track is trying to answer. You can answer a question; a label just goes stale. |
| **Sessions** | One or more live Claude Code sessions, rendered right in the track. You can type into them. |
| **Refs** | Paste a PR, issue, Slack permalink, Jira URL or bare `PAY-123`. It becomes a typed link. |
| **Notes & timeline** | The track's history, so coming back means reading it instead of piecing it together. |
| **Court** | Whose move it is: `ON ME`, `ON CLAUDE`, `ON THEM`, `PARKED`. It's worked out for you. You can pin it, but you never have to maintain it. |

Court is the important one. **Todo/doing/done can't tell you where to start. Court can.**

| | |
|---|---|
| 🟠 **ON ME** | Claude is waiting on me |
| 🔵 **ON CLAUDE** | the machine is thinking |
| 🟣 **ON THEM** | waiting on another human: a review, an answer, a decision |
| ⚪ **PARKED** | deliberately not now |

When a session is thinking, the track is `ON CLAUDE`. When it's waiting on you, the track
flips to `ON ME` and the sidebar tells you *1 needs you*. Click the chip to see which rule
fired.

## Why you can trust it with your sessions

**Closing the app never costs you a session.** This comes from how the app is built, not
from a promise:

```
Electron  ──unix socket──▶  omid daemon  ──documented CLI──▶  Claude supervisor
(disposable)                (restartable)                     (owns the sessions)
```

- **Electron owns nothing durable.** Kill it, crash it, close it. Nothing is lost.
- **The daemon (`omid`)** owns the socket, the SQLite database and the pollers, but it does
  **not** own the sessions. You can restart it at any time.
- **Claude Code's own background supervisor** owns the sessions. The cockpit attaches to
  them and doesn't hold them hostage.

So `claude attach <id>` in a plain terminal works **at the same time** as the cockpit. If
you stop using oh-my-ide tomorrow, every session is still there in `claude agents`.
Nothing is locked in.

## What else is in it

- 🏠 **Local-first.** No server, no account, no telemetry, no sync. One SQLite file on your disk.
- 🔌 **Works offline.** Ref parsing is plain regex, so it needs no API tokens and no OAuth.
- ⌨️ **Terminal-native.** It runs the real Claude Code TUI, not a chat window pretending to be one.
- 🗂️ **Tabs that survive restarts.** Reopen the app and your open tracks are where you left them.
- 🧱 **Contained coupling.** One package, `packages/claude-adapter`, is allowed to know that
  `~/.claude` exists. It checks the Claude Code version and degrades gracefully instead of breaking.
- 🚫 **No Sessions screen, on purpose.** Claude Code already has `claude agents`. In oh-my-ide
  a session belongs to a track; it isn't a place you go to.

## Install

### Arch Linux

oh-my-ide is in the AUR as [`oh-my-ide-bin`](https://aur.archlinux.org/packages/oh-my-ide-bin):

```sh
yay -S oh-my-ide-bin      # or paru, or any AUR helper
```

It shows up in your app launcher, and new versions arrive with your usual `yay -Syu`.
It bundles its own Electron, so you don't need Node or pnpm. You do need **Claude Code 2.1+**
(`claude`). Wherever you installed it (npm, nvm, mise or the native installer), the app finds
it through your login shell's `PATH`.

After an upgrade, the next launch swaps in the new daemon. Your Claude sessions are not
touched.

### From source

Runs on **Arch Linux** and **macOS** (see [Platforms](#platforms)). Requires **Node 22+**,
**pnpm**, and **Claude Code 2.1+** on `PATH`.

```sh
git clone git@github.com:codegik/oh-my-ide.git && cd oh-my-ide
pnpm install
./start.sh            # fetches the electron binary on first run, builds, opens the app
```

The daemon keeps running after you close the window. That's deliberate: it's why closing
the app never costs you a session.

| command | what it does |
|---|---|
| `./start.sh`         | build if needed, then open the app |
| `./start.sh doctor`  | check prerequisites (node, pnpm, claude, electron, socket) |
| `./start.sh status`  | is the daemon up, and what sessions exist |
| `./start.sh build`   | force a rebuild |
| `./start.sh daemon`  | run the daemon in the foreground with logs |
| `./start.sh stop`    | stop the daemon (**Claude sessions keep running**) |
| `./start.sh install` | add oh-my-ide to the app launcher (walker, etc.) with its icon (Linux) |

## Platforms

oh-my-ide runs on **Arch Linux** and **macOS**. Both use the same `./start.sh`, which
detects the OS and handles the differences.

### Arch Linux

To install the package, see [Install](#install). To run from source:

```sh
sudo pacman -S --needed git nodejs pnpm   # or bring your own node via nvm / mise
```

- **Native Wayland.** Electron is started with the Ozone platform hint, so on Hyprland,
  Sway or GNOME it renders natively instead of blurry through XWayland.
- **Launcher entry.** The package installs one. From source, `./start.sh install` writes
  `~/.local/share/applications/oh-my-ide.desktop` with the app icon, so it shows up in walker,
  rofi, fuzzel or your desktop's app grid.
- **Works when node comes from nvm / mise.** A launcher doesn't get your shell's `PATH`, so
  both `oh-my-ide` and `start.sh` borrow it from your login shell. If a launch from the menu
  does nothing, the reason is in `~/.local/state/oh-my-ide/launch.log` (package) or
  `start.log` (source), and in a desktop notification if `notify-send` is installed.
- **Matches your desktop's font size.** On GNOME-style desktops the UI reads your text size
  from `gsettings`, so the app is as readable as the rest of your system.

Other Linux distributions should work the same way, but Arch is the one it's built and tested on.

### macOS

```sh
brew install node pnpm   # or bring your own node via nvm / mise
```

- **A real app name and icon.** An unpackaged Electron app shows up as "Electron" in the
  Dock and Cmd+Tab. `start.sh` runs from a renamed, re-signed copy of the Electron bundle
  (an APFS clone, so it takes no extra disk), so you see **oh-my-ide** with its own icon.
- **Native macOS menu bar**, kept as macOS apps expect (it's removed on Linux).
- Everything else works the same as on Linux: the same daemon, Unix socket and SQLite file.

## Status

Early. Here's where things stand:

**Works today**
- Create tracks from a folder, attach new or existing Claude sessions, several per track
- Live, typeable Claude Code TUI inside each track
- Typed refs: GitHub PR/issue, Slack permalink, Jira URL, bare `PAY-123`
- Court worked out from session state, with a "why?" popover to pin, drop or close
- Tracks and open tabs saved in SQLite, surviving restarts

**Not built yet**
- GitHub poller (PR refs don't show live state yet)
- Auto-joining sessions to tracks by branch
- Triage inbox
- Slack / Jira / Calendar integrations

The full design is in [`docs/PLAN.md`](docs/PLAN.md). The decisions settled by measurement
are in [`docs/decisions/`](docs/decisions/).

## Development

```sh
pnpm install
pnpm test                  # unit + contract tests
OMI_LIVE=1 pnpm vitest run # also run contract tests against the installed CLI
pnpm typecheck
```

Cutting a release, and how the Arch package is built: [`docs/RELEASING.md`](docs/RELEASING.md).

## License

[MIT](LICENSE) © Inacio Klassmann

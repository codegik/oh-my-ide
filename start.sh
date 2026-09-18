#!/usr/bin/env bash
# Start oh-my-ide.
#
# The daemon outlives this script on purpose: closing the window, quitting the
# app, or killing this shell must never stop a Claude session.
set -euo pipefail

cd "$(dirname "$0")"

# Launched from a desktop entry, this gets the session's PATH, not the shell's:
# node from nvm/mise/etc. is set up in the shell rc, so it is missing here, and
# pnpm and electron's launcher (a node script) die with "command not found"
# (or a different node is found, without pnpm and claude next to it). Borrow
# PATH from an interactive login shell; the marker skips what the rc files print.
if ! { command -v node && command -v pnpm && command -v claude; } >/dev/null 2>&1; then
  shell_path="$("${SHELL:-/bin/bash}" -lic 'printf "\n__OMI_PATH__%s" "$PATH"' 2>/dev/null </dev/null \
    | sed -n 's/^__OMI_PATH__//p' | tail -1)" || true
  [ -n "$shell_path" ] && export PATH="$shell_path"
fi

# With no terminal (Terminal=false in the desktop entry), output goes nowhere,
# so a failed launch looks like nothing happened. Keep a log and say so. Test
# for a controlling terminal, not `-t 1`, so `./start.sh status | grep` still
# prints where it was asked to.
if ! { : >/dev/tty; } 2>/dev/null; then
  LOG="${XDG_STATE_HOME:-$HOME/.local/state}/oh-my-ide/start.log"
  mkdir -p "$(dirname "$LOG")"
  exec >>"$LOG" 2>&1
  echo "--- $(date '+%F %T') start.sh $*"
  trap 'rc=$?; [ $rc -eq 0 ] || { command -v notify-send >/dev/null 2>&1 &&
    notify-send -a oh-my-ide "oh-my-ide failed to start" "exit $rc; see $LOG"; }' EXIT
fi

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/omi-$(id -u)}/oh-my-ide"
SOCKET="$RUNTIME_DIR/daemon.sock"
DAEMON_ENTRY="apps/daemon/dist/index.cjs"
DESKTOP_ENTRY="apps/desktop/dist/main.cjs"
RENDERER_BUNDLE="apps/desktop/renderer/bundle.js"

usage() {
  cat <<'EOF'
usage: ./start.sh [command]

  (no command)   build if needed, then open the app
  build          force a rebuild of all packages
  daemon         run the daemon in the foreground (logs to this terminal)
  status         show whether the daemon is listening, and list sessions
  stop           stop the daemon (Claude sessions keep running)
  doctor         check prerequisites
  install        add oh-my-ide to the app launcher, with its icon
EOF
}

have() { command -v "$1" >/dev/null 2>&1; }

daemon_alive() {
  [ -S "$SOCKET" ] && node -e '
    const net = require("node:net");
    const s = net.connect(process.argv[1]);
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("error", () => process.exit(1));
  ' "$SOCKET" 2>/dev/null
}

# True (exit 0) if a build is needed: an entry is missing, or some package's
# source is newer than what was actually built from it. The daemon and the
# desktop app both outlive this script, so "the file exists" alone is not
# enough — the desktop's own stale-build check (see apps/daemon/src/index.ts,
# BUILD_ID) only fires against whatever is on disk *right now*, so a launch
# that skips a needed rebuild ships old code silently, with no error at all.
stale() {
  for f in "$DAEMON_ENTRY" "$DESKTOP_ENTRY" "$RENDERER_BUNDLE"; do
    [ -f "$f" ] || return 0
  done
  find packages apps -path '*/node_modules' -prune -o -path '*/dist' -prune -o \
       -type f \( -name '*.ts' -o -name '*.tsx' \) \
       \( -newer "$DAEMON_ENTRY" -o -newer "$DESKTOP_ENTRY" -o -newer "$RENDERER_BUNDLE" \) \
       -print -quit 2>/dev/null | grep -q .
}

doctor() {
  local ok=0
  for c in node pnpm claude; do
    if have "$c"; then printf '  %-8s %s\n' "$c" "$($c --version 2>&1 | head -1)"
    else printf '  %-8s MISSING\n' "$c"; ok=1; fi
  done
  if [ -x node_modules/.bin/electron ]; then
    printf '  %-8s %s\n' electron "$(node_modules/.bin/electron --version 2>/dev/null || echo present)"
  else
    printf '  %-8s MISSING — run: ./start.sh build\n' electron; ok=1
  fi
  printf '  %-8s %s\n' socket "$(daemon_alive && echo "listening at $SOCKET" || echo 'not running')"
  return $ok
}

# pnpm may skip electron's own postinstall (which downloads the ~230MB binary),
# so a fresh clone can install cleanly and still have no electron to run.
ensure_electron() {
  [ -x node_modules/.bin/electron ] && return 0
  [ -f node_modules/electron/install.js ] || { echo "electron is not installed; run: pnpm install" >&2; return 1; }
  echo "==> downloading the electron binary (first run only)"
  ( cd node_modules/electron && node install.js )
}

build() {
  [ -d node_modules ] || pnpm install
  ensure_electron
  # Order matters: apps bundle these, so a stale dist silently ships old code.
  pnpm --filter @omi/protocol --filter @omi/core --filter @omi/claude-adapter --filter @omi/db build
  pnpm --filter @omi/daemon --filter @omi/desktop build
}

# The app id is `desktopName` in apps/desktop/package.json minus ".desktop";
# Wayland compositors find the window's icon through the entry of that name.
# Both paths point into this checkout, so re-run this after moving it.
install_desktop_entry() {
  local apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps"
  cat >"$apps/oh-my-ide.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=oh-my-ide
Comment=A local-first cockpit for parallel Claude Code sessions
Exec=$PWD/start.sh
Icon=$PWD/apps/desktop/assets/icon.png
StartupWMClass=oh-my-ide
Terminal=false
Categories=Development;IDE;
EOF
  have update-desktop-database && update-desktop-database "$apps" 2>/dev/null || true
  echo "installed $apps/oh-my-ide.desktop"
}

# macOS names a running app after its bundle's Info.plist, and unpackaged that
# bundle is Electron.app — so the Dock and Cmd+Tab say "Electron" whatever the
# window is called, and nothing at runtime can change it. So run from a copy
# that is renamed: clone Electron.app (APFS clones cost no disk), rewrite its
# name, id and icon, and re-sign it, since editing the plist breaks the seal.
# The executable and helper apps keep Electron's names: Electron looks its
# helpers up by those. Rebuilt whenever electron or the icon changes.
MAC_APP="node_modules/.cache/oh-my-ide/oh-my-ide.app"
mac_bundle() {
  local src=node_modules/electron/dist/Electron.app icon=apps/desktop/assets/icon.png
  local plist="$MAC_APP/Contents/Info.plist" stamp="$MAC_APP/.stamp" pb=/usr/libexec/PlistBuddy
  # Keyed on electron's version, not file times: its unzip may keep the archive's.
  local want; want="$($pb -c 'Print :CFBundleVersion' "$src/Contents/Info.plist")"
  if [ "$(cat "$stamp" 2>/dev/null)" = "$want" ] && [ ! "$icon" -nt "$stamp" ]; then
    return 0
  fi
  echo "==> preparing $MAC_APP"
  rm -rf "$MAC_APP"; mkdir -p "$(dirname "$MAC_APP")"
  cp -Rc "$src" "$MAC_APP" 2>/dev/null || { rm -rf "$MAC_APP"; cp -R "$src" "$MAC_APP"; }
  $pb -c 'Set :CFBundleName oh-my-ide' "$plist"
  $pb -c 'Set :CFBundleDisplayName oh-my-ide' "$plist" 2>/dev/null \
    || $pb -c 'Add :CFBundleDisplayName string oh-my-ide' "$plist"
  # A bundle id of its own, or LaunchServices keeps showing what it cached for Electron.
  $pb -c 'Set :CFBundleIdentifier dev.oh-my-ide.app' "$plist"
  # The icon Finder and the Dock show before the app is up; main.ts sets it again at runtime.
  local set; set="$(mktemp -d)/icon.iconset"; mkdir -p "$set"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$icon" --out "$set/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$icon" --out "$set/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o "$MAC_APP/Contents/Resources/electron.icns" || echo "   (icon not converted; keeping Electron's)"
  rm -rf "$(dirname "$set")"
  codesign --force --deep --sign - "$MAC_APP" >/dev/null 2>&1 || echo "   (re-signing failed; the app may refuse to start)"
  touch "$MAC_APP"
  echo "$want" >"$stamp"
}

electron_bin() {
  if [ "$(uname)" = Darwin ]; then mac_bundle >&2 && echo "$MAC_APP/Contents/MacOS/Electron"
  else echo node_modules/.bin/electron; fi
}

case "${1:-run}" in
  -h|--help|help) usage ;;
  doctor) echo "oh-my-ide prerequisites:"; doctor ;;
  build)  build ;;
  install) install_desktop_entry ;;
  daemon)
    stale && build
    ensure_electron || exit 1
    exec env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron "$DAEMON_ENTRY"
    ;;
  status)
    if daemon_alive; then echo "daemon: listening at $SOCKET"; else echo "daemon: not running"; fi
    echo; echo "claude sessions:"
    claude agents --json 2>/dev/null \
      | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{
          for (const s of JSON.parse(b||"[]"))
            console.log(`  ${(s.id ?? s.sessionId.slice(0,8))}  ${String(s.state ?? s.status ?? "?").padEnd(8)} ${s.name ?? ""}`);
        })'
    ;;
  stop)
    # Ask the daemon over its own socket. Never `pkill -f <path>`: that pattern
    # matches any process whose command line contains the path, including this
    # shell and any editor that happens to have the file open.
    if ! daemon_alive; then echo "daemon was not running"; exit 0; fi
    # The socket speaks the length-prefixed framing from @omi/protocol
    # (u32be length, u8 type, payload), NOT newline JSON: a bare JSON line looks
    # like a corrupt frame, and the daemon hangs up on it rather than guessing.
    node -e '
      const net = require("node:net");
      const CONTROL = 0x01;
      const frame = (msg) => {
        const body = Buffer.from(JSON.stringify(msg), "utf8");
        const out = Buffer.allocUnsafe(5 + body.length);
        out.writeUInt32BE(body.length + 1, 0);
        out.writeUInt8(CONTROL, 4);
        body.copy(out, 5);
        return out;
      };
      const s = net.connect(process.argv[1]);
      s.on("connect", () => {
        s.write(frame({ t: "hello", protocol: 1, client: "stop", pid: process.pid }));
        s.write(frame({ t: "rpc", id: 1, method: "daemon.shutdown" }));
      });
      let buf = Buffer.alloc(0);
      s.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 5) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len) break;
          const typ = buf.readUInt8(4);
          const payload = buf.subarray(5, 4 + len);
          buf = buf.subarray(4 + len);
          if (typ !== CONTROL) continue;
          const m = JSON.parse(payload.toString("utf8"));
          if (m.t === "result" && m.id === 1) {
            console.log("daemon stopped (pid " + m.data.pid + ") \u00b7 Claude sessions unaffected");
            process.exit(0);
          }
        }
      });
      s.on("error", () => { console.log("daemon was not running"); process.exit(0); });
      setTimeout(() => { console.error("daemon did not answer; leaving it alone"); process.exit(1); }, 5000);
    ' "$SOCKET"
    ;;
  run)
    if stale; then
      echo "==> building (missing or out of date)"; build
    fi
    ensure_electron || exit 1
    echo "==> starting oh-my-ide (the daemon keeps running after you close the window)"
    bin="$(electron_bin)"
    exec "$bin" apps/desktop
    ;;
  *) usage; exit 1 ;;
esac

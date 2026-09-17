#!/usr/bin/env bash
# Start oh-my-ide.
#
# The daemon outlives this script on purpose: closing the window, quitting the
# app, or killing this shell must never stop a Claude session.
set -euo pipefail

cd "$(dirname "$0")"

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/omi-$(id -u)}/oh-my-ide"
SOCKET="$RUNTIME_DIR/daemon.sock"
DAEMON_ENTRY="apps/daemon/dist/index.cjs"
DESKTOP_ENTRY="apps/desktop/dist/main.cjs"

usage() {
  cat <<'EOF'
usage: ./start.sh [command]

  (no command)   build if needed, then open the app
  build          force a rebuild of all packages
  daemon         run the daemon in the foreground (logs to this terminal)
  status         show whether the daemon is listening, and list sessions
  stop           stop the daemon (Claude sessions keep running)
  doctor         check prerequisites
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

doctor() {
  local ok=0
  for c in node pnpm claude; do
    if have "$c"; then printf '  %-8s %s\n' "$c" "$($c --version 2>&1 | head -1)"
    else printf '  %-8s MISSING\n' "$c"; ok=1; fi
  done
  if [ -x node_modules/electron/dist/electron ]; then
    printf '  %-8s %s\n' electron "$(node_modules/.bin/electron --version 2>/dev/null || echo present)"
  else
    printf '  %-8s MISSING — run: node node_modules/electron/install.js\n' electron; ok=1
  fi
  printf '  %-8s %s\n' socket "$(daemon_alive && echo "listening at $SOCKET" || echo 'not running')"
  return $ok
}

build() {
  [ -d node_modules ] || pnpm install
  # Order matters: apps bundle these, so a stale dist silently ships old code.
  pnpm --filter @omi/protocol --filter @omi/core --filter @omi/claude-adapter --filter @omi/db build
  pnpm --filter @omi/daemon --filter @omi/desktop build
}

case "${1:-run}" in
  -h|--help|help) usage ;;
  doctor) echo "oh-my-ide prerequisites:"; doctor ;;
  build)  build ;;
  daemon)
    [ -f "$DAEMON_ENTRY" ] || build
    exec env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron "$DAEMON_ENTRY"
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
    node -e '
      const net = require("node:net");
      const s = net.connect(process.argv[1]);
      s.on("connect", () => {
        s.write(JSON.stringify({ t: "hello", protocol: 1, client: "stop", pid: process.pid }) + "\n");
        s.write(JSON.stringify({ t: "rpc", id: 1, method: "daemon.shutdown" }) + "\n");
      });
      let b = "";
      s.on("data", (d) => {
        b += d;
        for (const l of b.split("\n")) {
          if (!l.trim()) continue;
          const m = JSON.parse(l);
          if (m.t === "result" && m.id === 1) { console.log("daemon stopped (pid " + m.data.pid + ") \u00b7 Claude sessions unaffected"); process.exit(0); }
        }
      });
      s.on("error", () => { console.log("daemon was not running"); process.exit(0); });
      setTimeout(() => { console.error("daemon did not answer; leaving it alone"); process.exit(1); }, 5000);
    ' "$SOCKET"
    ;;
  run)
    if [ ! -f "$DESKTOP_ENTRY" ] || [ ! -f "$DAEMON_ENTRY" ]; then
      echo "==> first run: building"; build
    fi
    if [ ! -x node_modules/electron/dist/electron ]; then
      echo "electron binary missing; run: node node_modules/electron/install.js" >&2; exit 1
    fi
    echo "==> starting oh-my-ide (the daemon keeps running after you close the window)"
    exec node_modules/electron/dist/electron apps/desktop
    ;;
  *) usage; exit 1 ;;
esac

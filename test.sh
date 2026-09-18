#!/usr/bin/env bash
# Run every check oh-my-ide has, from a fresh clone or a stale checkout.
#
# Brings up what the tests need first (packages, the Electron binary, native
# modules built for its ABI, a fresh build), then runs everything and reports
# each step. Every step runs even if an earlier one failed, so one run shows
# all that is broken. Anything started here — the smoke-test daemon and its
# scratch folder — is stopped and removed on exit, including on failure or ^C.
#
# Never touches your own daemon, database or Claude sessions: the smoke test
# runs a separate daemon on its own socket and database, and the Claude checks
# only read (`claude agents`, a version probe).
set -uo pipefail

cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
usage: ./test.sh

  Sets up dependencies, builds, then runs:
    typecheck      tsc --noEmit for every package and app
    unit tests     vitest
    live CLI       contract tests against the installed claude (skipped without it)
    daemon smoke   boots the built daemon on a scratch socket and database
    lint           biome: lint rules, formatting and import order

  Exits non-zero if setup or any step fails.
EOF
}
case "${1:-}" in
  -h|--help|help) usage; exit 0 ;;
  "") ;;
  *) usage; exit 1 ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }

if [ -t 1 ]; then B=$'\e[1m' G=$'\e[32m' R=$'\e[31m' Y=$'\e[33m' D=$'\e[2m' N=$'\e[0m'
else B='' G='' R='' Y='' D='' N=''; fi

ELECTRON=node_modules/electron/dist/electron
DAEMON_ENTRY=apps/daemon/dist/index.cjs

# ── cleanup ──────────────────────────────────────────────────────────────────

SCRATCH=''
DAEMON_PID=''

stop_daemon() {
  [ -n "$DAEMON_PID" ] || return 0
  if kill -0 "$DAEMON_PID" 2>/dev/null; then
    # SIGTERM runs the daemon's own shutdown, which closes and unlinks the socket.
    kill -TERM "$DAEMON_PID" 2>/dev/null
    for _ in $(seq 50); do kill -0 "$DAEMON_PID" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$DAEMON_PID" 2>/dev/null && kill -KILL "$DAEMON_PID" 2>/dev/null
  fi
  wait "$DAEMON_PID" 2>/dev/null
  DAEMON_PID=''
}

cleanup() {
  stop_daemon
  [ -n "$SCRATCH" ] && rm -rf "$SCRATCH"
  SCRATCH=''
}
trap cleanup EXIT
trap 'echo; echo "${Y}interrupted; cleaning up${N}"; exit 130' INT TERM

# ── steps ────────────────────────────────────────────────────────────────────

RESULTS=()
FAILED=0

# step <name> <command...>
step() {
  local name=$1; shift
  echo
  echo "${B}==> $name${N}"
  local t0=$SECONDS
  if "$@"; then
    RESULTS+=("${G}pass${N}  $name ${D}($((SECONDS - t0))s)${N}")
  else
    RESULTS+=("${R}FAIL${N}  $name ${D}($((SECONDS - t0))s)${N}")
    FAILED=1
  fi
}

skip() { RESULTS+=("${D}skip  $1 ($2)${N}"); }

summary() {
  echo
  echo "${B}==> summary${N}"
  for r in "${RESULTS[@]}"; do echo "  $r"; done
  echo
  if [ "$FAILED" -eq 0 ]; then echo "${G}${B}all checks passed${N}"
  else echo "${R}${B}some checks failed${N}"; fi
}

# ── setup ────────────────────────────────────────────────────────────────────

install_deps() {
  # Reinstall when there is nothing installed, or the lockfile moved since.
  if [ ! -f node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
    pnpm install --frozen-lockfile
  else
    echo "node_modules is up to date with pnpm-lock.yaml"
  fi
}

# pnpm may skip electron's own postinstall, which downloads the binary.
ensure_electron() {
  [ -x "$ELECTRON" ] && { echo "electron binary present"; return 0; }
  [ -f node_modules/electron/install.js ] || { echo "electron is not installed" >&2; return 1; }
  echo "downloading the electron binary (first run only)"
  ( cd node_modules/electron && node install.js )
}

# The daemon runs under Electron, so node-pty and better-sqlite3 must be built
# for its ABI. Rebuild once if they are not, then check again.
ensure_native() {
  pnpm -s verify:abi && return 0
  echo "rebuilding native modules for the Electron ABI"
  pnpm exec electron-rebuild -f -w node-pty,better-sqlite3 -m apps/daemon && pnpm -s verify:abi
}

setup() {
  have node || { echo "node is not installed" >&2; return 1; }
  have pnpm || { echo "pnpm is not installed" >&2; return 1; }
  install_deps && ensure_electron && ensure_native
}

step "setup: dependencies, electron, native modules" setup
if [ "$FAILED" -ne 0 ]; then
  echo "${R}setup failed; nothing else can run${N}" >&2
  summary
  exit 1
fi

# Apps bundle the packages, and typecheck reads their .d.ts, so build first.
step "build" pnpm -s build

# ── checks ───────────────────────────────────────────────────────────────────

typecheck() {
  local ok=0 cfg
  for cfg in packages/*/tsconfig.json apps/*/tsconfig.json; do
    printf '  %-40s' "${cfg%/tsconfig.json}"
    if out=$(pnpm exec tsc --noEmit -p "$cfg" 2>&1); then echo ok
    else echo "${R}errors${N}"; echo "$out" | sed 's/^/    /'; ok=1; fi
  done
  return $ok
}
step "typecheck" typecheck

step "unit tests" pnpm exec vitest run

if have claude; then
  step "live CLI contract (read-only)" \
    env OMI_LIVE=1 pnpm exec vitest run packages/claude-adapter/test/live.test.ts
else
  skip "live CLI contract" "no claude CLI"
fi

smoke() {
  SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/omi-test.XXXXXX") || return 1
  mkdir -p "$SCRATCH/run" "$SCRATCH/data"
  # Own socket and database: XDG_RUNTIME_DIR and XDG_DATA_HOME are exactly what
  # the daemon derives both from.
  local env=(XDG_RUNTIME_DIR="$SCRATCH/run" XDG_DATA_HOME="$SCRATCH/data")
  local sock="$SCRATCH/run/oh-my-ide/daemon.sock"

  env "${env[@]}" ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$DAEMON_ENTRY" >"$SCRATCH/daemon.log" 2>&1 &
  DAEMON_PID=$!

  for _ in $(seq 100); do
    [ -S "$sock" ] && break
    kill -0 "$DAEMON_PID" 2>/dev/null || break
    sleep 0.1
  done
  if [ ! -S "$sock" ]; then
    echo "the daemon did not come up; its log:" >&2
    sed 's/^/    /' "$SCRATCH/daemon.log" >&2
    return 1
  fi
  echo "daemon pid $DAEMON_PID on a scratch socket"

  local rc=0
  env "${env[@]}" OMI_SMOKE_CLAUDE="$(have claude && echo 1 || echo 0)" \
    node tools/scripts/smoke-daemon.mjs || rc=1
  if [ $rc -ne 0 ]; then
    echo "daemon log:"; sed 's/^/    /' "$SCRATCH/daemon.log"
  fi
  cleanup
  return $rc
}
step "daemon smoke test" smoke

# Same check as `pnpm lint`. Most of what it flags, `pnpm exec biome check --write`
# fixes; warnings are shown but do not fail it.
step "lint" pnpm exec biome check .

summary
exit "$FAILED"

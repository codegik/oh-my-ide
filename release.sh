#!/usr/bin/env bash
# Cut a release of oh-my-ide, and own the key that signs it.
#
# A release is a tag. Pushing vX.Y.Z runs .github/workflows/release.yml, which
# builds the Linux tarball, builds the Arch package against it, signs that
# package, and adds it to our pacman repo. See docs/RELEASING.md.
#
# The signing key is the one part of a release that cannot be rebuilt. It lives
# outside the repo, in $KEYRING; CI only ever sees the copy held in the
# PACKAGE_GPG_PRIVATE_KEY secret. Losing it is not a broken build — it means
# every user has to trust a new key by hand before their next upgrade works.
# So `key backup` exists, and `key rotate` asks twice.
set -euo pipefail

cd "$(dirname "$0")"

KEYRING="${XDG_DATA_HOME:-$HOME/.local/share}/oh-my-ide/packaging-gnupg"
SECRET=PACKAGE_GPG_PRIVATE_KEY
KEY_UID='oh-my-ide packaging'

usage() {
  cat <<'EOF'
usage: ./release.sh <command>

  doctor              check everything a release needs and say what is missing

  key                 show the signing key, and whether CI has it
  key new             create the signing key and give CI the private half
  key public [file]   write the public key users import (default: stdout)
  key backup <file>   save the private key somewhere you control
  key rotate          replace the signing key — every user must re-trust it

  X.Y.Z               cut the release: test, bump, commit, tag, push

options for X.Y.Z:
  --no-test           skip ./test.sh (CI still runs it, but after the tag exists)
  --yes               do not ask before pushing
EOF
}

if [ -t 1 ]; then B=$'\e[1m' G=$'\e[32m' R=$'\e[31m' Y=$'\e[33m' D=$'\e[2m' N=$'\e[0m'
else B='' G='' R='' Y='' D='' N=''; fi

have() { command -v "$1" >/dev/null 2>&1; }
die() { echo "${R}error${N}: $*" >&2; exit 1; }
step() { echo "${B}==>${N} $*"; }

gpgk() { gpg --homedir "$KEYRING" --batch "$@"; }

# The fingerprint of the packaging key, or empty if there is no keyring yet.
key_fpr() {
  [ -d "$KEYRING" ] || return 0
  gpgk --list-secret-keys --with-colons 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}'
}

# gh needs no --repo: it reads the remote of the checkout we just cd'd into.
secret_is_set() {
  gh secret list 2>/dev/null | awk '{print $1}' | grep -qx "$SECRET"
}

upload_secret() {
  local fpr="$1"
  gpgk --armor --export-secret-keys "$fpr" | gh secret set "$SECRET"
  echo "  ${G}ok${N} CI holds the private key as $SECRET"
}

confirm() {
  local reply
  printf '%s [y/N] ' "$1"
  read -r reply </dev/tty || reply=''
  case "$reply" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

key_status() {
  local fpr uid
  fpr="$(key_fpr)"
  if [ -z "$fpr" ]; then
    echo "  ${Y}no signing key${N} — run: ./release.sh key new"
    echo "  ${D}until then the release still publishes, but the pacman repo is not updated${D}${N}"
    return 1
  fi
  uid="$(gpgk --list-keys --with-colons "$fpr" 2>/dev/null | awk -F: '/^uid:/ {print $10; exit}')"
  echo "  fingerprint  $fpr"
  echo "  uid          $uid"
  echo "  keyring      $KEYRING"
  if secret_is_set; then
    echo "  CI secret    ${G}$SECRET is set${N}"
  else
    echo "  CI secret    ${Y}$SECRET is missing${N} — run: ./release.sh key new"
    return 1
  fi
}

cmd_key() {
  case "${1:-}" in
    '')
      key_status
      ;;

    new)
      if [ -n "$(key_fpr)" ]; then
        die "a signing key already exists; see ./release.sh key (or key rotate)"
      fi
      have gpg || die "gpg is not installed"
      have gh || die "the GitHub CLI (gh) is not installed"
      local email fpr
      email="$(git config user.email || true)"
      [ -n "$email" ] || die "set git config user.email first, or the key has no address"
      step "creating the packaging key for <$email>"
      install -d -m 700 "$KEYRING"
      # No passphrase: CI cannot type one, and the key's only protection is that
      # it lives nowhere but here and in the repo secret. Sign-only, no expiry —
      # an expired key breaks every user's upgrade, not just the next release.
      gpgk --pinentry-mode loopback --passphrase '' --quiet \
        --quick-gen-key "$KEY_UID <$email>" ed25519 sign never
      fpr="$(key_fpr)"
      echo "  ${G}ok${N} $fpr"
      upload_secret "$fpr"
      echo
      echo "${Y}Back it up now${N}, while it is the only copy that matters:"
      echo "  ./release.sh key backup ~/somewhere-safe/oh-my-ide-packaging.asc"
      ;;

    public)
      local fpr; fpr="$(key_fpr)"
      [ -n "$fpr" ] || die "there is no signing key yet; run: ./release.sh key new"
      if [ -n "${2:-}" ]; then
        gpgk --armor --export "$fpr" >"$2"
        echo "  ${G}ok${N} wrote $2"
      else
        gpgk --armor --export "$fpr"
      fi
      ;;

    backup)
      local fpr dest; fpr="$(key_fpr)"
      [ -n "$fpr" ] || die "there is no signing key yet; run: ./release.sh key new"
      dest="${2:-}"
      [ -n "$dest" ] || die "usage: ./release.sh key backup <file>"
      if [ -e "$dest" ]; then die "$dest exists; pick a path that does not"; fi
      (umask 077 && gpgk --armor --export-secret-keys "$fpr" >"$dest")
      echo "  ${G}ok${N} wrote $dest (mode 600) — it has no passphrase, so treat it as a password"
      ;;

    rotate)
      local fpr; fpr="$(key_fpr)"
      [ -n "$fpr" ] || die "there is no key to rotate; run: ./release.sh key new"
      echo "${Y}Rotating replaces the key every installed copy of oh-my-ide already trusts.${N}"
      echo "Until each user runs pacman-key --add and --lsign-key again, their next"
      echo "pacman -Syu fails on a signature they cannot verify. Rotate only if the"
      echo "current key leaked."
      confirm "rotate the signing key?" || { echo "nothing changed"; exit 1; }
      confirm "really? every user must act before they can upgrade again" || { echo "nothing changed"; exit 1; }
      local aside="$KEYRING.replaced-$(date +%Y%m%d%H%M%S)"
      mv "$KEYRING" "$aside"
      echo "  old keyring kept at $aside ${D}(it still verifies packages already published)${N}"
      cmd_key new
      ;;

    *) usage; exit 1 ;;
  esac
}

cmd_doctor() {
  local bad=0
  step "tools"
  for c in git gh gpg node pnpm; do
    if have "$c"; then printf '  %-8s %s\n' "$c" "$($c --version 2>&1 | head -1)"
    else printf '  %-8s %sMISSING%s\n' "$c" "$R" "$N"; bad=1; fi
  done

  step "github"
  if gh auth status >/dev/null 2>&1; then
    echo "  ${G}ok${N} gh is authenticated"
  else
    echo "  ${R}not authenticated${N} — run: gh auth login"; bad=1
  fi

  step "signing key (the pacman repo)"
  key_status || bad=1

  step "AUR"
  if gh secret list 2>/dev/null | awk '{print $1}' | grep -qx AUR_SSH_PRIVATE_KEY; then
    echo "  ${G}ok${N} AUR_SSH_PRIVATE_KEY is set"
  else
    # Not a failure: the AUR has taken no new accounts since June 2026, so this
    # is expected to be missing. The release skips that job and says so.
    echo "  ${D}AUR_SSH_PRIVATE_KEY is not set; the AUR job will skip${N}"
    echo "  ${D}registration is closed — see docs/RELEASING.md${N}"
  fi

  step "checkout"
  local branch; branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = main ] && echo "  ${G}ok${N} on main" || { echo "  ${Y}on $branch${N}, releases are cut from main"; bad=1; }
  if git diff --quiet && git diff --cached --quiet; then echo "  ${G}ok${N} working tree is clean"
  else echo "  ${Y}working tree has changes${N}"; bad=1; fi
  echo "  version      $(node -p 'require("./package.json").version')"

  [ "$bad" -eq 0 ] && echo && echo "${G}ready to release${N}" || { echo; echo "${Y}fix the above first${N}"; return 1; }
}

cmd_cut() {
  local version="$1" run_tests=1 assume_yes=0
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-test) run_tests=0 ;;
      --yes | -y) assume_yes=1 ;;
      *) usage; exit 1 ;;
    esac
    shift
  done

  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] ||
    die "'$version' is not a version; use X.Y.Z"

  step "preflight"
  have gh || die "the GitHub CLI (gh) is not installed"
  local branch current
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = main ] || die "releases are cut from main, not $branch"
  git diff --quiet && git diff --cached --quiet || die "working tree is not clean"
  # Everything that can be answered locally, before reaching for the network.
  if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
    die "tag v$version already exists"
  fi
  current="$(node -p 'require("./package.json").version')"
  [ "$version" != "$current" ] || die "package.json is already $version"
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ||
    die "main and origin/main differ; pull or push first"
  echo "  ${G}ok${N} $current -> $version from a clean main"

  # Not fatal: the GitHub release and the attached package still go out, only
  # the repo does not. Say it plainly rather than let it be a surprise warning
  # in a log nobody reads.
  if ! secret_is_set; then
    echo "  ${Y}no $SECRET${N} — the pacman repo will NOT be updated by this release"
    echo "  ${D}run ./release.sh key new first if you want it to be${N}"
  fi

  if [ "$run_tests" -eq 1 ]; then
    step "tests"
    ./test.sh || die "tests failed; nothing was changed"
  else
    echo "  ${Y}skipping tests${N}"
  fi

  echo
  echo "${B}About to release $version:${N}"
  echo "  bump package.json, commit, tag v$version, push main and the tag"
  echo "  CI then publishes the tarball, the signed package, and the pacman repo"
  if [ "$assume_yes" -eq 0 ]; then
    confirm "go?" || { echo "nothing changed"; exit 1; }
  fi

  step "bumping and tagging"
  # The first "version" in the root package.json is the package's own, on line 3.
  node -e '
    const fs = require("node:fs");
    const s = fs.readFileSync("package.json", "utf8");
    fs.writeFileSync("package.json", s.replace(/("version":\s*")[^"]+(")/, `$1${process.argv[1]}$2`));
  ' "$version"
  git commit -q -am "Release $version"
  git tag "v$version"

  step "pushing"
  if ! git push origin main "v$version"; then
    echo "${R}the push failed${N}; the commit and tag are local. To undo both:"
    echo "  git tag -d v$version && git reset --hard origin/main"
    exit 1
  fi

  echo
  echo "${G}released $version${N}"
  echo "  watch it:  gh run watch \$(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')"
}

case "${1:-}" in
  -h | --help | help | '') usage; exit 0 ;;
  doctor) cmd_doctor ;;
  key) shift; cmd_key "$@" ;;
  *) cmd_cut "$@" ;;
esac

# Releasing

`./release.sh 0.2.0` does all of this. The rest of this page is what it does and why.

A release is a git tag. Pushing `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which:

1. checks the tag matches `"version"` in the root `package.json`
2. installs, builds and runs the tests (including the native-module ABI check)
3. runs `pnpm package:linux`: it stages the app with its own Electron, boots the
   **packaged** daemon on a scratch socket and database, smoke-tests it over the
   wire, and packs `oh-my-ide-X.Y.Z-linux-x64.tar.gz`
4. publishes a GitHub release with that tarball and its `.sha256`
5. builds the real Arch package from [`packaging/aur/oh-my-ide-bin/PKGBUILD`](../packaging/aur/oh-my-ide-bin/PKGBUILD),
   downloading the tarball from the URL it just published so the URL and checksum are
   proven, signs it, and attaches the `.pkg.tar.zst` to the same release
6. adds that package to our own pacman repo and re-signs the database
7. updates the AUR package `oh-my-ide-bin` — skipped until the AUR takes new accounts

Users get the new version the next time they run `pacman -Syu`.

## Why we host a pacman repo

The AUR has not accepted new registrations since the June 2026 malicious-package
incident. The form answers *"New account registration is temporarily closed"*, there is
no manual queue, and requests on `aur-general` are turned down by the maintainers. So
`oh-my-ide-bin` cannot exist on the AUR yet, however finished the PKGBUILD is.

A repo of our own needs nobody's permission, and it is the better channel anyway: users
get signed binaries and real `pacman -Syu` upgrades instead of a rebuild from source on
every bump. It lives in the assets of one GitHub release, pinned to the **`arch-repo`**
tag — every asset of a release shares a URL prefix, which is all a pacman `Server` needs:

```
https://github.com/codegik/oh-my-ide/releases/download/arch-repo/
├── oh-my-ide.db            → the database pacman asks for (a symlink to the tarball)
├── oh-my-ide.db.tar.gz     ┐
├── oh-my-ide.files.tar.gz  ├ written by repo-add, each with a .sig
├── oh-my-ide.pub             the public half of the signing key
└── oh-my-ide-bin-X.Y.Z-1-x86_64.pkg.tar.zst (+ .sig), one per release
```

That tag is a fixed home for those assets. It does not mark a version, and it is created
with `--latest=false` so it never displaces a real release on the repository front page.

When the AUR reopens, do the [AUR setup](#when-the-aur-reopens) below and the seventh
step starts running. Nothing else changes: both channels build the same PKGBUILD.

## Cutting a release

```sh
./release.sh doctor        # is everything in place?
./release.sh 0.2.0         # test, bump, commit, tag, push
```

`release.sh` cuts only from a clean `main` that matches `origin/main`, runs `./test.sh`
first (`--no-test` skips it), and prints what it is about to do before it pushes anything.
It also says up front if `PACKAGE_GPG_PRIVATE_KEY` is missing, rather than leaving you to
find the skipped repo step in a log afterwards. Everything past the push is the workflow.

By hand it is the same four steps:

```sh
# bump "version" in the root package.json, then:
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

A packaging-only fix — a new dependency in the PKGBUILD, say — still goes out as a tag.
`pkgrel` is pinned to 1 by the workflow, because the repo serves whatever the last tag
built; bumping it by hand would only matter in the AUR, where users rebuild.

## One-time setup

### The signing key

pacman's default `RemoteFileSigLevel` is `Required`, so an unsigned package is one nobody
can install over the network. Until the secret exists the repo step is skipped with a
warning; the GitHub release and the attached `.pkg.tar.zst` still go out.

```sh
./release.sh key new
```

That makes a sign-only ed25519 key — no expiry, because an expired key breaks every
user's upgrade rather than just the next release, and no passphrase, because CI cannot
type one — in `~/.local/share/oh-my-ide/packaging-gnupg`, and sets
`PACKAGE_GPG_PRIVATE_KEY` from it. The keyring is the key's only home besides that
secret, so back it up before you do anything else:

```sh
./release.sh key backup ~/somewhere-safe/oh-my-ide-packaging.asc
```

The key's uid is `oh-my-ide packaging`, with no address attached. That uid ships in
`oh-my-ide.pub` and is what `pacman-key` shows everyone who installs the app, so it names
the project rather than whoever cut the release. Pass your own to
`./release.sh key new '<uid>'` if you want something else there.

| | |
|---|---|
| `./release.sh key` | fingerprint, uid, and whether CI holds it |
| `./release.sh key public` | the public key users import (the workflow publishes this as `oh-my-ide.pub` on every release) |
| `./release.sh key backup <file>` | the private key, armoured, mode 600 |
| `./release.sh key rotate [uid]` | replace it — asks twice, and see below. Keeps the old uid unless you pass one, which is the only way to correct a uid: a revoked one stays visible in the exported key |

Keep the key. Rotating it is not a release detail: every existing install trusts the old
one, so until each user runs `pacman-key --add` and `--lsign-key` again, their next
`pacman -Syu` fails on a signature it cannot verify. Rotate only if the key leaked.

### When the AUR reopens

1. **An AUR account** at https://aur.archlinux.org/register, with an SSH key made just for CI:
   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/aur-oh-my-ide -N '' -C 'oh-my-ide release CI'
   ```
   Paste `~/.ssh/aur-oh-my-ide.pub` into *My Account → SSH Public Key*.
2. **The private key as a repo secret:**
   ```sh
   gh secret set AUR_SSH_PRIVATE_KEY < ~/.ssh/aur-oh-my-ide
   ```

The first push creates the AUR package under the account that owns the key.

## Trying it locally

```sh
pnpm build && pnpm package:linux      # release/oh-my-ide-<version>-linux-x64.tar.gz
```

To build and install the real package from that tarball, copy the PKGBUILD next to it,
point `source=` at the file name, and run `makepkg -si`.

To rehearse the repo itself, run `repo-add` over the package `makepkg` wrote and point a
`Server = file:///path/to/repo` section at the directory.

## Layout

`tools/scripts/package-linux.mjs` lays the tarball out as a `/usr` prefix, so the PKGBUILD
only copies it:

| path | what |
|---|---|
| `bin/oh-my-ide` | launcher ([`packaging/linux/oh-my-ide`](../packaging/linux/oh-my-ide)): borrows the login shell's `PATH` so `claude` is found, logs when started from a menu |
| `lib/oh-my-ide/oh-my-ide` | the Electron binary, renamed |
| `lib/oh-my-ide/resources/app/` | `apps/desktop`: Electron runs it when started with no app path |
| `lib/oh-my-ide/resources/daemon/` | `apps/daemon`, with node-pty and better-sqlite3 for this platform only |
| `share/applications/oh-my-ide.desktop` | launcher entry; its name is the Wayland app id |
| `share/pixmaps/oh-my-ide.png` | icon |

`resources/app` and `resources/daemon` mirror `apps/desktop` and `apps/daemon`, so
`main.ts` finds the daemon at the same relative path in a checkout and in the package.
After an upgrade, the desktop sees that the running daemon's bundle differs from the one
on disk and restarts it, as it does after a rebuild in a checkout.

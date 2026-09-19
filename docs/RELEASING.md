# Releasing

A release is a git tag. Pushing `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which:

1. checks the tag matches `"version"` in the root `package.json`
2. installs, builds and runs the tests (including the native-module ABI check)
3. runs `pnpm package:linux`: it stages the app with its own Electron, boots the
   **packaged** daemon on a scratch socket and database, smoke-tests it over the
   wire, and packs `oh-my-ide-X.Y.Z-linux-x64.tar.gz`
4. publishes a GitHub release with that tarball and its `.sha256`
5. updates the AUR package [`oh-my-ide-bin`](https://aur.archlinux.org/packages/oh-my-ide-bin):
   it sets `pkgver` and `sha256sums` in [`packaging/aur/oh-my-ide-bin/PKGBUILD`](../packaging/aur/oh-my-ide-bin/PKGBUILD),
   builds the package from the published URL to prove it, and pushes `PKGBUILD` and `.SRCINFO`

Users get the new version the next time they run `yay -Syu`.

## Cutting a release

```sh
# bump "version" in the root package.json, then:
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

To fix only the packaging, with no app change (a new dependency in the PKGBUILD, say),
edit the PKGBUILD here, then bump `pkgrel` by hand in the AUR repo. The next tag resets
it to 1.

## One-time setup

Nothing is published until these are done. Until then the AUR step is skipped with a
warning, and the GitHub release still goes out.

1. **Pick a license.** The PKGBUILD says `LicenseRef-unknown` because the repo has no
   `LICENSE` file. Add one, then set `license=` in the PKGBUILD to its SPDX id (for example
   `MIT`). If the license text names the copyright holder (MIT, BSD, ISC), Arch also wants
   the file installed:
   `install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"`, which means
   putting `LICENSE` in the tarball from `tools/scripts/package-linux.mjs`.
2. **An AUR account** at https://aur.archlinux.org/register, with an SSH key made just for CI:
   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/aur-oh-my-ide -N '' -C 'oh-my-ide release CI'
   ```
   Paste `~/.ssh/aur-oh-my-ide.pub` into *My Account → SSH Public Key*.
3. **The private key as a repo secret:**
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

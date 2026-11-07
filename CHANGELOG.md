# Changelog

## 0.2.0 (2026-11-08)

### New commands

- **`updiff fetch <app> [version]`** compares an installed app with an earlier
  release, so no baseline snapshot is needed. It finds past versions in the
  Homebrew cask history, downloads the release and checks it against the cask's
  SHA-256 before diffing. `--list` shows the versions it can fetch.
- **`updiff pkg <file.pkg> [other.pkg]`** shows what an installer package would
  do before you run it: its scripts, Distribution JavaScript, the apps it
  installs, launch daemons and agents (including SMAppService plists inside
  apps), kernel and system extensions, privileged helpers, its signature and the
  Gatekeeper verdict. With two packages it diffs them, with line diffs of the
  scripts. The package is expanded with `pkgutil`; no script ever runs.
- **`updiff extensions [list|check]`** covers things that update silently:
  Chrome, Brave, Edge, Arc, Vivaldi and other Chromium browsers per profile,
  Firefox, and VS Code, Cursor, Windsurf and VSCodium extensions. It flags new
  permissions, access to every website, a changed update server, editor
  extensions that start with every window or install other extensions, new npm
  packages, native code and new domains.
  `updiff check --extensions` runs it with the app check, and the LaunchAgent
  now does this.

### New findings

- **Gatekeeper and notarization:** the app is no longer notarized, Gatekeeper
  rejects it or can no longer verify its signature, the distribution changed
  (Developer ID ↔ Mac App Store), or the notarization ticket is no longer
  stapled. Turn the check off with `--no-gatekeeper`.
- **Sparkle feeds set in code:** an update feed URL compiled into the app (not in
  `Info.plist`) that changes.
- **Mac App Store:** an app that moves to or from the App Store, and a note when
  binaries are FairPlay-encrypted, which hides their strings.

### Fixes

- Chrome-style bundles that keep an old `Versions/<n>` folder next to
  `Versions/Current` no longer show the old helpers as new.
- Universal binaries are read from their arm64 slice, in full.
- Files that are lists of domains (a public suffix list, a block list) no longer
  flood the host report.
- bzip2-compressed disk images are recognised.

## 0.1.1 (2026-11-08)

- Published to npm as `@intincrab/updiff`; the command is still `updiff`.
- The release tarball keeps the `updiff-X.tgz` name for the Homebrew tap.

## 0.1.0 (2026-11-07)

- First release: `scan`, `snapshot`, `diff`, `check`, `list` and the
  LaunchAgent.

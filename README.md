# updiff

See what a macOS app update **actually changed inside the app**: new permissions,
privacy prompts, background items, helper programs, bundled packages and the hosts
the code mentions. It reads the bundle itself, not the changelog.

This is the output for the test suite's fixture "update", trimmed:

```
$ updiff check
Fixture  1.0.0 (100) → 2.0.0 (200)
com.example.updiff-fixture
6 high · 6 notable · 2 info

HIGH
  - App dropped the hardened runtime
  - Helper app Fixture Helper.app dropped the hardened runtime
  + Can now ask for access to Camera
      NSCameraUsageDescription: “Fixture can now see you.”
  + App can now use the camera
      com.apple.security.device.camera = true
  + New background agent: com.example.updiff-fixture.agent.plist
      label com.example.updiff-fixture.agent · runs Contents/MacOS/Fixture · starts at login · kept alive
  + New login item: FixtureLauncher.app

NOTABLE
  + New native Node module: fastnative.node
  + Opens fixture-auth:// links
  ~ Electron 33.2.0 → 35.1.0
  + 1 new bundled npm package
      ai-plugin@0.3.0
  + New domain newvendor.io
      native.newvendor.io, telemetry.newvendor.io
      at …/fastnative.node, Contents/Resources/app.asar:dist/ai.js
  + New domain tracker.ai
      events.tracker.ai (seen only as a bare string, not in a URL)
```

A real run: Chrome 154 → 156 with `--deep` shows the new `perplexity.ai` and
`chromestorage.goog` hosts that 156 added to its framework, and nothing else of note.

Updiff never runs the app and never connects to the network.

## Install

Needs macOS and Node.js 20 or newer.

```bash
git clone https://github.com/intincrab/updiff.git && cd updiff
npm install
npm run build
npm link        # puts `updiff` on your PATH
```

## Use

```bash
updiff snapshot                    # baseline every app in /Applications and ~/Applications
updiff check                       # later: snapshot what changed and print what's different
updiff diff Slack                  # the two newest snapshots of one app
updiff diff Old.app New.app        # any two bundles, snapshot files or stored apps
updiff scan "Google Chrome"        # one-off summary of a single app
updiff list                        # what's stored
```

Run it automatically after every update:

```bash
updiff agent install               # a LaunchAgent that runs `check --notify` when /Applications changes
updiff agent status
updiff agent uninstall
```

The agent watches your app folders. When something changes it waits until the update
has finished writing, then shows a notification for each app it found changed. Reports go
to `~/.updiff/reports/` and the log to `~/.updiff/agent.log`. Use `--dry-run` to see the
LaunchAgent first.

Useful options: `--format md|json`, `--min-severity notable`, `--out report.md`,
`--deep` (also read framework binaries, where apps like Chrome keep their code), and
`--home <dir>` (default `~/.updiff`, or `$UPDIFF_HOME`).

## What it checks

| | High | Notable | Info |
|---|---|---|---|
| Signing | different developer team, no longer developer-signed, hardened runtime removed | signing certificate changed | hardened runtime added |
| Entitlements, for every executable | camera, microphone, location, contacts, Apple Events, library validation off, Endpoint Security, network extensions…; sandbox removed | any other entitlement; new values in group or domain lists | removals |
| Privacy prompts (`NS…UsageDescription`) | new prompt | | changed or removed wording |
| Background | new LaunchAgent/LaunchDaemon, login item, privileged helper, system extension | changed background item | removals |
| Updater (Sparkle) | feed URL moved, signing key changed | feed added or removed | |
| Network | App Transport Security allows plain HTTP | new ATS exception domains | |
| Code | | new helper apps, XPC services, app extensions, plug-ins, executables, native Node modules, frameworks | framework versions, removals |
| Electron | | Electron version, new bundled npm packages | package version bumps and removals |
| Hostnames | | new domains | new hosts under known domains, domains no longer mentioned |
| URL schemes | | new `scheme://` handlers | removals |

## About hostnames

Updiff collects hostnames from URLs (`https://`, `wss://`, …) and from quoted strings
like `"events.vendor.io"` in executables, the Electron `app.asar` and resource files.
**A hostname in the code is not proof that the app connects to it.** It is a lead to
check, for example with a network monitor.

To keep reports quiet, it skips:
- source maps, READMEs, licences and the `package.json` files inside `node_modules`
- XML namespaces and reserved names (`example.com`, `localhost`, `.test`)
- files with more than 1,000 bare hostnames, such as a bundled Public Suffix List.
  These are reported as a warning.

Frameworks are skipped unless you pass `--deep`.

## How it works

See [docs/DESIGN.md](docs/DESIGN.md). In short:
- **Reading the bundle:** plists through `plutil`; signatures and entitlements through
  `codesign`; `app.asar` through a built-in reader.
- **Matching code between versions:** framework `Versions/<x>/` folders are normalised,
  stale versions beside `Versions/Current` are ignored, and renamed helpers are matched
  by bundle id.
- **Fingerprints:** a hash of `_CodeSignature/CodeResources`, so `check` skips apps
  that haven't changed. A repeat check of 28 apps takes about 0.1 s.

## Develop

```bash
npm test          # unit tests plus integration tests on real, ad-hoc-signed fixture apps
npm run typecheck
npm start -- scan Ghostty   # run from source (Node 22.18+ runs the TypeScript directly)
```

The integration tests build two versions of a small Electron-shaped app with clang,
`@electron/asar` and `codesign`. They then check every planted change through the
library and the CLI. Without a C compiler, the binary-hostname assertions are skipped.

## Limits

- Static only: code downloaded at runtime (plugins, remote config) isn't in the bundle.
- Hostname extraction is pattern matching. Hosts built at runtime from pieces are
  missed.
- Not covered yet: Mac App Store receipt changes, Safari web extensions' manifests,
  browser extension policies, and installer `.pkg` scripts.

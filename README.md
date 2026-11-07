# updiff

**See what a macOS app update actually changed: in the app, not in the changelog.**

![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Release notes say "bug fixes and improvements". The update itself might ask for your
camera, register something that starts at login, ship a new helper that runs as root,
bundle a new analytics package, or start talking to a new service. updiff takes a
snapshot of each app and, after every update, shows you exactly what changed inside it.

- **Read-only.** It never runs the app, never changes it and never touches the network.
- **Local.** Snapshots and reports stay in `~/.updiff`. Nothing is uploaded.
- **Fast.** The first snapshot of 28 apps took 11 s on an Apple Silicon Mac; later checks
  skip unchanged apps and take about 0.1 s.

## What it looks like

A real update, Google Chrome 154 → 156, checked with `--deep`:

```text
$ updiff check --deep
Google Chrome  154.0.8037.58 (8037.58) → 156.0.8078.80 (8078.80)
com.google.Chrome
0 high · 2 notable · 6 info

NOTABLE
  + New domain chromestorage.goog
      chromestorage.goog
      at Contents/Frameworks/Google Chrome Framework.framework/Versions/156.0.8078.80/Google Chrome Framework
  + New domain perplexity.ai
      frontend-cdn.perplexity.ai, suggest.perplexity.ai, www.perplexity.ai
      at Contents/Frameworks/Google Chrome Framework.framework/Versions/156.0.8078.80/Google Chrome Framework

INFO
  ~ Google Chrome Framework.framework 154.0.8037.58 → 156.0.8078.80
  + New host under chromium.org
      g-issues.chromium.org
  + New host under google.com
      groups.google.com
  + New host under googleapis.com
      federatedcompute-pa.googleapis.com
  …

Report: ~/.updiff/reports/com.google.Chrome/…__154.0.8037.58__to__156.0.8078.80.md
```

A quiet update looks like that. A worrying one looks like this. This is the "update" the
test suite builds, trimmed:

```text
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
  …
```

`+` added, `-` removed, `~` changed. In a terminal, high findings are red, notable
findings yellow and info cyan.

## Quick start

updiff isn't on npm yet. Install it from source; you need macOS and Node.js 20 or newer.

```bash
git clone https://github.com/intincrab/updiff.git
cd updiff
npm install && npm run build && npm link
```

Take a baseline of every app, then check after updates:

```bash
updiff snapshot          # once, before the next round of updates
updiff check             # after updating: shows what changed in each updated app
```

Or let it check by itself:

```bash
updiff agent install     # runs `updiff check` whenever your app folders change
```

The agent waits until an update has finished writing, then posts a notification titled
"Updiff: Google Chrome 156.0.8078.80" that says "0 high, 2 notable changes". The full
report is saved in `~/.updiff/reports/`.

## Commands

| Command | What it does |
|---|---|
| `updiff scan <app>` | Summarise one app: signing, sandbox, entitlements, privacy prompts, nested code, background items, Electron and hostnames. Stores nothing. |
| `updiff snapshot [app…]` | Store a snapshot of each app, or of every app when none are named. Unchanged apps are skipped. |
| `updiff check` | Snapshot every app that changed since its last snapshot and print what's different. Reports are saved as Markdown. |
| `updiff diff <app>` | If the installed app changed since its newest snapshot, compare the two; otherwise compare its two newest snapshots. |
| `updiff diff <a> <b>` | Compare any two things: `.app` bundles, snapshot `.json` files or stored apps. Good for a downloaded beta against the installed version. |
| `updiff list [app]` | List stored apps, or one app's snapshots. |
| `updiff agent install \| uninstall \| status` | Manage the LaunchAgent that runs `check` after updates. |

`<app>` can be a path (`/Applications/Slack.app`), a name from your Applications folders
(`Slack`, `"Google Chrome"`) or a stored bundle id (`com.tinyspeck.slackmacgap`).

## Options

| Option | Applies to | Effect |
|---|---|---|
| `--format text\|md\|json` | all | Output format. JSON is for scripts. |
| `--min-severity high\|notable\|info` | `diff`, `check` | Hide less important findings. |
| `--out <file>` | `scan`, `diff` | Write the result to a file. |
| `--deep` | scanning | Also search framework binaries for hostnames. Needed for apps like Chrome that keep their code in a framework. |
| `--full` | text output | Don't shorten long details. |
| `--force` | `snapshot` | Store a snapshot even if nothing changed. |
| `--apps-dir <dir>` | all | Where to look for apps. Repeatable; the default is `/Applications` and `~/Applications`. |
| `--home <dir>` | all | Data folder. Default `~/.updiff`, or `$UPDIFF_HOME`. |
| `--keep <n>` | `snapshot`, `check` | Snapshots kept per app (default 10). |
| `--notify` | `check` | Post a notification for each updated app. |
| `--settle <seconds>` | `check` | Wait until no app has changed for this long before scanning. |
| `--quiet`, `--no-color` | all | Print less; plain text. `NO_COLOR` is respected too. |
| `--interval <seconds>` | `agent install` | Fallback timer between checks (default 21600, i.e. 6 hours). |
| `--dry-run` | `agent install` | Print the LaunchAgent without installing it. |
| `--no-load` | `agent install`, `agent uninstall` | Write or remove the file but don't call `launchctl`. |

Exit codes: `0` success, `2` usage error (unknown app, bad option), `1` unexpected error.

## What it checks

| | High | Notable | Info |
|---|---|---|---|
| **Signing** | different developer team; no longer developer-signed; hardened runtime removed | signing certificate changed | hardened runtime added |
| **Entitlements**, for every executable in the bundle | camera, microphone, location, contacts, calendars, photos, Apple Events, USB, Bluetooth, library validation off, debugging, Endpoint Security, network extensions, sandbox exceptions; sandbox removed | any other new entitlement; new values in app groups, keychain groups or associated domains | removals |
| **Privacy prompts** (`NS…UsageDescription`) | a new prompt | | reworded or removed prompts |
| **Background** | new LaunchAgent or LaunchDaemon, login item, privileged helper, system extension | changed background item | removals |
| **Updater** (Sparkle) | update feed moved; update signing key changed | feed added or removed | |
| **Network** | App Transport Security allows plain HTTP | new ATS exception domains | |
| **Code** | | new helper apps, XPC services, app extensions, plug-ins, executables, native Node modules, frameworks | framework versions; removals |
| **Electron** | | Electron version; new bundled npm packages | package version changes and removals |
| **Hostnames** | | new domains | new hosts under domains already present; domains no longer mentioned |
| **URL schemes** | | new `scheme://` handlers | removals |
| **Identity** | the two sides are different apps | Dock icon shown or hidden | version, minimum macOS, size |

Code inside a bundle is matched between versions by its path and, if that fails, by its
bundle id. So a renamed helper isn't reported as removed plus added, and Chrome's
`Versions/154…` → `Versions/156…` framework folders count as the same thing.

## About hostnames

updiff finds hostnames in URLs (`https://`, `wss://`, …) and in quoted strings like
`"events.vendor.io"`. It looks in executables, native modules, Electron `app.asar`
archives and text resources, and reports them grouped by domain.

> **A hostname in the code is not proof that the app connects to it.** It shows what the
> code mentions: API endpoints, links, sometimes dead code. Treat a new domain as a lead
> and confirm it with a network monitor such as Little Snitch or LuLu.

To keep reports readable, it ignores:
- source maps, READMEs, licences and the `package.json` files inside `node_modules`
- XML namespaces and reserved names (`www.w3.org`, `example.com`, `localhost`, `*.test`)
- bare strings whose ending reads like a file type (`Foo.app`, `README.md`, `build.sh`)
- any file with more than 1,000 bare hostnames, which is a bundled list rather than code
  (Discord's main bundle carries one with about 6,100 entries). These are named in a
  warning.

Framework binaries are only searched with `--deep`. Electron apps keep their own code in
`app.asar`, which is always searched.

## Where things are stored

```text
~/.updiff/
├── snapshots/<bundle id>/<time>__<version>__<build>.json   one JSON file per snapshot
├── reports/<bundle id>/<time>__<from>__to__<to>.md         one report per detected update
└── agent.log                                               output of background checks
```

A snapshot records a fingerprint of the app's code signature seal
(`_CodeSignature/CodeResources`), so an unchanged app is recognised without a rescan.
Delete the folder at any time to start over.

## Privacy and safety

- updiff reads files and runs Apple's own tools:
  - `plutil` to read plists
  - `codesign` to read signatures and entitlements
  - `osascript` for notifications
  - `launchctl` for the agent
- It never runs app code.
- It never makes network requests, and nothing it records leaves your Mac.
- The agent is a LaunchAgent in your user account (`dev.updiff.check`). It runs with your
  permissions, at low priority. `updiff agent install --dry-run` shows exactly what it
  installs; `updiff agent uninstall` removes it.

## Limitations

- **Static only.** Plugins, models or config that an app downloads after launch aren't in
  the bundle, so updiff can't see them.
- **Hostnames are pattern-matched.** Hosts assembled at runtime (`"api." + region + ".x.com"`)
  are missed, and a mentioned host is not necessarily contacted.
- **The first update needs a baseline.** Run `updiff snapshot` before updating. You can
  also diff a downloaded copy of the old version against the installed one.
- **Not covered yet:** Mac App Store receipts, Safari web extension manifests, managed
  browser policies and installer `.pkg` scripts.

## How it works

Every scan, a few steps:
1. Read `Info.plist` with `plutil`.
2. Walk the bundle without following symlinks, and skip framework versions that
   `Versions/Current` doesn't point to.
3. Classify nested code by type and location.
4. Read each item's signature and entitlements with `codesign`.
5. Read `app.asar` with a built-in parser, without extracting it.
6. Search text and the arm64 slice of each binary for hostnames.

The diff compares two snapshots and assigns each change a severity. The full design and
the reasoning behind the rules are in [docs/DESIGN.md](docs/DESIGN.md).

## Development

```bash
npm install
npm test                    # unit + integration tests
npm run typecheck
npm run build               # compiles to dist/
npm start -- scan Ghostty   # run from source (Node 22.18+ runs the TypeScript directly)
```

The integration tests build two versions of a small Electron-style app with clang,
`@electron/asar` and `codesign`. They plant permission, background, package and network
changes, then check that each one is reported at the right severity, both through the
library and through the commands. Without a C compiler, the assertions about hostnames
inside binaries are skipped.

## License

[MIT](LICENSE)

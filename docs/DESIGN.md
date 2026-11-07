# Updiff design

Updiff answers one question: **what did this app update actually change inside the
app?** Changelogs describe features. Updiff reads the bundle itself and reports the
changes that affect privacy and security: permissions, privacy prompts, things that
run in the background, new helper programs, bundled code and the hosts the code
mentions.

## Scope (v0.1)

- macOS `.app` bundles. Native apps and Electron apps.
- Static inspection only. Updiff never runs the app and never connects to the
  network.
- A local store of snapshots, a diff between any two snapshots or bundles, and an
  optional LaunchAgent that checks after every update.

Out of scope for now: runtime network monitoring, Windows and Linux, a GUI, and AI
summaries.

## What a snapshot records

| Area | Source | Why it matters |
|---|---|---|
| Identity | `Info.plist` | Version, build and bundle id |
| Privacy prompts | `NS*UsageDescription` keys | A new key means the app can now ask for the camera, the microphone, contacts… |
| URL schemes | `CFBundleURLTypes` | New ways for web pages and other apps to open it |
| App Transport Security | `NSAppTransportSecurity` | Plain-HTTP exceptions |
| Updater | Sparkle `SUFeedURL`, `SUPublicEDKey` | Where updates come from and the key that verifies them |
| Signing | `codesign -dvvv` | Team id, signing authority, hardened runtime |
| Entitlements | `codesign -d --entitlements - --xml`, for every piece of nested code | What each executable is allowed to do |
| Nested code | Walk of the bundle | Login items, privileged helpers, system extensions, app extensions, XPC services, helper apps, frameworks, loose executables |
| Background items | `Contents/Library/LaunchAgents` and `LaunchDaemons` | Things registered through `SMAppService` that run without the app |
| Electron | `Electron Framework.framework`, `app.asar` | Electron version, bundled npm packages, native modules |
| Hosts | URLs and quoted hostnames in executables, `app.asar` and resource text files | New services the code mentions |

Nested code is matched between versions by a normalised path. `Versions/<anything>/`
becomes `Versions/*/`, so a framework that moves from `Versions/154.0…` to
`Versions/156.0…` is the same item.

## Hostnames

- A host comes from a URL (`https://`, `wss://`, …) or from a quoted literal such as
  `"events.vendor.io"`. Literals need a common top-level domain and skip names that
  clash with file extensions (`.app`, `.md`, `.sh`…). Reports mark them "string only".
- XML namespace hosts (`www.w3.org`, `schemas.xmlsoap.org`…) and reserved names
  (`localhost`, `example.com`, `.test`…) are ignored.
- Hosts are grouped by registrable domain, using a small built-in suffix list.
- Frameworks are skipped unless `--deep` is set. Electron apps keep their logic in
  `app.asar`, which is always scanned. Source maps, docs, licences and the
  `package.json` files inside `node_modules` are skipped, because they are mostly
  repository links.
- **A hostname in the code does not prove a connection.** Every report says so.

## Severities

- **high**: needs a human look. Examples:
  - a sensitive entitlement is added (camera, microphone, Apple Events, library
    validation off…)
  - a privacy prompt is added
  - a background item, login item, privileged helper or system extension is added
  - the team id changes, or the app is no longer properly signed
  - hardened runtime is removed
  - sandboxing is dropped
  - arbitrary loads are allowed
  - the updater key or the update feed changes
- **notable**: worth knowing. Examples: other new entitlements, new URL schemes, new
  helpers, XPC services or app extensions, new domains, new bundled npm packages,
  new native modules, an Electron version change.
- **info**: removals, version bumps, new hosts under domains that were already
  there, size changes.

## Store

`$UPDIFF_HOME` (default `~/.updiff`):

```
snapshots/<bundle id>/<taken at>__<version>__<build>.json
reports/<bundle id>/<from>__to__<to>.md
agent.log
```

A snapshot carries a fingerprint: the SHA-256 of
`Contents/_CodeSignature/CodeResources`, which lists a hash of every sealed file, or
of `Info.plist` plus the main executable's size when there is no signature. `check`
skips an app whose fingerprint has not changed, so a repeat run takes seconds.

## Commands

```
updiff scan <app>                 inspect one bundle, store nothing
updiff snapshot [app…]            store snapshots (every app in the app folders by default)
updiff diff <app|bundle id>       diff the two latest snapshots of an app
updiff diff <a> <b>               diff two bundles or snapshot files
updiff check [--notify]           snapshot changed apps and report what changed
updiff list [app]                 list stored snapshots
updiff agent install|uninstall|status
```

Formats: `text` (default), `md`, `json`. Use `--min-severity` to hide noise.

## Testing

- Unit tests for the plist parser, the asar reader (against archives built by
  `@electron/asar`), host extraction, domain grouping and the diff rules.
- Integration tests build two real, ad-hoc-signed fixture apps: v1 and an "update"
  that adds a camera entitlement, a privacy prompt, a login item, a LaunchAgent, an
  `app.asar` with a new telemetry host, an npm package and a native module, and
  drops hardened runtime. They then check every finding through the library and the
  CLI (`snapshot`, `diff`, `check`, `agent --dry-run`).
- Real-world runs: snapshot every installed app, then diff the Chrome 154 bundle
  from the Homebrew download cache against the installed Chrome 156.

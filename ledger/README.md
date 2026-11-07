# updiff ledger

A public record of what changed inside each new release of popular Mac apps. It follows
the apps in [`apps.json`](apps.json) through their Homebrew casks. When a cask moves to
a new version, the ledger:
1. downloads the installer, verifying its SHA-256 when the cask pins one
2. takes the app out without running anything
3. scans it with updiff
4. compares the result with the previous release

Reports are committed to [`data/`](data) as JSON, and a static site with an Atom feed is
built from them.

## Running it locally

```bash
npm run ledger -- update                       # check every tracked app
npm run ledger -- update --only slack,zoom     # or just some
npm run ledger -- backfill slack 4.52.1        # record an older release as the baseline
npm run ledger -- site --out ledger/site       # build the site
npm run ledger -- status
```

- **First run:** the first scan of each app is only a baseline; reports begin at the next
  release. To get a report straight away, use `backfill` to record an older version
  first. Its download URL is derived from the cask's current one, or you can pass
  `--url`.
- **Installer formats:** disk images are mounted read-only and detached again. Zips and
  tarballs are extracted. Packages are expanded with `pkgutil --expand-full`; their
  scripts are written to disk but never run. Downloads and extracted files live in a
  temporary folder that is deleted after each app.

## In GitHub Actions

[`.github/workflows/ledger.yml`](../.github/workflows/ledger.yml) runs once a day and can
be started by hand, optionally limited to some casks. It:
1. runs the tests
2. scans new releases
3. commits `ledger/data`
4. publishes the site to GitHub Pages

To turn it on:
1. Make the repository public. The jobs skip themselves on a private repository: macOS
   runner minutes there are billed at ten times the Linux rate, and Pages needs a paid
   plan for private repositories.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Actions → Ledger → **Run workflow** for the first run. It takes baselines of every
   app, which means downloading roughly 5 GB of installers and about 30–45 minutes on
   the runner.

The site is then served at `https://<owner>.github.io/<repo>/`.

## Data layout

```text
ledger/data/
├── apps/<cask>/state.json          releases scanned, newest first; last error if any
├── apps/<cask>/snapshot.json.gz    the latest snapshot, for the next comparison
├── apps/<cask>/reports/*.json      one report per update: both releases + the diff
└── last-run.json                   what the last run did
```

## Adding an app

Add its Homebrew cask token to `apps.json`. Set `"deep": true` for Chromium-based
browsers and other apps that keep their code in a framework, so their framework binaries
are searched for hostnames too. A change to `deep` re-baselines the app instead of
reporting every framework host as new.

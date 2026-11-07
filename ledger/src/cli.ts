#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildSite } from './site.ts';
import { appsFile, LedgerStore, loadTrackedApps, type TrackedApp } from './store.ts';
import { backfill, updateAll, type Outcome } from './update.ts';

const USAGE = `updiff ledger: follow Mac apps through Homebrew and record what each release changed

Usage:
  npm run ledger -- update [--only a,b]         Scan new releases and write reports
  npm run ledger -- backfill <cask> <version>   Record an older release as the baseline
                    [--url <installer url>] [--force]
  npm run ledger -- site [--out dir] [--base-url url] [--repo-url url]
                                                Build the static site
  npm run ledger -- status                      Show what's recorded

Options:
  --data <dir>     Data folder (default ledger/data, or $LEDGER_DATA)
  --apps <file>    Tracked apps (default ledger/apps.json, or $LEDGER_APPS)
  --max-mb <n>     Largest download accepted (default 3072)
  --work <dir>     Scratch folder for downloads (default the system temp folder)
`;

function line(s: string): void {
  process.stdout.write(`${s}\n`);
}

async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      only: { type: 'string' },
      url: { type: 'string' },
      force: { type: 'boolean' },
      out: { type: 'string' },
      'base-url': { type: 'string' },
      'repo-url': { type: 'string' },
      data: { type: 'string' },
      apps: { type: 'string' },
      'max-mb': { type: 'string' },
      work: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (v.help || !command) {
    process.stdout.write(USAGE);
    return command || v.help ? 0 : 2;
  }
  const store = new LedgerStore(v.data ? resolve(v.data) : undefined);
  const apps = await loadTrackedApps(v.apps ? resolve(v.apps) : appsFile());
  const maxBytes = Number(v['max-mb'] ?? 3072) * 1024 * 1024;
  const common = { store, maxBytes, workRoot: v.work ? resolve(v.work) : undefined, log: line };

  if (command === 'update') {
    let selected: TrackedApp[] = apps;
    if (v.only) {
      const want = v.only.split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = want.filter((w) => !apps.some((a) => a.cask === w));
      if (unknown.length) throw new Error(`Not in the tracked apps: ${unknown.join(', ')}`);
      selected = apps.filter((a) => want.includes(a.cask));
    }
    const startedAt = new Date().toISOString();
    const outcomes = await updateAll(selected, common);
    await store.writeRunLog({ startedAt, finishedAt: new Date().toISOString(), outcomes });
    const count = (s: Outcome['status']): number => outcomes.filter((o) => o.status === s).length;
    line(
      `Checked ${outcomes.length} apps: ${count('updated')} updated, ${count('baseline')} new baselines, ${count('unchanged')} unchanged, ` +
        `${count('same-build') + count('rebaselined')} other, ${count('failed')} failed.`,
    );
    // A failed app is recorded in its state; only fail the run when nothing worked at all.
    return count('failed') === outcomes.length && outcomes.length > 0 ? 1 : 0;
  }

  if (command === 'backfill') {
    const [cask, version] = args;
    if (!cask || !version) throw new Error('backfill needs a cask and a version.');
    const app = apps.find((a) => a.cask === cask) ?? { cask };
    const outcome = await backfill(app, version, { ...common, url: v.url, force: v.force === true });
    line(`${cask}: baseline ${outcome.version} recorded in ${(outcome.ms / 1000).toFixed(1)} s. The next update will compare against it.`);
    return 0;
  }

  if (command === 'site') {
    const out = resolve(v.out ?? 'ledger/site');
    const res = await buildSite(store, apps, { out, baseUrl: v['base-url'], repoUrl: v['repo-url'] ?? 'https://github.com/intincrab/updiff' });
    line(`Wrote ${res.pages} pages (${res.reports} reports) to ${out}`);
    return 0;
  }

  if (command === 'status') {
    for (const app of apps) {
      const s = await store.loadState(app.cask);
      const reports = s?.history.filter((h) => h.report).length ?? 0;
      line(
        `${app.cask.padEnd(20)} ${(s?.latest?.version ?? '—').padEnd(28)} ${String(s?.history.length ?? 0).padStart(3)} releases ${String(reports).padStart(3)} reports` +
          (s?.lastError ? `  last error: ${s.lastError.message}` : ''),
      );
    }
    return 0;
  }

  throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: Error) => {
    process.stderr.write(`ledger: ${err.message}\n`);
    process.exitCode = 1;
  },
);

import { existsSync, realpathSync, statSync } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_LABEL, agentPlist, agentStatus, installAgent, notify, uninstallAgent } from './agent.ts';
import { quickFingerprint, readIdentity, scanBundle, type ScanOptions } from './bundle.ts';
import { diffSnapshots, filterBySeverity } from './diff.ts';
import { renderJson, renderMarkdown, renderScan, renderText } from './report.ts';
import { Store } from './store.ts';
import type { DiffReport, Severity, Snapshot } from './types.ts';
import { mapLimit } from './util.ts';
import { TOOL_VERSION } from './version.ts';

export interface IO {
  out(s: string): void;
  err(s: string): void;
  color: boolean;
}

export const USAGE = `updiff ${TOOL_VERSION}: see what a macOS app update actually changed

Usage:
  updiff scan <app>                 Inspect one app; nothing is stored
  updiff snapshot [app...]          Store snapshots (all apps when none are given)
  updiff diff <app>                 Compare the two newest snapshots of an app
  updiff diff <a> <b>               Compare two apps, snapshot files or stored apps
  updiff check                      Snapshot apps that changed and report the differences
  updiff list [app]                 List stored snapshots
  updiff agent install|uninstall|status
                                    Run 'check' automatically after app updates

<app> is a path to an .app, an app name in your Applications folders ("Slack"),
or a bundle id that has stored snapshots ("com.tinyspeck.slackmacgap").

Options:
  --format text|md|json             Output format (default text)
  --min-severity high|notable|info  Hide less important findings (default info)
  --out <file>                      Write the report to a file
  --full                            Do not shorten long details in text output
  --deep                            Also scan framework binaries for hostnames (slower)
  --force                           Store a snapshot even if the app has not changed
  --home <dir>                      Data folder (default ~/.updiff, or $UPDIFF_HOME)
  --apps-dir <dir>                  Folder to look for apps (repeatable; default
                                    /Applications and ~/Applications, or
                                    $UPDIFF_APPS_DIRS, colon-separated)
  --notify                          check: show a notification for each changed app
  --settle <seconds>                check: wait until apps stop changing for this long
  --keep <n>                        check/snapshot: snapshots to keep per app (default 10)
  --quiet                           Print less
  --interval <seconds>              agent install: fallback timer (default 21600)
  --dry-run                         agent install: print the LaunchAgent, change nothing
  --no-load                         agent install/uninstall: write files, skip launchctl
  --no-gatekeeper                   Skip the Gatekeeper/notarization check (faster)
  --no-color                        Plain text output
  -h, --help                        Show this help
  -v, --version                     Show the version

Hostnames found in code are not proof that the app connects to them.
`;

class UsageError extends Error {}

interface Ctx {
  io: IO;
  store: Store;
  appsDirs: string[];
  scan: ScanOptions;
  format: 'text' | 'md' | 'json';
  minSeverity: Severity;
  out?: string;
  full: boolean;
  quiet: boolean;
  force: boolean;
  keep: number;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      format: { type: 'string' },
      'min-severity': { type: 'string' },
      out: { type: 'string' },
      full: { type: 'boolean' },
      deep: { type: 'boolean' },
      force: { type: 'boolean' },
      home: { type: 'string' },
      'apps-dir': { type: 'string', multiple: true },
      notify: { type: 'boolean' },
      settle: { type: 'string' },
      keep: { type: 'string' },
      quiet: { type: 'boolean' },
      interval: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-load': { type: 'boolean' },
      'no-color': { type: 'boolean' },
      'no-gatekeeper': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

/** `$UPDIFF_APPS_DIRS` (colon-separated) overrides the default app folders. */
function defaultAppsDirs(): string[] {
  const fromEnv = process.env.UPDIFF_APPS_DIRS?.split(':').filter(Boolean);
  return fromEnv?.length ? fromEnv : ['/Applications', join(homedir(), 'Applications')];
}

/** Apps at the top of each folder and one folder down (for suites like "Adobe X/"). */
export async function discoverApps(dirs: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const dir of dirs) {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const p = join(dir, d.name);
      if (d.name.endsWith('.app')) found.push(p);
      else if (!d.name.startsWith('.')) {
        try {
          for (const inner of await readdir(p, { withFileTypes: true })) {
            if (inner.isDirectory() && inner.name.endsWith('.app')) found.push(join(p, inner.name));
          }
        } catch {
          // Unreadable folder: skip it.
        }
      }
    }
  }
  return found.sort((a, b) => basename(a).localeCompare(basename(b)));
}

function isAppDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && existsSync(join(p, 'Contents', 'Info.plist'));
  } catch {
    return false;
  }
}

/** Finds an installed app by path or by name. */
function findApp(arg: string, dirs: string[]): string | undefined {
  const asPath = resolve(arg);
  if (isAppDir(asPath)) return asPath;
  const name = arg.endsWith('.app') ? arg : `${arg}.app`;
  for (const dir of dirs) {
    const p = join(dir, name);
    if (isAppDir(p)) return p;
  }
  return undefined;
}

async function findAppByName(arg: string, dirs: string[]): Promise<string | undefined> {
  const direct = findApp(arg, dirs);
  if (direct) return direct;
  const q = arg.toLowerCase().replace(/\.app$/, '');
  return (await discoverApps(dirs)).find((p) => basename(p, '.app').toLowerCase() === q);
}

type Side = { kind: 'snapshot'; snapshot: Snapshot } | { kind: 'app'; path: string } | { kind: 'stored'; bundleId: string };

async function resolveSide(ctx: Ctx, arg: string): Promise<Side> {
  if (arg.endsWith('.json') && existsSync(arg)) return { kind: 'snapshot', snapshot: await ctx.store.load(arg) };
  const app = await findAppByName(arg, ctx.appsDirs);
  if (app) return { kind: 'app', path: app };
  const id = await ctx.store.resolveBundleId(arg);
  if (id) return { kind: 'stored', bundleId: id };
  throw new UsageError(`Can't find "${arg}": not an app path, an app in ${ctx.appsDirs.join(' or ')}, a snapshot file, or a stored app.`);
}

async function sideSnapshot(ctx: Ctx, side: Side): Promise<Snapshot> {
  if (side.kind === 'snapshot') return side.snapshot;
  if (side.kind === 'app') return scanBundle(side.path, ctx.scan);
  const [latest] = await ctx.store.latest(side.bundleId, 1);
  if (!latest) throw new UsageError(`No snapshots stored for ${side.bundleId}.`);
  return latest;
}

async function emit(ctx: Ctx, report: DiffReport): Promise<void> {
  const r = filterBySeverity(report, ctx.minSeverity);
  const text =
    ctx.format === 'json'
      ? renderJson(r)
      : ctx.format === 'md'
        ? renderMarkdown(r)
        : renderText(r, { color: ctx.io.color && !ctx.out, full: ctx.full });
  if (ctx.out) {
    await writeFile(ctx.out, text);
    ctx.io.err(`Wrote ${ctx.out}\n`);
  } else ctx.io.out(text);
}

async function cmdScan(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length !== 1) throw new UsageError('scan needs exactly one app.');
  const app = await findAppByName(args[0]!, ctx.appsDirs);
  if (!app) throw new UsageError(`Can't find app "${args[0]}".`);
  // A one-off scan of an installed app also shows this Mac's update settings for it.
  const s = await scanBundle(app, { ...ctx.scan, userDefaults: true });
  const text = ctx.format === 'json' ? renderJson(s) : renderScan(s, { color: ctx.io.color && !ctx.out });
  if (ctx.out) {
    await writeFile(ctx.out, text);
    ctx.io.err(`Wrote ${ctx.out}\n`);
  } else ctx.io.out(text);
  return 0;
}

type SnapshotOutcome = { app: string; status: 'new' | 'changed' | 'unchanged' | 'failed'; snapshot?: Snapshot; previous?: Snapshot; error?: string };

async function snapshotApp(ctx: Ctx, appPath: string): Promise<SnapshotOutcome> {
  try {
    const id = await readIdentity(appPath);
    if (!id) return { app: appPath, status: 'failed', error: 'no readable Info.plist' };
    const [previous] = await ctx.store.latest(id.bundleId, 1);
    if (previous && !ctx.force) {
      const fp = await quickFingerprint(appPath);
      if (fp === previous.fingerprint) return { app: appPath, status: 'unchanged', previous };
    }
    const snapshot = await scanBundle(appPath, ctx.scan);
    await ctx.store.save(snapshot);
    await ctx.store.prune(snapshot.app.bundleId, ctx.keep);
    return { app: appPath, status: previous ? 'changed' : 'new', snapshot, previous };
  } catch (err) {
    return { app: appPath, status: 'failed', error: (err as Error).message };
  }
}

async function cmdSnapshot(ctx: Ctx, args: string[]): Promise<number> {
  let apps: string[];
  if (args.length) {
    apps = [];
    for (const a of args) {
      const p = await findAppByName(a, ctx.appsDirs);
      if (!p) throw new UsageError(`Can't find app "${a}".`);
      apps.push(p);
    }
  } else apps = await discoverApps(ctx.appsDirs);
  const results = await mapLimit(apps, 3, async (app) => {
    const r = await snapshotApp(ctx, app);
    if (!ctx.quiet) {
      const s = r.snapshot ?? r.previous;
      const label = s ? `${s.app.name} ${s.app.version}` : basename(app);
      const time = r.snapshot ? ` (${(r.snapshot.stats.scanMs / 1000).toFixed(1)} s)` : '';
      ctx.io.err(`${r.status.padEnd(9)} ${label}${time}${r.error ? `: ${r.error}` : ''}\n`);
    }
    return r;
  });
  const failed = results.filter((r) => r.status === 'failed').length;
  if (ctx.format === 'json') {
    ctx.io.out(renderJson(results.map((r) => ({ app: r.app, status: r.status, error: r.error, bundleId: (r.snapshot ?? r.previous)?.app.bundleId, version: (r.snapshot ?? r.previous)?.app.version }))));
  } else {
    const count = (s: SnapshotOutcome['status']): number => results.filter((r) => r.status === s).length;
    ctx.io.out(`${apps.length} app${apps.length === 1 ? '' : 's'}: ${count('new')} new, ${count('changed')} changed, ${count('unchanged')} unchanged, ${failed} failed. Stored in ${ctx.store.snapshotsDir}\n`);
  }
  return failed && failed === apps.length ? 1 : 0;
}

async function cmdDiff(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length === 2) {
    const [a, b] = await Promise.all(args.map((x) => resolveSide(ctx, x)));
    const [sa, sb] = await Promise.all([sideSnapshot(ctx, a!), sideSnapshot(ctx, b!)]);
    await emit(ctx, diffSnapshots(sa, sb));
    return 0;
  }
  if (args.length !== 1) throw new UsageError('diff needs one app, or two things to compare.');
  const side = await resolveSide(ctx, args[0]!);
  let bundleId: string;
  if (side.kind === 'snapshot') throw new UsageError('Give two snapshot files to compare them.');
  if (side.kind === 'app') {
    const id = await readIdentity(side.path);
    if (!id) throw new UsageError(`${side.path} has no readable Info.plist.`);
    bundleId = id.bundleId;
  } else bundleId = side.bundleId;
  const stored = await ctx.store.latest(bundleId, 2);
  if (side.kind === 'app' && stored[0]) {
    // Compare the installed app against the newest snapshot when it has changed since.
    const fp = await quickFingerprint(side.path);
    if (fp !== stored[0].fingerprint) {
      await emit(ctx, diffSnapshots(stored[0], await scanBundle(side.path, ctx.scan)));
      return 0;
    }
  }
  if (stored.length < 2) {
    throw new UsageError(
      stored.length
        ? `Only one snapshot of ${bundleId}, and the app has not changed since. Run 'updiff snapshot' again after it updates.`
        : `No snapshots of ${bundleId} yet. Run 'updiff snapshot "${args[0]}"' first.`,
    );
  }
  await emit(ctx, diffSnapshots(stored[1]!, stored[0]!));
  return 0;
}

async function waitUntilSettled(apps: string[], seconds: number, io: IO, quiet: boolean): Promise<void> {
  if (seconds <= 0) return;
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    let newest = 0;
    for (const app of apps) {
      for (const p of [app, join(app, 'Contents'), join(app, 'Contents', 'Info.plist'), join(app, 'Contents', '_CodeSignature', 'CodeResources')]) {
        try {
          newest = Math.max(newest, (await stat(p)).mtimeMs);
        } catch {
          // Missing while the update is being written.
        }
      }
    }
    const age = (Date.now() - newest) / 1000;
    if (age >= seconds || Date.now() > deadline) return;
    if (!quiet) io.err(`An app changed ${Math.round(age)} s ago; waiting for the update to finish…\n`);
    await new Promise((r) => setTimeout(r, Math.min(15, seconds - age) * 1000));
  }
}

async function cmdCheck(ctx: Ctx, args: string[], notifyEnabled: boolean, settle: number): Promise<number> {
  if (args.length) throw new UsageError('check takes no app names; use --apps-dir to choose folders.');
  let apps = await discoverApps(ctx.appsDirs);
  await waitUntilSettled(apps, settle, ctx.io, ctx.quiet);
  apps = await discoverApps(ctx.appsDirs);
  const results = await mapLimit(apps, 3, (app) => snapshotApp(ctx, app));
  const reports: Array<{ report: DiffReport; file: string }> = [];
  for (const r of results) {
    if (r.status !== 'changed' || !r.previous || !r.snapshot) continue;
    const report = diffSnapshots(r.previous, r.snapshot);
    const file = await ctx.store.saveReport(report.app.bundleId, report.from.version, report.to.version, 'md', renderMarkdown(report));
    reports.push({ report, file });
  }
  const baseline = results.filter((r) => r.status === 'new');
  const failed = results.filter((r) => r.status === 'failed');

  if (ctx.format === 'json') {
    ctx.io.out(
      renderJson({
        checked: apps.length,
        baseline: baseline.map((r) => r.snapshot!.app.bundleId),
        failed: failed.map((r) => ({ app: r.app, error: r.error })),
        changed: reports.map(({ report, file }) => ({ ...filterBySeverity(report, ctx.minSeverity), reportFile: file })),
      }),
    );
  } else {
    for (const { report, file } of reports) {
      ctx.io.out(renderText(filterBySeverity(report, ctx.minSeverity), { color: ctx.io.color, full: ctx.full }));
      ctx.io.out(`Report: ${file}\n\n`);
    }
    if (!ctx.quiet || reports.length || failed.length) {
      const parts = [`Checked ${apps.length} app${apps.length === 1 ? '' : 's'}`, `${reports.length} updated`];
      if (baseline.length) parts.push(`${baseline.length} new baseline${baseline.length === 1 ? '' : 's'}`);
      if (failed.length) parts.push(`${failed.length} failed (${failed.map((f) => basename(f.app)).join(', ')})`);
      ctx.io.out(`${parts.join(', ')}.\n`);
    }
  }
  if (notifyEnabled) {
    for (const { report } of reports) {
      const { high, notable } = report.counts;
      const summary = high || notable ? `${high} high, ${notable} notable change${high + notable === 1 ? '' : 's'}` : 'No notable changes';
      await notify(`Updiff: ${report.app.name} ${report.to.version}`, `${summary}. Run: updiff diff "${report.app.bundleId}"`);
    }
  }
  return 0;
}

async function cmdList(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length > 1) throw new UsageError('list takes at most one app.');
  if (args.length === 1) {
    const side = await resolveSide(ctx, args[0]!);
    let id: string | undefined;
    if (side.kind === 'stored') id = side.bundleId;
    else if (side.kind === 'app') id = (await readIdentity(side.path))?.bundleId;
    else id = side.snapshot.app.bundleId;
    const list = id ? await ctx.store.list(id) : [];
    if (ctx.format === 'json') ctx.io.out(renderJson(list));
    else if (!list.length) ctx.io.out(`No snapshots of ${id ?? args[0]}.\n`);
    else for (const s of list) ctx.io.out(`${s.version.padEnd(18)} ${s.build.padEnd(14)} ${s.takenAt}  ${s.file}\n`);
    return 0;
  }
  const ids = await ctx.store.bundleIds();
  const rows = [];
  for (const id of ids) {
    const list = await ctx.store.list(id);
    const [latest] = await ctx.store.latest(id, 1);
    rows.push({ bundleId: id, name: latest?.app.name ?? id, version: latest?.app.version ?? '?', snapshots: list.length });
  }
  if (ctx.format === 'json') ctx.io.out(renderJson(rows));
  else if (!rows.length) ctx.io.out(`No snapshots yet. Run 'updiff snapshot'.\n`);
  else {
    const w = Math.max(...rows.map((r) => r.name.length), 4);
    for (const r of rows) ctx.io.out(`${r.name.padEnd(w)}  ${r.version.padEnd(18)} ${String(r.snapshots).padStart(3)} snapshot${r.snapshots === 1 ? ' ' : 's'}  ${r.bundleId}\n`);
  }
  return 0;
}

function cliPath(): string {
  const p = process.argv[1];
  return p ? realpathSync(p) : resolve('dist/cli.js');
}

async function cmdAgent(ctx: Ctx, args: string[], opts: { interval: number; dryRun: boolean; load: boolean }): Promise<number> {
  const action = args[0];
  if (action === 'install') {
    const options = {
      nodePath: process.execPath,
      cliPath: cliPath(),
      home: ctx.store.home,
      intervalSeconds: opts.interval,
      watchPaths: ctx.appsDirs.filter((d) => existsSync(d)),
      appsDirs: ctx.appsDirs,
    };
    if (opts.dryRun) {
      ctx.io.out(agentPlist(options));
      return 0;
    }
    const res = await installAgent(options, opts.load);
    ctx.io.out(`Installed ${AGENT_LABEL} at ${res.path}${opts.load ? (res.loaded ? ' and loaded it' : ` but launchctl failed: ${res.message}`) : ' (not loaded)'}.\n`);
    if (opts.load && res.loaded) ctx.io.out(`It runs 'updiff check' after changes in ${options.watchPaths.join(', ')} and every ${Math.round(opts.interval / 3600)} h. Log: ${join(ctx.store.home, 'agent.log')}\n`);
    ctx.io.out(`Run 'updiff snapshot' once now so the first update has a baseline.\n`);
    return opts.load && !res.loaded ? 1 : 0;
  }
  if (action === 'uninstall') {
    const res = await uninstallAgent(opts.load);
    ctx.io.out(res.existed ? `Removed ${res.path}.\n` : `Not installed (${res.path}).\n`);
    return 0;
  }
  if (action === 'status') {
    const s = await agentStatus();
    ctx.io.out(`${AGENT_LABEL}: ${s.installed ? 'installed' : 'not installed'}, ${s.loaded ? 'loaded' : 'not loaded'} (${s.path})\n`);
    return 0;
  }
  throw new UsageError('agent needs install, uninstall or status.');
}

function intOption(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a whole number.`);
  return n;
}

export async function main(argv: string[], io: IO): Promise<number> {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (err) {
    io.err(`${(err as Error).message}\n\nRun 'updiff --help' for usage.\n`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.version) {
    io.out(`${TOOL_VERSION}\n`);
    return 0;
  }
  const [command, ...args] = positionals;
  if (v.help || !command) {
    io.out(USAGE);
    return command || v.help ? 0 : 2;
  }
  try {
    const format = (v.format ?? 'text') as Ctx['format'];
    if (!['text', 'md', 'json'].includes(format)) throw new UsageError('--format must be text, md or json.');
    const minSeverity = (v['min-severity'] ?? 'info') as Severity;
    if (!['high', 'notable', 'info'].includes(minSeverity)) throw new UsageError('--min-severity must be high, notable or info.');
    const ctx: Ctx = {
      io: { ...io, color: io.color && !v['no-color'] && format === 'text' },
      store: new Store(v.home ? resolve(v.home) : undefined),
      appsDirs: (v['apps-dir'] ?? defaultAppsDirs()).map((d) => resolve(d)),
      scan: { deep: v.deep === true, notarization: !v['no-gatekeeper'] },
      format,
      minSeverity,
      out: v.out,
      full: v.full === true,
      quiet: v.quiet === true,
      force: v.force === true,
      keep: Math.max(2, intOption(v.keep, 'keep', 10)),
    };
    switch (command) {
      case 'scan':
        return await cmdScan(ctx, args);
      case 'snapshot':
        return await cmdSnapshot(ctx, args);
      case 'diff':
        return await cmdDiff(ctx, args);
      case 'check':
        return await cmdCheck(ctx, args, v.notify === true, intOption(v.settle, 'settle', 0));
      case 'list':
        return await cmdList(ctx, args);
      case 'agent':
        return await cmdAgent(ctx, args, { interval: Math.max(600, intOption(v.interval, 'interval', 21600)), dryRun: v['dry-run'] === true, load: !v['no-load'] });
      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n`);
      return 2;
    }
    io.err(`updiff: ${(err as Error).stack ?? err}\n`);
    return 1;
  }
}

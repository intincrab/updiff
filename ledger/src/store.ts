import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DiffReport, Snapshot } from '../../src/types.ts';

/** One release the ledger has scanned. */
export interface ReleaseRecord {
  version: string;
  /** Version the bundle itself reports (can differ from the cask's). */
  appVersion: string;
  build: string;
  url: string;
  sha256: string;
  bytes: number;
  scannedAt: string;
  fingerprint: string;
  /** Report comparing this release with the one before it, relative to the app folder. */
  report?: string;
}

export interface AppState {
  cask: string;
  name: string;
  homepage?: string;
  desc?: string;
  bundleId?: string;
  lastCheckedAt?: string;
  latest?: ReleaseRecord;
  /** Newest first. */
  history: ReleaseRecord[];
  lastError?: { at: string; version: string; message: string };
}

export interface LedgerReport {
  cask: string;
  name: string;
  detectedAt: string;
  from: ReleaseRecord;
  to: ReleaseRecord;
  deep: boolean;
  report: DiffReport;
}

export interface TrackedApp {
  cask: string;
  deep?: boolean;
}

export function dataDir(): string {
  return resolve(process.env.LEDGER_DATA ?? join(import.meta.dirname, '..', 'data'));
}

export function appsFile(): string {
  return resolve(process.env.LEDGER_APPS ?? join(import.meta.dirname, '..', 'apps.json'));
}

export async function loadTrackedApps(file = appsFile()): Promise<TrackedApp[]> {
  const json = JSON.parse(await readFile(file, 'utf8')) as { apps?: TrackedApp[] };
  if (!Array.isArray(json.apps)) throw new Error(`${file} has no "apps" list`);
  return json.apps;
}

function safeToken(token: string): string {
  if (!/^[a-z0-9@._+-]+$/.test(token)) throw new Error(`Invalid cask token "${token}"`);
  return token;
}

/** Safe file-name form of a version. */
export function versionSlug(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

export class LedgerStore {
  readonly root: string;

  constructor(root = dataDir()) {
    this.root = root;
  }

  appDir(cask: string): string {
    return join(this.root, 'apps', safeToken(cask));
  }

  async loadState(cask: string): Promise<AppState | undefined> {
    const file = join(this.appDir(cask), 'state.json');
    if (!existsSync(file)) return undefined;
    return JSON.parse(await readFile(file, 'utf8')) as AppState;
  }

  async saveState(state: AppState): Promise<void> {
    const dir = this.appDir(state.cask);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  }

  async loadSnapshot(cask: string): Promise<Snapshot | undefined> {
    const file = join(this.appDir(cask), 'snapshot.json.gz');
    if (!existsSync(file)) return undefined;
    return JSON.parse(gunzipSync(await readFile(file)).toString('utf8')) as Snapshot;
  }

  async saveSnapshot(cask: string, snapshot: Snapshot): Promise<void> {
    const dir = this.appDir(cask);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'snapshot.json.gz'), gzipSync(JSON.stringify(snapshot), { level: 9 }));
  }

  /** Saves a report and returns its path relative to the app folder. */
  async saveReport(report: LedgerReport): Promise<string> {
    const dir = join(this.appDir(report.cask), 'reports');
    await mkdir(dir, { recursive: true });
    const name = `${report.detectedAt.slice(0, 10)}__${versionSlug(report.from.version)}__to__${versionSlug(report.to.version)}.json`;
    await writeFile(join(dir, name), JSON.stringify(report, null, 2) + '\n');
    return `reports/${name}`;
  }

  async loadReport(cask: string, rel: string): Promise<LedgerReport> {
    return JSON.parse(await readFile(join(this.appDir(cask), rel), 'utf8')) as LedgerReport;
  }

  async listCasks(): Promise<string[]> {
    try {
      return (await readdir(join(this.root, 'apps'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      return [];
    }
  }

  async writeRunLog(log: unknown): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, 'last-run.json'), JSON.stringify(log, null, 2) + '\n');
  }
}

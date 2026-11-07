import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanBundle } from '../../src/bundle.ts';
import { diffSnapshots } from '../../src/diff.ts';
import type { Severity, Snapshot } from '../../src/types.ts';
import { fetchCask, urlForVersion, type CaskInfo } from './cask.ts';
import { download, extractApp } from './fetch-app.ts';
import type { AppState, LedgerStore, ReleaseRecord, TrackedApp } from './store.ts';

export interface UpdateOptions {
  store: LedgerStore;
  /** Where downloads and unpacked installers go while being scanned. */
  workRoot?: string;
  maxBytes?: number;
  log?: (message: string) => void;
  now?: () => Date;
}

export type OutcomeStatus = 'unchanged' | 'baseline' | 'updated' | 'same-build' | 'rebaselined' | 'failed';

export interface Outcome {
  cask: string;
  status: OutcomeStatus;
  version?: string;
  from?: string;
  report?: string;
  counts?: Record<Severity, number>;
  error?: string;
  ms: number;
}

const DEFAULT_MAX_BYTES = 3 * 1024 * 1024 * 1024;

async function scanRelease(
  info: CaskInfo,
  version: string,
  url: string,
  expectedSha256: string | null,
  deep: boolean,
  opts: UpdateOptions,
): Promise<{ snapshot: Snapshot; record: ReleaseRecord }> {
  const log = opts.log ?? (() => {});
  const work = await mkdtemp(join(opts.workRoot ?? tmpdir(), `ledger-${info.token}-`));
  try {
    log(`  downloading ${url}`);
    const dl = await download(url, join(work, 'download'), { maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES, expectedSha256 });
    log(`  ${(dl.bytes / 1048576).toFixed(1)} MB, sha256 ${dl.sha256.slice(0, 12)}…${expectedSha256 ? ' (verified)' : ' (not pinned by the cask)'}`);
    const extracted = await extractApp(dl.file, join(work, 'x'), info.appNames);
    let snapshot: Snapshot;
    try {
      log(`  scanning ${extracted.appPath.slice(extracted.appPath.lastIndexOf('/') + 1)} from the ${extracted.kind}${deep ? ' (deep)' : ''}`);
      snapshot = await scanBundle(extracted.appPath, { deep });
    } finally {
      await extracted.cleanup();
    }
    // The bundle was scanned from a temporary location; record where it came from instead.
    snapshot.app.path = `${info.name} ${version} (Homebrew cask ${info.token})`;
    const record: ReleaseRecord = {
      version,
      appVersion: snapshot.app.version,
      build: snapshot.app.build,
      url,
      sha256: dl.sha256,
      bytes: dl.bytes,
      scannedAt: (opts.now?.() ?? new Date()).toISOString(),
      fingerprint: snapshot.fingerprint,
    };
    return { snapshot, record };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function freshState(info: CaskInfo, previous?: AppState): AppState {
  return {
    ...(previous ?? { history: [] }),
    cask: info.token,
    name: info.name,
    homepage: info.homepage,
    desc: info.desc,
    history: previous?.history ?? [],
  };
}

/** Checks one app: scans the cask's current release if it is new and records what changed. */
export async function updateApp(app: TrackedApp, opts: UpdateOptions): Promise<Outcome> {
  const started = Date.now();
  const now = (): string => (opts.now?.() ?? new Date()).toISOString();
  const log = opts.log ?? (() => {});
  const deep = app.deep === true;
  let info: CaskInfo;
  try {
    info = await fetchCask(app.cask);
  } catch (err) {
    return { cask: app.cask, status: 'failed', error: (err as Error).message, ms: Date.now() - started };
  }
  const state = freshState(info, await opts.store.loadState(app.cask));
  state.lastCheckedAt = now();
  if (state.latest?.version === info.version) {
    await opts.store.saveState(state);
    return { cask: app.cask, status: 'unchanged', version: info.version, ms: Date.now() - started };
  }

  log(`${info.name}: ${state.latest ? `${state.latest.version} → ` : 'new, '}${info.version}`);
  try {
    const { snapshot, record } = await scanRelease(info, info.version, info.url, info.sha256, deep, opts);
    const previous = state.latest ? await opts.store.loadSnapshot(app.cask) : undefined;
    let outcome: Outcome;

    if (!previous || !state.latest) {
      state.history.unshift(record);
      outcome = { cask: app.cask, status: 'baseline', version: info.version, ms: 0 };
    } else if (previous.fingerprint === snapshot.fingerprint) {
      // The cask moved but the bundle is byte-for-byte the same build.
      state.history[0] = { ...state.latest, version: info.version, scannedAt: record.scannedAt };
      outcome = { cask: app.cask, status: 'same-build', version: info.version, from: state.latest.version, ms: 0 };
    } else if (previous.stats.deep !== snapshot.stats.deep) {
      // Comparing a deep scan with a shallow one would report every framework host as new.
      state.history.unshift(record);
      outcome = { cask: app.cask, status: 'rebaselined', version: info.version, from: state.latest.version, ms: 0 };
    } else {
      const report = diffSnapshots(previous, snapshot);
      record.report = await opts.store.saveReport({
        cask: app.cask,
        name: info.name,
        detectedAt: record.scannedAt,
        from: state.latest,
        to: record,
        deep,
        report,
      });
      state.history.unshift(record);
      outcome = { cask: app.cask, status: 'updated', version: info.version, from: state.latest.version, report: record.report, counts: report.counts, ms: 0 };
    }

    state.latest = state.history[0];
    state.bundleId = snapshot.app.bundleId;
    delete state.lastError;
    await opts.store.saveSnapshot(app.cask, snapshot);
    await opts.store.saveState(state);
    outcome.ms = Date.now() - started;
    return outcome;
  } catch (err) {
    state.lastError = { at: now(), version: info.version, message: (err as Error).message };
    await opts.store.saveState(state);
    return { cask: app.cask, status: 'failed', version: info.version, error: (err as Error).message, ms: Date.now() - started };
  }
}

/**
 * Records an older release as the baseline, so the next update produces a report
 * straight away. The download URL is derived from the cask's current URL unless given.
 */
export async function backfill(app: TrackedApp, version: string, opts: UpdateOptions & { url?: string; force?: boolean }): Promise<Outcome> {
  const started = Date.now();
  const info = await fetchCask(app.cask);
  const existing = await opts.store.loadState(app.cask);
  if (existing?.latest && !opts.force) {
    throw new Error(`${app.cask} already has a baseline (${existing.latest.version}). Use --force to replace it.`);
  }
  const url = opts.url ?? urlForVersion(info, version);
  if (!url) throw new Error(`Can't derive a download URL for ${app.cask} ${version} from ${info.url}; pass --url.`);
  const { snapshot, record } = await scanRelease(info, version, url, null, app.deep === true, opts);
  const state = freshState(info);
  state.history = [record];
  state.latest = record;
  state.bundleId = snapshot.app.bundleId;
  state.lastCheckedAt = record.scannedAt;
  await opts.store.saveSnapshot(app.cask, snapshot);
  await opts.store.saveState(state);
  return { cask: app.cask, status: 'baseline', version, ms: Date.now() - started };
}

/** Checks every app in turn. Sequential on purpose: installers can be gigabytes each. */
export async function updateAll(apps: TrackedApp[], opts: UpdateOptions): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const app of apps) {
    const outcome = await updateApp(app, opts);
    outcomes.push(outcome);
    const log = opts.log ?? (() => {});
    if (outcome.status === 'failed') log(`${app.cask}: FAILED: ${outcome.error}`);
    else if (outcome.status !== 'unchanged') {
      const counts = outcome.counts ? ` (${outcome.counts.high} high, ${outcome.counts.notable} notable)` : '';
      log(`${app.cask}: ${outcome.status} ${outcome.from ? `${outcome.from} → ` : ''}${outcome.version}${counts} in ${(outcome.ms / 1000).toFixed(1)} s`);
    }
  }
  return outcomes;
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanBundle, type ScanOptions } from './bundle.ts';
import { fetchCask, urlForVersion, type CaskInfo } from './cask.ts';
import { caskHistory, type CaskRelease } from './cask-history.ts';
import { download, extractApp } from './installer.ts';
import type { Snapshot } from './types.ts';

/** Turns an app name into the cask token Homebrew would likely use: "Google Chrome" → "google-chrome". */
export function guessCaskToken(name: string): string {
  return name
    .replace(/\.app$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@.+]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Finds the cask for an app: an explicit token first, then guesses from the names given. */
export async function resolveCask(candidates: string[]): Promise<CaskInfo> {
  const tried: string[] = [];
  for (const c of candidates) {
    const token = guessCaskToken(c);
    if (!token || tried.includes(token)) continue;
    tried.push(token);
    try {
      return await fetchCask(token);
    } catch {
      // Try the next guess.
    }
  }
  throw new Error(`No Homebrew cask found for ${tried.map((t) => `"${t}"`).join(' or ')}. Pass the cask's name with --cask (see https://formulae.brew.sh/cask/).`);
}

/** The cask's version string matched loosely against an app version ("1.172.0" matches "1.172.0,90280"). */
export function sameVersion(caskVersion: string, appVersion: string | undefined): boolean {
  if (!appVersion) return false;
  return caskVersion === appVersion || caskVersion.split(',')[0] === appVersion;
}

/** Picks the release to fetch: the one asked for, or the one before the installed (or current) version. */
export function pickRelease(releases: CaskRelease[], wanted: string | undefined, installedVersion: string | undefined): CaskRelease {
  if (wanted) {
    const hit = releases.find((r) => r.version === wanted) ?? releases.find((r) => sameVersion(r.version, wanted));
    if (!hit) throw new Error(`Version ${wanted} isn't in the cask's recent history. Run with --list to see the versions there are.`);
    return hit;
  }
  const installedAt = releases.findIndex((r) => sameVersion(r.version, installedVersion));
  const pick = installedAt >= 0 ? releases[installedAt + 1] : releases[1];
  if (!pick) throw new Error('The cask has no earlier release in its recent history.');
  return pick;
}

export interface FetchedRelease {
  snapshot: Snapshot;
  release: CaskRelease;
  info: CaskInfo;
  url: string;
  verified: boolean;
  bytes: number;
}

/** Downloads a past release, checks it against the cask's checksum, and scans it. Nothing is installed or run. */
export async function fetchRelease(
  info: CaskInfo,
  release: CaskRelease,
  options: { scan?: ScanOptions; maxBytes?: number; log?: (s: string) => void } = {},
): Promise<FetchedRelease> {
  const log = options.log ?? (() => {});
  const url = release.url ?? urlForVersion(info, release.version);
  if (!url) throw new Error(`Can't work out the download URL for ${info.name} ${release.version} from the cask.`);
  const work = await mkdtemp(join(tmpdir(), 'updiff-fetch-'));
  try {
    log(`Downloading ${info.name} ${release.version} from ${url}`);
    const dl = await download(url, join(work, 'download'), { maxBytes: options.maxBytes ?? 3 * 1024 ** 3, expectedSha256: release.sha256 });
    log(release.sha256 ? `Checksum matches the cask (${dl.sha256.slice(0, 12)}…)` : `The cask doesn't pin a checksum for this release (${dl.sha256.slice(0, 12)}…)`);
    const extracted = await extractApp(dl.file, join(work, 'x'), info.appNames);
    let snapshot: Snapshot;
    try {
      log(`Scanning ${extracted.appPath.slice(extracted.appPath.lastIndexOf('/') + 1)} from the ${extracted.kind}`);
      snapshot = await scanBundle(extracted.appPath, options.scan);
    } finally {
      await extracted.cleanup();
    }
    snapshot.app.path = `${info.name} ${release.version} (Homebrew cask ${info.token} at ${release.commit.slice(0, 7)})`;
    return { snapshot, release, info, url, verified: release.sha256 !== null, bytes: dl.bytes };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export { caskHistory };

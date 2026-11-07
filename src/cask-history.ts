import { fetchCask, type CaskInfo } from './cask.ts';
import { mapLimit } from './util.ts';
import { TOOL_VERSION } from './version.ts';

/** One release of an app, read from a past revision of its Homebrew cask. */
export interface CaskRelease {
  version: string;
  /** Download URL for Apple silicon, when the cask's URL could be resolved. */
  url?: string;
  /** SHA-256 the cask pinned for that download; null for `no_check`. */
  sha256: string | null;
  /** homebrew-cask commit the release was read from. */
  commit: string;
  date: string;
}

interface ParsedCask {
  version?: string;
  url?: string;
  sha256: string | null;
  arch?: string;
}

const OLDER_ONLY = /:or_older/;

/**
 * Keeps the lines of a cask that apply to a current Apple silicon Mac: `on_arm` and
 * `on_<macOS> :or_newer` blocks and top-level stanzas. Drops `on_intel`, blocks for
 * older macOS versions, and blocks such as `livecheck`, `zap` and `uninstall`.
 */
function linesForThisMac(source: string): string[] {
  const kept: string[] = [];
  const stack: boolean[] = [];
  for (const line of source.split('\n')) {
    const opens = /^\s*(\S+)(.*?)\bdo(\s*\|[^|]*\|)?\s*$/.exec(line);
    if (opens) {
      const name = opens[1]!;
      const args = opens[2] ?? '';
      let keep: boolean;
      if (name === 'cask') keep = true;
      else if (name === 'on_arm') keep = true;
      else if (name === 'on_intel') keep = false;
      else if (/^on_[a-z_]+$/.test(name) && name !== 'on_arm') keep = /:or_newer/.test(args) && !OLDER_ONLY.test(args);
      else keep = false;
      stack.push(keep);
      continue;
    }
    if (/^\s*end\s*$/.test(line)) {
      stack.pop();
      continue;
    }
    if (stack.every(Boolean)) kept.push(line);
  }
  return kept;
}

/** The last `version` stanza outside livecheck, for casks that only set it inside OS blocks. */
function lastVersionAnywhere(source: string): string | undefined {
  const withoutLivecheck = source.replace(/\n\s*livecheck do[\s\S]*?\n\s*end\b/g, '\n');
  const all = [...withoutLivecheck.matchAll(/^\s*version\s+"([^"]+)"/gm)];
  return all.at(-1)?.[1];
}

/** Reads version, URL template, checksum and arch from a cask's Ruby source. */
export function parseCaskSource(source: string): ParsedCask {
  const text = linesForThisMac(source).join('\n');
  const version = /^\s*version\s+"([^"]+)"/m.exec(text)?.[1] ?? lastVersionAnywhere(source);
  const url = /^\s*url\s+"([^"]+)"/m.exec(text)?.[1];
  const shaArm = /sha256\s+arm:\s*"([0-9a-f]{64})"/i.exec(text)?.[1];
  const shaOne = /^\s*sha256\s+"([0-9a-f]{64})"/im.exec(text)?.[1];
  const arch = /^\s*arch\s+arm:\s*"([^"]*)"/m.exec(source)?.[1];
  return { version, url, sha256: (shaArm ?? shaOne)?.toLowerCase() ?? null, arch };
}

/** Applies a chain of Homebrew version methods: `version.csv.first.no_dots`. */
export function applyVersionMethods(version: string, chain: string[]): string | undefined {
  let value: string | string[] = version;
  for (const method of chain) {
    const s: string | undefined = Array.isArray(value) ? undefined : value;
    switch (method) {
      case 'csv':
        if (s === undefined) return undefined;
        value = s.split(',');
        break;
      case 'first':
      case 'second':
      case 'third': {
        if (!Array.isArray(value)) return undefined;
        const item: string | undefined = value[['first', 'second', 'third'].indexOf(method)];
        if (item === undefined) return undefined;
        value = item;
        break;
      }
      case 'before_comma':
        if (s === undefined) return undefined;
        value = s.split(',')[0]!;
        break;
      case 'after_comma': {
        const after: string | undefined = s?.split(',')[1];
        if (after === undefined) return undefined;
        value = after;
        break;
      }
      case 'major':
      case 'minor':
      case 'patch': {
        const part: string | undefined = s?.split(/[.,-]/)[['major', 'minor', 'patch'].indexOf(method)];
        if (part === undefined) return undefined;
        value = part;
        break;
      }
      case 'major_minor':
      case 'major_minor_patch': {
        if (s === undefined) return undefined;
        value = s.split('.').slice(0, method === 'major_minor' ? 2 : 3).join('.');
        break;
      }
      case 'no_dots':
        if (s === undefined) return undefined;
        value = s.replace(/\./g, '');
        break;
      case 'dots_to_underscores':
        if (s === undefined) return undefined;
        value = s.replace(/\./g, '_');
        break;
      case 'dots_to_hyphens':
        if (s === undefined) return undefined;
        value = s.replace(/\./g, '-');
        break;
      case 'no_hyphens':
        if (s === undefined) return undefined;
        value = s.replace(/-/g, '');
        break;
      default:
        return undefined;
    }
  }
  return Array.isArray(value) ? undefined : value;
}

/** Fills `#{version…}` and `#{arch}` in a cask URL. Undefined if anything is left unresolved. */
export function resolveCaskUrl(template: string, version: string, arch: string | undefined): string | undefined {
  let unresolved = false;
  const url = template.replace(/#\{([^}]+)\}/g, (_, expr: string) => {
    const e = expr.trim();
    if (e === 'arch') {
      if (arch === undefined) unresolved = true;
      return arch ?? '';
    }
    const parts = e.split('.');
    if (parts[0] !== 'version') {
      unresolved = true;
      return '';
    }
    const value = applyVersionMethods(version, parts.slice(1));
    if (value === undefined) unresolved = true;
    return value ?? '';
  });
  return unresolved ? undefined : url;
}

export function githubApiBase(): string {
  return (process.env.UPDIFF_GITHUB_API ?? 'https://api.github.com').replace(/\/$/, '');
}

export function githubRawBase(): string {
  return (process.env.UPDIFF_GITHUB_RAW ?? 'https://raw.githubusercontent.com').replace(/\/$/, '');
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': `updiff/${TOOL_VERSION}`, accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

interface CommitEntry {
  sha: string;
  commit: { committer?: { date?: string }; author?: { date?: string } };
}

/**
 * Past releases of a cask, newest first: walks the commits that touched the cask
 * file in Homebrew/homebrew-cask and reads the cask at each one.
 */
export async function caskHistory(token: string, options: { commits?: number; info?: CaskInfo } = {}): Promise<{ info: CaskInfo; releases: CaskRelease[] }> {
  const info = options.info ?? (await fetchCask(token));
  if (!info.sourcePath) throw new Error(`The Homebrew API did not say where the ${token} cask lives.`);
  const perPage = Math.min(Math.max(options.commits ?? 60, 1), 100);
  const res = await fetch(
    `${githubApiBase()}/repos/Homebrew/homebrew-cask/commits?path=${encodeURIComponent(info.sourcePath)}&per_page=${perPage}`,
    { headers: githubHeaders(), signal: AbortSignal.timeout(30_000) },
  );
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub is rate-limiting history lookups (60 an hour without a token). Set GITHUB_TOKEN to raise the limit, or try again later.');
  }
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the ${token} cask's history.`);
  const commits = (await res.json()) as CommitEntry[];

  const parsed = await mapLimit(commits, 6, async (c) => {
    const raw = await fetch(`${githubRawBase()}/Homebrew/homebrew-cask/${c.sha}/${info.sourcePath}`, {
      headers: { 'user-agent': `updiff/${TOOL_VERSION}` },
      signal: AbortSignal.timeout(30_000),
    });
    // A commit can delete or move the file; skip it.
    if (!raw.ok) return undefined;
    const cask = parseCaskSource(await raw.text());
    if (!cask.version || cask.version === 'latest') return undefined;
    const release: CaskRelease = {
      version: cask.version,
      sha256: cask.sha256,
      commit: c.sha,
      date: c.commit.committer?.date ?? c.commit.author?.date ?? '',
    };
    const url = cask.url ? resolveCaskUrl(cask.url, cask.version, cask.arch) : undefined;
    if (url) release.url = url;
    return release;
  });

  // Commits come newest first; keep the newest commit for each version.
  const releases: CaskRelease[] = [];
  const seen = new Set<string>();
  for (const r of parsed) {
    if (!r || seen.has(r.version)) continue;
    seen.add(r.version);
    releases.push(r);
  }
  return { info, releases };
}

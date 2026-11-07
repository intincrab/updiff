/** Release metadata from the Homebrew cask API (formulae.brew.sh). */
export interface CaskInfo {
  token: string;
  name: string;
  desc?: string;
  homepage?: string;
  version: string;
  url: string;
  /** Null when the cask does not pin a checksum (`no_check`). */
  sha256: string | null;
  /** App bundles the cask installs, e.g. ["Slack.app"]. */
  appNames: string[];
  /** Installer packages the cask runs, e.g. ["zoomusInstallerFull.pkg"]. */
  pkgNames: string[];
}

export function caskApiBase(): string {
  return (process.env.LEDGER_CASK_API ?? 'https://formulae.brew.sh/api/cask').replace(/\/$/, '');
}

type Artifact = Record<string, unknown>;

function firstStrings(artifacts: Artifact[], key: string): string[] {
  const out: string[] = [];
  for (const a of artifacts) {
    const v = a[key];
    if (!Array.isArray(v)) continue;
    // Each entry is ["Name.app"] or ["Name.app", { target: "..." }].
    for (const item of v) {
      if (typeof item === 'string') out.push(item);
      else if (Array.isArray(item) && typeof item[0] === 'string') out.push(item[0]);
    }
  }
  return out;
}

/** Turns a cask API document into the fields the ledger needs. */
export function parseCask(json: unknown): CaskInfo {
  const j = json as Record<string, unknown>;
  if (typeof j?.token !== 'string' || typeof j.version !== 'string' || typeof j.url !== 'string') {
    throw new Error('Not a Homebrew cask document');
  }
  const artifacts = Array.isArray(j.artifacts) ? (j.artifacts as Artifact[]) : [];
  const names = Array.isArray(j.name) ? (j.name as unknown[]) : [];
  const sha = typeof j.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(j.sha256) ? j.sha256.toLowerCase() : null;
  return {
    token: j.token,
    name: typeof names[0] === 'string' ? names[0] : j.token,
    desc: typeof j.desc === 'string' ? j.desc : undefined,
    homepage: typeof j.homepage === 'string' ? j.homepage : undefined,
    version: j.version,
    url: j.url,
    sha256: sha,
    appNames: firstStrings(artifacts, 'app'),
    pkgNames: firstStrings(artifacts, 'pkg'),
  };
}

export async function fetchCask(token: string): Promise<CaskInfo> {
  if (!/^[a-z0-9@._+-]+$/.test(token)) throw new Error(`Invalid cask token "${token}"`);
  const res = await fetch(`${caskApiBase()}/${token}.json`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Cask "${token}": HTTP ${res.status} from the Homebrew API`);
  return parseCask(await res.json());
}

/** The forms a version can take inside a download URL. */
function versionForms(version: string): string[] {
  const forms = [version, version.replace(/\./g, '_'), version.replace(/\./g, '-')];
  return [...new Set(forms)];
}

/**
 * Best-effort URL of another release: substitutes `version` for the cask's current
 * version (and each part of comma-separated versions such as "1.2.3,456") in the
 * current download URL. Returns undefined when the URL does not contain the version.
 */
export function urlForVersion(info: CaskInfo, version: string): string | undefined {
  const currentParts = info.version.split(',');
  const nextParts = version.split(',');
  if (currentParts.length !== nextParts.length) return undefined;
  let url = info.url;
  let replaced = false;
  for (let i = 0; i < currentParts.length; i++) {
    const from = versionForms(currentParts[i]!);
    const to = versionForms(nextParts[i]!);
    for (let f = 0; f < from.length; f++) {
      if (from[f] && url.includes(from[f]!)) {
        url = url.split(from[f]!).join(to[f]!);
        replaced = true;
        break;
      }
    }
  }
  return replaced ? url : undefined;
}

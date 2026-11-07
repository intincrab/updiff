import { createHash } from 'node:crypto';
import { open, readdir, readFile, readlink, lstat, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AsarArchive, type AsarFile } from './asar.ts';
import { readEntitlements, readSigning } from './codesign.ts';
import { extractHosts, mergeHosts, type HostMap } from './hosts.ts';
import { isDict, readPlistFile, str, type PlistDict } from './plist.ts';
import {
  SNAPSHOT_SCHEMA,
  type BackgroundItem,
  type CodeItem,
  type CodeKind,
  type ElectronInfo,
  type InfoSummary,
  type Snapshot,
} from './types.ts';
import { mapLimit, sortedUnique } from './util.ts';
import { TOOL_NAME, TOOL_VERSION } from './version.ts';

export interface ScanOptions {
  /** Also scan framework binaries and framework resources for hostnames. */
  deep?: boolean;
  /** Largest single file read for hostnames. */
  maxFileBytes?: number;
  /** Stop reading for hostnames after this many bytes in total. */
  maxTotalBytes?: number;
}

interface Entry {
  rel: string;
  abs: string;
  isDir: boolean;
  size: number;
  mode: number;
}

const TEXT_EXTS = new Set([
  '.js', '.cjs', '.mjs', '.jsx', '.json', '.html', '.htm', '.css', '.xml', '.plist', '.yml', '.yaml', '.toml',
  '.ini', '.conf', '.txt', '.env',
]);
const DOC_NAME_RE = /^(readme|license|licence|changelog|changes|history|authors|contributors|notice|copying|security|code_of_conduct)(\.|$)/i;

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Whether a file is worth reading for hostnames as text. */
export function isScannableText(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (DOC_NAME_RE.test(name)) return false;
  if (name.endsWith('.map') || name.endsWith('.d.ts') || name.endsWith('.md')) return false;
  // npm manifests are mostly repository and issue-tracker links.
  if (name === 'package.json' && path.includes('node_modules/')) return false;
  return TEXT_EXTS.has(extOf(name));
}

/** `X.framework/Versions/154.0.1/Helpers` → `X.framework/Versions/*\/Helpers` */
export function normalizeKey(rel: string): string {
  return rel.replace(/\/Versions\/[^/]+\//g, '/Versions/*/');
}

const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

async function isMachO(path: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && MACHO_MAGICS.has(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/**
 * Walks a bundle without following symlinks. When a framework's `Versions/` folder
 * holds more than one version (an update in progress, or leftovers), only the one
 * `Versions/Current` points to is kept.
 */
async function walk(root: string, warnings: string[]): Promise<Entry[]> {
  const out: Entry[] = [];
  const queue: string[] = [''];
  const currentVersion = new Map<string, string>();
  while (queue.length) {
    const rel = queue.pop()!;
    const abs = rel ? join(root, rel) : root;
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Could not read ${rel || '.'}: ${(err as Error).message}`);
      continue;
    }
    const entries = await Promise.all(
      dirents.map(async (d): Promise<Entry | null> => {
        const r = rel ? `${rel}/${d.name}` : d.name;
        const a = join(abs, d.name);
        // Symlinks are skipped: framework `Versions/Current` would otherwise be read twice.
        if (d.isSymbolicLink()) {
          if (d.name === 'Current' && basename(abs) === 'Versions') {
            try {
              currentVersion.set(rel, basename(await readlink(a)));
            } catch {
              // A broken link leaves every version in place.
            }
          }
          return null;
        }
        if (d.isDirectory()) {
          queue.push(r);
          return { rel: r, abs: a, isDir: true, size: 0, mode: 0 };
        }
        if (!d.isFile()) return null;
        try {
          const st = await lstat(a);
          return { rel: r, abs: a, isDir: false, size: st.size, mode: st.mode };
        } catch {
          return null;
        }
      }),
    );
    for (const e of entries) if (e) out.push(e);
  }
  const stale: string[] = [];
  for (const [versionsRel, current] of currentVersion) {
    for (const e of out) {
      if (e.isDir && e.rel.startsWith(`${versionsRel}/`) && !e.rel.slice(versionsRel.length + 1).includes('/')) {
        if (e.rel !== `${versionsRel}/${current}`) stale.push(e.rel);
      }
    }
  }
  if (!stale.length) return out;
  for (const s of stale) warnings.push(`Ignored ${s}: Versions/Current points to another version (left over from an update).`);
  return out.filter((e) => !stale.some((s) => e.rel === s || e.rel.startsWith(`${s}/`)));
}

function summarizeInfo(info: PlistDict): InfoSummary {
  const urlSchemes: string[] = [];
  const urlTypes = info.CFBundleURLTypes;
  if (Array.isArray(urlTypes)) {
    for (const t of urlTypes) {
      if (!isDict(t) || !Array.isArray(t.CFBundleURLSchemes)) continue;
      for (const s of t.CFBundleURLSchemes) if (typeof s === 'string') urlSchemes.push(s.toLowerCase());
    }
  }
  const privacyUsage: Record<string, string> = {};
  for (const [k, v] of Object.entries(info)) {
    if (/UsageDescription$/.test(k)) privacyUsage[k] = str(v) ?? '';
  }
  const ats = isDict(info.NSAppTransportSecurity) ? info.NSAppTransportSecurity : {};
  const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'YES' || v === 'true';
  return {
    executable: str(info.CFBundleExecutable),
    minimumSystemVersion: str(info.LSMinimumSystemVersion),
    urlSchemes: sortedUnique(urlSchemes),
    privacyUsage,
    atsArbitraryLoads:
      truthy(ats.NSAllowsArbitraryLoads) || truthy(ats.NSAllowsArbitraryLoadsInWebContent) || truthy(ats.NSAllowsArbitraryLoadsForMedia),
    atsExceptionDomains: isDict(ats.NSExceptionDomains) ? sortedUnique(Object.keys(ats.NSExceptionDomains)) : [],
    backgroundOnly: truthy(info.LSUIElement) || truthy(info.LSBackgroundOnly),
    sparkleFeedUrl: str(info.SUFeedURL),
    sparklePublicKey: str(info.SUPublicEDKey) ?? str(info.SUPublicDSAKeyFile),
    privilegedExecutables: isDict(info.SMPrivilegedExecutables) ? sortedUnique(Object.keys(info.SMPrivilegedExecutables)) : [],
  };
}

const BUNDLE_SUFFIXES: Array<[string, CodeKind]> = [
  ['.app', 'helperApp'],
  ['.xpc', 'xpcService'],
  ['.appex', 'appExtension'],
  ['.systemextension', 'systemExtension'],
  ['.framework', 'framework'],
  ['.bundle', 'plugin'],
  ['.plugin', 'plugin'],
  ['.docktileplugin', 'plugin'],
  ['.qlgenerator', 'plugin'],
  ['.mdimporter', 'plugin'],
  ['.saver', 'plugin'],
];

interface NestedBundle {
  kind: CodeKind;
  rel: string;
  infoPath?: string;
  /** Bundle-relative path of the bundle's executable, when known. */
  executable?: string;
}

function findFrameworkInfo(fw: string, byRel: Map<string, Entry>, entries: Entry[]): { info?: string; versionDir?: string } {
  for (const candidate of [`${fw}/Resources/Info.plist`, `${fw}/Info.plist`]) {
    if (byRel.has(candidate)) return { info: candidate, versionDir: fw };
  }
  const re = new RegExp(`^${fw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Versions/([^/]+)/Resources/Info\\.plist$`);
  for (const e of entries) {
    const m = re.exec(e.rel);
    if (m) return { info: e.rel, versionDir: `${fw}/Versions/${m[1]}` };
  }
  return {};
}

function backgroundItemFrom(kind: BackgroundItem['kind'], file: string, plist: PlistDict | undefined): BackgroundItem {
  const args = plist?.ProgramArguments;
  const program =
    str(plist?.Program) ?? str(plist?.BundleProgram) ?? (Array.isArray(args) && typeof args[0] === 'string' ? args[0] : undefined);
  const keepAlive = plist?.KeepAlive;
  return {
    kind,
    file,
    label: str(plist?.Label),
    program,
    runAtLoad: plist?.RunAtLoad === true,
    keepAlive: keepAlive === true || isDict(keepAlive),
  };
}

async function fingerprintOf(appPath: string, infoPath: string, mainExe: string | undefined): Promise<string> {
  const hash = createHash('sha256');
  try {
    hash.update(await readFile(join(appPath, 'Contents/_CodeSignature/CodeResources')));
    hash.update('sealed');
  } catch {
    hash.update(await readFile(infoPath));
    if (mainExe) {
      try {
        const st = await stat(join(appPath, mainExe));
        hash.update(`${st.size}:${st.mtimeMs}`);
      } catch {
        // No executable: the Info.plist alone identifies the bundle.
      }
    }
  }
  return hash.digest('hex').slice(0, 32);
}

/** Reads the Info.plist identity of a bundle without scanning it. */
export async function readIdentity(appPath: string): Promise<{ bundleId: string; name: string; version: string; build: string } | undefined> {
  const info = await readPlistFile(join(appPath, 'Contents/Info.plist'));
  if (!info) return undefined;
  const name = str(info.CFBundleDisplayName) ?? str(info.CFBundleName) ?? basename(appPath).replace(/\.app$/, '');
  return {
    bundleId: str(info.CFBundleIdentifier) ?? `unknown.${name}`,
    name,
    version: str(info.CFBundleShortVersionString) ?? str(info.CFBundleVersion) ?? '0',
    build: str(info.CFBundleVersion) ?? '',
  };
}

export async function quickFingerprint(appPath: string): Promise<string | undefined> {
  const infoPath = join(appPath, 'Contents/Info.plist');
  const info = await readPlistFile(infoPath);
  if (!info) return undefined;
  const exe = str(info.CFBundleExecutable);
  return fingerprintOf(appPath, infoPath, exe ? `Contents/MacOS/${exe}` : undefined);
}

const CPU_TYPE_ARM64 = 0x0100000c;

/**
 * Returns the arm64 slice of a universal (fat) Mach-O header, else the first slice.
 * Returns undefined for a thin binary. Exported for tests.
 */
export function pickFatSlice(head: Buffer, fileSize: number): { offset: number; size: number } | undefined {
  if (head.length < 8) return undefined;
  const magic = head.readUInt32BE(0);
  const is64 = magic === 0xcafebabf;
  if (magic !== 0xcafebabe && !is64) return undefined;
  const count = head.readUInt32BE(4);
  // Java class files share 0xcafebabe; their "count" is a version number well above 30.
  if (count === 0 || count > 30) return undefined;
  const entrySize = is64 ? 32 : 20;
  let first: { offset: number; size: number } | undefined;
  for (let i = 0; i < count; i++) {
    const at = 8 + i * entrySize;
    if (at + entrySize > head.length) break;
    const cpu = head.readUInt32BE(at);
    const offset = is64 ? Number(head.readBigUInt64BE(at + 8)) : head.readUInt32BE(at + 8);
    const size = is64 ? Number(head.readBigUInt64BE(at + 16)) : head.readUInt32BE(at + 12);
    if (offset + size > fileSize) continue;
    const slice = { offset, size };
    if (cpu === CPU_TYPE_ARM64) return slice;
    first ??= slice;
  }
  return first;
}

/**
 * A file with more bare hostnames than this is treated as a bundled data list (the
 * Public Suffix List, a blocklist…) rather than code that talks to those hosts.
 */
export const DOMAIN_LIST_THRESHOLD = 1000;

class HostScanner {
  readonly hosts: HostMap = new Map();
  filesScanned = 0;
  bytesScanned = 0;
  readonly truncatedFiles: string[] = [];
  readonly domainLists: Array<{ where: string; count: number }> = [];
  totalLimitHit = false;
  private readonly maxFile: number;
  private readonly maxTotal: number;

  constructor(maxFile: number, maxTotal: number) {
    this.maxFile = maxFile;
    this.maxTotal = maxTotal;
  }

  private budget(size: number, where: string): number {
    const left = this.maxTotal - this.bytesScanned;
    if (left <= 0) {
      this.totalLimitHit = true;
      return 0;
    }
    const n = Math.min(size, this.maxFile, left);
    if (n < size) this.truncatedFiles.push(where);
    return n;
  }

  /** Merges one file's hosts, dropping bare-string hosts from bundled domain lists. */
  private commit(found: HostMap, where: string): void {
    let bare = 0;
    for (const rec of found.values()) if (!rec.viaUrl) bare++;
    if (bare > DOMAIN_LIST_THRESHOLD) {
      this.domainLists.push({ where, count: bare });
      for (const [host, rec] of found) if (!rec.viaUrl) found.delete(host);
    }
    mergeHosts(this.hosts, found);
  }

  scanBuffer(buf: Buffer, where: string, binary: boolean): void {
    this.filesScanned++;
    this.bytesScanned += buf.length;
    this.commit(extractHosts(buf.toString(binary ? 'latin1' : 'utf8'), where, new Map(), true), where);
  }

  async scanFile(abs: string, size: number, where: string, binary: boolean): Promise<void> {
    let fh;
    try {
      fh = await open(abs, 'r');
      let start = 0;
      let length = size;
      if (binary) {
        // A universal binary repeats its strings in every architecture slice; read one.
        const head = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(head, 0, head.length, 0);
        const slice = pickFatSlice(head.subarray(0, bytesRead), size);
        if (slice) ({ offset: start, size: length } = slice);
      }
      const n = this.budget(length, where);
      if (n <= 0) return;
      this.filesScanned++;
      const CHUNK = 64 * 1024 * 1024;
      const OVERLAP = 1024;
      const found: HostMap = new Map();
      for (let pos = 0; pos < n; pos += CHUNK) {
        const len = Math.min(CHUNK + OVERLAP, n - pos);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, start + pos);
        this.bytesScanned += Math.min(bytesRead, CHUNK);
        extractHosts(buf.toString(binary ? 'latin1' : 'utf8', 0, bytesRead), where, found, true);
        if (bytesRead < len) break;
      }
      this.commit(found, where);
    } catch {
      // Unreadable files are skipped; permissions are reported by the walk.
    } finally {
      await fh?.close();
    }
  }

  scanAsarFile(archive: AsarArchive, file: AsarFile, where: string): void {
    const n = this.budget(file.size, where);
    if (n <= 0) return;
    this.scanBuffer(archive.read(file, n), where, false);
  }
}

function addPackage(packages: Record<string, string[]>, json: string): void {
  try {
    const pkg = JSON.parse(json) as { name?: unknown; version?: unknown };
    if (typeof pkg.name !== 'string' || !pkg.name) return;
    const version = typeof pkg.version === 'string' ? pkg.version : '?';
    const list = (packages[pkg.name] ??= []);
    if (!list.includes(version)) list.push(version);
  } catch {
    // Not every package.json parses (templates, fixtures).
  }
}

const NODE_MODULES_MANIFEST_RE = /(^|\/)node_modules\/(@[^/]+\/)?[^/]+\/package\.json$/;

/** Scans an app bundle and returns a snapshot. Never modifies the bundle. */
export async function scanBundle(inputPath: string, options: ScanOptions = {}): Promise<Snapshot> {
  const started = Date.now();
  const appPath = await realpath(inputPath);
  const infoPath = join(appPath, 'Contents/Info.plist');
  const info = await readPlistFile(infoPath);
  if (!info) throw new Error(`${inputPath} is not an app bundle (no readable Contents/Info.plist)`);

  const warnings: string[] = [];
  const deep = options.deep === true;
  const MB = 1024 * 1024;
  const maxFile = options.maxFileBytes ?? (deep ? 2048 : 512) * MB;
  const maxTotal = options.maxTotalBytes ?? (deep ? 8192 : 4096) * MB;
  const scanner = new HostScanner(maxFile, maxTotal);

  const name = str(info.CFBundleDisplayName) ?? str(info.CFBundleName) ?? basename(appPath).replace(/\.app$/, '');
  const summary = summarizeInfo(info);
  const mainExe = summary.executable ? `Contents/MacOS/${summary.executable}` : undefined;

  const entries = await walk(appPath, warnings);
  const byRel = new Map(entries.map((e) => [e.rel, e]));
  const files = entries.filter((e) => !e.isDir);

  // Nested bundles.
  const nested: NestedBundle[] = [];
  for (const e of entries) {
    if (!e.isDir) continue;
    const suffix = BUNDLE_SUFFIXES.find(([s]) => e.rel.endsWith(s));
    if (!suffix) continue;
    let kind = suffix[1];
    if (kind === 'helperApp' && /(^|\/)Contents\/Library\/LoginItems\/[^/]+\.app$/.test(e.rel)) kind = 'loginItem';
    if (kind === 'framework') {
      const { info: fwInfo, versionDir } = findFrameworkInfo(e.rel, byRel, entries);
      const fwName = basename(e.rel, '.framework');
      nested.push({ kind, rel: e.rel, infoPath: fwInfo, executable: versionDir ? `${versionDir}/${fwName}` : undefined });
    } else {
      const ip = `${e.rel}/Contents/Info.plist`;
      // Resource folders also end in .bundle; only bundles with an Info.plist hold code.
      if (kind === 'plugin' && !byRel.has(ip)) continue;
      nested.push({ kind, rel: e.rel, infoPath: byRel.has(ip) ? ip : undefined });
    }
  }

  const code: CodeItem[] = [];
  const bundleExecutables = new Set<string>(mainExe ? [mainExe] : []);

  const nestedItems = await mapLimit(nested, 6, async (b): Promise<CodeItem> => {
    const plist = b.infoPath ? await readPlistFile(join(appPath, b.infoPath)) : undefined;
    const exeName = str(plist?.CFBundleExecutable);
    if (b.kind === 'framework') {
      if (b.executable) {
        const dir = b.executable.slice(0, b.executable.lastIndexOf('/'));
        bundleExecutables.add(exeName ? `${dir}/${exeName}` : b.executable);
      }
    } else if (exeName) {
      bundleExecutables.add(`${b.rel}/Contents/MacOS/${exeName}`);
    }
    const item: CodeItem = {
      kind: b.kind,
      key: normalizeKey(b.rel),
      path: b.rel,
      bundleId: str(plist?.CFBundleIdentifier),
      version: str(plist?.CFBundleShortVersionString) ?? str(plist?.CFBundleVersion),
    };
    item.signing = await readSigning(join(appPath, b.rel));
    if (b.kind !== 'framework') item.entitlements = await readEntitlements(join(appPath, b.rel));
    return item;
  });

  // Privileged helpers installed through SMJobBless.
  const helperFiles = files.filter((f) => /(^|\/)Contents\/Library\/LaunchServices\/[^/]+$/.test(f.rel));
  const helperItems = await mapLimit(helperFiles, 4, async (f): Promise<CodeItem> => {
    bundleExecutables.add(f.rel);
    return {
      kind: 'privilegedHelper',
      key: normalizeKey(f.rel),
      path: f.rel,
      signing: await readSigning(f.abs),
      entitlements: await readEntitlements(f.abs),
    };
  });

  // Loose executables and native Node modules.
  const candidates = files.filter((f) => (f.mode & 0o111) !== 0 || f.rel.endsWith('.node'));
  const machoFlags = await mapLimit(candidates, 16, (f) => isMachO(f.abs));
  const machoFiles = candidates.filter((_, i) => machoFlags[i]);
  const looseItems: CodeItem[] = [];
  for (const f of machoFiles) {
    if (bundleExecutables.has(f.rel)) continue;
    if (/\.(dylib|so)$/.test(f.rel)) continue;
    if (f.rel.endsWith('.node')) {
      looseItems.push({ kind: 'nativeModule', key: normalizeKey(f.rel), path: f.rel });
    } else {
      looseItems.push({ kind: 'executable', key: normalizeKey(f.rel), path: f.rel });
    }
  }
  const looseSigned = await mapLimit(looseItems, 6, async (item) => {
    if (item.kind === 'executable') {
      item.signing = await readSigning(join(appPath, item.path));
      item.entitlements = await readEntitlements(join(appPath, item.path));
    }
    return item;
  });

  const mainItem: CodeItem = {
    kind: 'main',
    key: mainExe ?? 'Contents/MacOS',
    path: mainExe ?? 'Contents/MacOS',
    bundleId: str(info.CFBundleIdentifier),
    version: str(info.CFBundleShortVersionString),
    signing: await readSigning(appPath),
    entitlements: await readEntitlements(appPath),
  };
  code.push(mainItem, ...nestedItems, ...helperItems, ...looseSigned);
  code.sort((a, b) => a.key.localeCompare(b.key));

  // Background items registered with SMAppService.
  const backgroundItems: BackgroundItem[] = [];
  for (const f of files) {
    const m = /(^|\/)Contents\/Library\/(LaunchAgents|LaunchDaemons)\/[^/]+\.plist$/.exec(f.rel);
    if (!m) continue;
    const plist = await readPlistFile(f.abs);
    backgroundItems.push(backgroundItemFrom(m[2] === 'LaunchAgents' ? 'launchAgent' : 'launchDaemon', f.rel, plist));
  }
  backgroundItems.sort((a, b) => a.file.localeCompare(b.file));

  // Hostnames in executables.
  const insideFramework = (rel: string): boolean => /\.framework\//.test(rel);
  const binaryTargets = machoFiles.filter((f) => deep || !insideFramework(f.rel) || f.rel.endsWith('.node'));
  for (const f of binaryTargets) await scanner.scanFile(f.abs, f.size, f.rel, true);

  // Hostnames in plain text resources, including unpacked Electron code.
  for (const f of files) {
    if (!deep && insideFramework(f.rel)) continue;
    if (!isScannableText(f.rel)) continue;
    await scanner.scanFile(f.abs, f.size, f.rel, false);
  }

  // Electron.
  const packages: Record<string, string[]> = {};
  for (const f of files) if (NODE_MODULES_MANIFEST_RE.test(f.rel) && f.size < 1024 * 1024) addPackage(packages, await readFile(f.abs, 'utf8'));

  const electronFramework = nestedItems.find((c) => c.kind === 'framework' && c.path.endsWith('/Electron Framework.framework'));
  const asarFiles = files.filter((f) => f.rel.endsWith('.asar') && !insideFramework(f.rel));
  const appDir = entries.find((e) => e.isDir && e.rel === 'Contents/Resources/app');
  let electron: ElectronInfo | undefined;
  if (electronFramework || asarFiles.length || appDir) {
    electron = { electronVersion: electronFramework?.version, packages, fileCount: 0 };
    const primary = asarFiles.find((f) => f.rel === 'Contents/Resources/app.asar');
    if (primary) electron.appSource = primary.rel;
    else if (appDir) electron.appSource = appDir.rel;
    else if (asarFiles[0]) electron.appSource = asarFiles[0].rel;

    if (appDir && !primary) {
      const rootPkg = byRel.get('Contents/Resources/app/package.json');
      if (rootPkg) {
        try {
          const pkg = JSON.parse(await readFile(rootPkg.abs, 'utf8')) as { name?: string; productName?: string; version?: string };
          electron.appName = pkg.productName ?? pkg.name;
          electron.appVersion = pkg.version;
        } catch {
          warnings.push('Could not parse Contents/Resources/app/package.json');
        }
      }
    }

    for (const af of asarFiles) {
      let archive: AsarArchive;
      try {
        archive = AsarArchive.open(af.abs);
      } catch (err) {
        warnings.push(`Could not read ${af.rel}: ${(err as Error).message}`);
        continue;
      }
      try {
        for (const file of archive.files()) {
          electron.fileCount++;
          // Unpacked files are on disk and were scanned with the other files.
          if (file.unpacked) continue;
          if (file.path === 'package.json' && af === primary) {
            try {
              const pkg = JSON.parse(archive.read(file).toString('utf8')) as { name?: string; productName?: string; version?: string };
              electron.appName = pkg.productName ?? pkg.name;
              electron.appVersion = pkg.version;
            } catch {
              warnings.push(`Could not parse package.json in ${af.rel}`);
            }
          }
          if (NODE_MODULES_MANIFEST_RE.test(file.path) && file.size < 1024 * 1024) {
            addPackage(packages, archive.read(file).toString('utf8'));
          }
          if (isScannableText(file.path)) scanner.scanAsarFile(archive, file, `${af.rel}:${file.path}`);
        }
      } finally {
        archive.close();
      }
    }
    for (const list of Object.values(packages)) list.sort();
  }

  if (scanner.truncatedFiles.length) {
    const shown = scanner.truncatedFiles.slice(0, 3).join(', ');
    const more = scanner.truncatedFiles.length > 3 ? ` and ${scanner.truncatedFiles.length - 3} more` : '';
    warnings.push(`Read only the first ${Math.round(maxFile / MB)} MB of ${shown}${more} for hostnames.`);
  }
  if (scanner.totalLimitHit) warnings.push(`Stopped reading for hostnames after ${Math.round(maxTotal / MB)} MB in total.`);
  for (const list of scanner.domainLists) {
    warnings.push(`Skipped ${list.count} bare hostnames in ${list.where}: it looks like a bundled domain list, not code.`);
  }

  const hosts: Snapshot['hosts'] = {};
  for (const host of [...scanner.hosts.keys()].sort()) hosts[host] = scanner.hosts.get(host)!;

  const fileCount = files.length;
  const sizeBytes = files.reduce((sum, f) => sum + f.size, 0);

  return {
    schema: SNAPSHOT_SCHEMA,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    takenAt: new Date().toISOString(),
    fingerprint: await fingerprintOf(appPath, infoPath, mainExe),
    app: {
      path: appPath,
      name,
      bundleId: str(info.CFBundleIdentifier) ?? `unknown.${name}`,
      version: str(info.CFBundleShortVersionString) ?? str(info.CFBundleVersion) ?? '0',
      build: str(info.CFBundleVersion) ?? '',
      sizeBytes,
      fileCount,
    },
    info: summary,
    signing: mainItem.signing!,
    code,
    backgroundItems,
    electron,
    hosts,
    stats: {
      scanMs: Date.now() - started,
      filesScanned: scanner.filesScanned,
      bytesScanned: scanner.bytesScanned,
      deep,
      warnings,
    },
  };
}

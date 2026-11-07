import { existsSync } from 'node:fs';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isScannableText } from './bundle.ts';
import { CATEGORY_ORDER, SEVERITY_ORDER } from './diff.ts';
import { extractHosts, mergeHosts, registrableDomain, type HostMap } from './hosts.ts';
import type { DiffReport, Finding, Severity } from './types.ts';
import { sortedUnique } from './util.ts';

export type ExtensionHost = 'chrome' | 'brave' | 'edge' | 'arc' | 'vivaldi' | 'chromium' | 'firefox' | 'vscode' | 'cursor' | 'windsurf' | 'vscodium';

export interface ExtensionRecord {
  host: ExtensionHost;
  /** "Chrome", "Firefox", "VS Code"… */
  hostName: string;
  kind: 'browser' | 'editor';
  profile?: string;
  id: string;
  name: string;
  version: string;
  path: string;
  // Browser extensions.
  permissions: string[];
  hostPermissions: string[];
  optionalPermissions: string[];
  contentScriptMatches: string[];
  updateUrl?: string;
  manifestVersion?: number;
  active?: boolean;
  // Editor extensions.
  publisher?: string;
  activationEvents?: string[];
  extensionDependencies?: string[];
  extensionPack?: string[];
  npmDependencies?: string[];
  nativeBinaries?: string[];
  domains?: string[];
}

export interface ExtensionsSnapshot {
  schema: 1;
  takenAt: string;
  extensions: ExtensionRecord[];
}

const CHROMIUM: Array<{ host: ExtensionHost; name: string; dir: string }> = [
  { host: 'chrome', name: 'Chrome', dir: 'Google/Chrome' },
  { host: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser' },
  { host: 'edge', name: 'Edge', dir: 'Microsoft Edge' },
  { host: 'arc', name: 'Arc', dir: 'Arc/User Data' },
  { host: 'vivaldi', name: 'Vivaldi', dir: 'Vivaldi' },
  { host: 'chromium', name: 'Chromium', dir: 'Chromium' },
];

const EDITORS: Array<{ host: ExtensionHost; name: string; dir: string }> = [
  { host: 'vscode', name: 'VS Code', dir: '.vscode' },
  { host: 'cursor', name: 'Cursor', dir: '.cursor' },
  { host: 'windsurf', name: 'Windsurf', dir: '.windsurf' },
  { host: 'vscodium', name: 'VSCodium', dir: '.vscode-oss' },
];

/** Where to look: the user's home, or `$UPDIFF_EXTENSIONS_ROOT` (for tests). */
export function extensionsRoot(): string {
  return process.env.UPDIFF_EXTENSIONS_ROOT || homedir();
}

/** Compares dotted versions numerically: "1.10.0" > "1.9.2". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[._-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[._-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isNaN(pa[i] ?? 0) ? 0 : (pa[i] ?? 0);
    const y = Number.isNaN(pb[i] ?? 0) ? 0 : (pb[i] ?? 0);
    if (x !== y) return x - y;
  }
  return a.localeCompare(b);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

type Json = Record<string, unknown>;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/** Resolves "__MSG_extName__" from the extension's default locale. */
async function localized(dir: string, value: unknown, defaultLocale: unknown): Promise<string | undefined> {
  if (typeof value !== 'string') return undefined;
  const m = /^__MSG_(.+)__$/.exec(value);
  if (!m) return value;
  for (const locale of [defaultLocale, 'en', 'en_US'].filter((x): x is string => typeof x === 'string')) {
    const messages = asObj(await readJson(join(dir, '_locales', locale, 'messages.json')));
    const key = Object.keys(messages).find((k) => k.toLowerCase() === m[1]!.toLowerCase());
    const msg = key ? asObj(messages[key]).message : undefined;
    if (typeof msg === 'string') return msg;
  }
  return value;
}

async function chromiumExtensions(base: string, host: ExtensionHost, hostName: string): Promise<ExtensionRecord[]> {
  const out: ExtensionRecord[] = [];
  let profiles: string[];
  try {
    profiles = (await readdir(base, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const profile of profiles) {
    const extDir = join(base, profile, 'Extensions');
    let ids: string[];
    try {
      ids = (await readdir(extDir)).filter((n) => /^[a-p]{32}$/.test(n));
    } catch {
      continue;
    }
    for (const id of ids) {
      // Chrome keeps the previous version until restart; the highest one is current.
      const versions = (await readdir(join(extDir, id))).filter((v) => existsSync(join(extDir, id, v, 'manifest.json'))).sort(compareVersions);
      const v = versions.at(-1);
      if (!v) continue;
      const dir = join(extDir, id, v);
      const m = asObj(await readJson(join(dir, 'manifest.json')));
      const mv = typeof m.manifest_version === 'number' ? m.manifest_version : undefined;
      // MV2 mixes host patterns into "permissions"; split them out.
      const perms = strings(m.permissions);
      const isPattern = (p: string): boolean => p === '<all_urls>' || p.includes('://');
      const contentScripts = Array.isArray(m.content_scripts) ? m.content_scripts.flatMap((c) => strings(asObj(c).matches)) : [];
      out.push({
        host,
        hostName,
        kind: 'browser',
        profile,
        id,
        name: (await localized(dir, m.name, m.default_locale)) ?? id,
        version: typeof m.version === 'string' ? m.version : v,
        path: dir,
        permissions: sortedUnique(perms.filter((p) => !isPattern(p))),
        hostPermissions: sortedUnique([...strings(m.host_permissions), ...perms.filter(isPattern)]),
        optionalPermissions: sortedUnique([...strings(m.optional_permissions), ...strings(m.optional_host_permissions)]),
        contentScriptMatches: sortedUnique(contentScripts),
        ...(typeof m.update_url === 'string' ? { updateUrl: m.update_url } : {}),
        ...(mv !== undefined ? { manifestVersion: mv } : {}),
      });
    }
  }
  return out;
}

async function firefoxExtensions(base: string): Promise<ExtensionRecord[]> {
  const out: ExtensionRecord[] = [];
  let profiles: string[];
  try {
    profiles = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const profile of profiles) {
    const db = asObj(await readJson(join(base, profile, 'extensions.json')));
    for (const a of Array.isArray(db.addons) ? db.addons.map(asObj) : []) {
      // Only add-ons the user installed: not system add-ons or built-in themes.
      if (a.type !== 'extension' || a.location !== 'app-profile' || typeof a.id !== 'string') continue;
      // signedState 3 is "privileged": Mozilla's own add-ons (New Tab and the like), shipped by Firefox itself.
      if (a.signedState === 3) continue;
      const user = asObj(a.userPermissions);
      const optional = asObj(a.optionalPermissions);
      out.push({
        host: 'firefox',
        hostName: 'Firefox',
        kind: 'browser',
        // "wm2l86yg.default-release" → "default-release"
        profile: profile.replace(/^[a-z0-9]{8}\./, ''),
        id: a.id,
        name: typeof asObj(a.defaultLocale).name === 'string' ? (asObj(a.defaultLocale).name as string) : a.id,
        version: typeof a.version === 'string' ? a.version : '?',
        path: typeof a.path === 'string' ? a.path : join(base, profile),
        permissions: sortedUnique(strings(user.permissions)),
        hostPermissions: sortedUnique(strings(user.origins)),
        optionalPermissions: sortedUnique([...strings(optional.permissions), ...strings(optional.origins)]),
        contentScriptMatches: [],
        ...(typeof a.updateURL === 'string' ? { updateUrl: a.updateURL } : {}),
        active: a.active === true,
      });
    }
  }
  return out;
}

const MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

/** Domains in an editor extension's code and the native binaries it ships. */
async function scanEditorExtension(dir: string, budgetBytes: number): Promise<{ domains: string[]; nativeBinaries: string[] }> {
  const hosts: HostMap = new Map();
  const native: string[] = [];
  let used = 0;
  const queue = [''];
  while (queue.length) {
    const rel = queue.pop()!;
    let dirents;
    try {
      dirents = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        queue.push(r);
        continue;
      }
      if (!d.isFile()) continue;
      const abs = join(dir, r);
      if (d.name.endsWith('.node') || /\.(dylib|so)$/.test(d.name) || ((await lstat(abs)).mode & 0o111) !== 0) {
        const fh = await open(abs, 'r');
        const head = Buffer.alloc(4);
        await fh.read(head, 0, 4, 0);
        await fh.close();
        if (MACHO.has(head.readUInt32BE(0))) native.push(r);
        continue;
      }
      if (!isScannableText(r) || used >= budgetBytes) continue;
      const text = await readFile(abs, 'utf8');
      used += text.length;
      const found = extractHosts(text, r, new Map(), true);
      // A file with over a thousand bare hostnames is a bundled list, not code.
      const bare = [...found.values()].filter((h) => !h.viaUrl).length;
      if (bare > 1000) for (const [h, rec] of found) if (!rec.viaUrl) found.delete(h);
      mergeHosts(hosts, found);
    }
  }
  return { domains: sortedUnique([...hosts.keys()].map(registrableDomain)), nativeBinaries: native.sort() };
}

async function editorExtensions(base: string, host: ExtensionHost, hostName: string, scanCode: boolean): Promise<ExtensionRecord[]> {
  const extDir = join(base, 'extensions');
  let dirs: string[];
  try {
    dirs = (await readdir(extDir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch {
    return [];
  }
  // Several versions can sit side by side until the editor restarts; keep the highest per id.
  const best = new Map<string, { dir: string; pkg: Json }>();
  for (const name of dirs) {
    const pkg = asObj(await readJson(join(extDir, name, 'package.json')));
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue;
    const id = `${typeof pkg.publisher === 'string' ? pkg.publisher : 'unknown'}.${pkg.name}`.toLowerCase();
    const cur = best.get(id);
    if (!cur || compareVersions(pkg.version, cur.pkg.version as string) > 0) best.set(id, { dir: join(extDir, name), pkg });
  }
  const out: ExtensionRecord[] = [];
  for (const [id, { dir, pkg }] of best) {
    let display = typeof pkg.displayName === 'string' ? pkg.displayName : (pkg.name as string);
    const nls = /^%(.+)%$/.exec(display);
    if (nls) {
      const strs = asObj(await readJson(join(dir, 'package.nls.json')));
      const v = strs[nls[1]!];
      if (typeof v === 'string') display = v;
    }
    const code = scanCode ? await scanEditorExtension(dir, 64 * 1024 * 1024) : { domains: [], nativeBinaries: [] };
    out.push({
      host,
      hostName,
      kind: 'editor',
      id,
      name: display,
      version: pkg.version as string,
      path: dir,
      permissions: [],
      hostPermissions: [],
      optionalPermissions: [],
      contentScriptMatches: [],
      ...(typeof pkg.publisher === 'string' ? { publisher: pkg.publisher } : {}),
      activationEvents: sortedUnique(strings(pkg.activationEvents)),
      extensionDependencies: sortedUnique(strings(pkg.extensionDependencies).map((x) => x.toLowerCase())),
      extensionPack: sortedUnique(strings(pkg.extensionPack).map((x) => x.toLowerCase())),
      npmDependencies: sortedUnique(Object.keys(asObj(pkg.dependencies))),
      nativeBinaries: code.nativeBinaries,
      domains: code.domains,
    });
  }
  return out;
}

/** Finds installed browser and editor extensions. */
export async function discoverExtensions(options: { root?: string; scanCode?: boolean } = {}): Promise<ExtensionRecord[]> {
  const root = options.root ?? extensionsRoot();
  const support = join(root, 'Library', 'Application Support');
  const found: ExtensionRecord[] = [];
  for (const b of CHROMIUM) found.push(...(await chromiumExtensions(join(support, b.dir), b.host, b.name)));
  found.push(...(await firefoxExtensions(join(support, 'Firefox', 'Profiles'))));
  for (const e of EDITORS) found.push(...(await editorExtensions(join(root, e.dir), e.host, e.name, options.scanCode !== false)));
  return found.sort((a, b) => a.hostName.localeCompare(b.hostName) || (a.profile ?? '').localeCompare(b.profile ?? '') || a.name.localeCompare(b.name));
}

export function extensionKey(e: ExtensionRecord): string {
  return `${e.host}|${e.profile ?? ''}|${e.id}`;
}

// ── Risk rules ────────────────────────────────────────────────────────────────

/** Permissions that reach browsing data, the network or other software. */
const SENSITIVE_PERMISSIONS = new Set([
  'cookies', 'history', 'webRequest', 'webRequestBlocking', 'debugger', 'nativeMessaging', 'management', 'proxy', 'privacy',
  'clipboardRead', 'desktopCapture', 'tabCapture', 'browsingData', 'contentSettings', 'declarativeNetRequestWithHostAccess',
  'webNavigation', 'downloads', 'pageCapture', 'scripting', 'userScripts', 'vpnProvider', 'certificateProvider',
]);
/** Permissions with little reach on their own. */
const LOW_PERMISSIONS = new Set([
  'storage', 'unlimitedStorage', 'alarms', 'contextMenus', 'notifications', 'offscreen', 'idle', 'sidePanel', 'i18n',
  'fontSettings', 'power', 'tts', 'theme', 'menus', 'activeTab', 'action', 'commands',
]);

/** A host pattern that matches every website. */
export function isBroadPattern(p: string): boolean {
  return p === '<all_urls>' || /^(\*|https?|wss?|file):\/\/\*?\/\*?$/.test(p) || /^(\*|https?):\/\/\*\/.*$/.test(p);
}

function permissionSeverity(p: string): Severity {
  if (SENSITIVE_PERMISSIONS.has(p)) return 'high';
  return LOW_PERMISSIONS.has(p) ? 'info' : 'notable';
}

const ALWAYS_ON = new Set(['*', 'onStartupFinished']);

function label(e: ExtensionRecord): string {
  return `${e.name} (${e.hostName}${e.profile && e.profile !== 'Default' ? `, ${e.profile}` : ''})`;
}

function describeNew(e: ExtensionRecord): string {
  if (e.kind === 'editor') {
    const parts = [`v${e.version}`];
    if (e.activationEvents?.some((x) => ALWAYS_ON.has(x))) parts.push('starts with every window');
    if (e.extensionPack?.length || e.extensionDependencies?.length) parts.push(`pulls in ${[...(e.extensionPack ?? []), ...(e.extensionDependencies ?? [])].join(', ')}`);
    if (e.nativeBinaries?.length) parts.push(`${e.nativeBinaries.length} native binar${e.nativeBinaries.length === 1 ? 'y' : 'ies'}`);
    return parts.join(' · ');
  }
  const sites = [...e.hostPermissions, ...e.contentScriptMatches];
  return [`v${e.version}`, e.permissions.length ? `permissions: ${e.permissions.join(', ')}` : undefined, sites.length ? `sites: ${sites.some(isBroadPattern) ? 'all websites' : sites.slice(0, 5).join(', ') + (sites.length > 5 ? '…' : '')}` : undefined]
    .filter(Boolean)
    .join(' · ');
}

function added(a: string[] | undefined, b: string[] | undefined): string[] {
  const before = new Set(a ?? []);
  return (b ?? []).filter((x) => !before.has(x));
}

function diffOne(a: ExtensionRecord, b: ExtensionRecord, out: Finding[]): void {
  const who = label(b);
  const where = [`${b.hostName} ${b.id}`];
  const versionNote = a.version !== b.version ? ` in ${b.version}` : '';
  if (b.kind === 'browser') {
    for (const p of added(a.permissions, b.permissions)) {
      out.push({ severity: permissionSeverity(p), category: 'permission', change: 'added', title: `${who} gained the "${p}" permission${versionNote}`, where });
    }
    const sitesA = [...a.hostPermissions, ...a.contentScriptMatches];
    const newSites = added(sitesA, [...b.hostPermissions, ...b.contentScriptMatches]);
    if (newSites.some(isBroadPattern) && !sitesA.some(isBroadPattern)) {
      out.push({ severity: 'high', category: 'permission', change: 'added', title: `${who} can now read and change all websites${versionNote}`, detail: newSites.filter(isBroadPattern).join(', '), where });
    }
    const specific = newSites.filter((s) => !isBroadPattern(s));
    if (specific.length) {
      out.push({ severity: 'notable', category: 'permission', change: 'added', title: `${who} gained access to ${specific.length} more site${specific.length === 1 ? '' : 's'}${versionNote}`, detail: specific.join(', '), where });
    }
    const optional = added(a.optionalPermissions, b.optionalPermissions);
    if (optional.length) out.push({ severity: 'info', category: 'permission', change: 'added', title: `${who} can now ask for more permissions later`, detail: optional.join(', '), where });
    const lost = [...added(b.permissions, a.permissions), ...added([...b.hostPermissions, ...b.contentScriptMatches], sitesA)];
    if (lost.length) out.push({ severity: 'info', category: 'permission', change: 'removed', title: `${who} dropped permissions`, detail: lost.join(', '), where });
    if (a.updateUrl && b.updateUrl && a.updateUrl !== b.updateUrl) {
      out.push({ severity: 'high', category: 'updater', change: 'changed', title: `${who} now updates from a different server`, detail: `${a.updateUrl} → ${b.updateUrl}`, where });
    }
    if (a.manifestVersion && b.manifestVersion && a.manifestVersion !== b.manifestVersion) {
      out.push({ severity: 'info', category: 'code', change: 'changed', title: `${who} moved to Manifest V${b.manifestVersion}`, where });
    }
  } else {
    const pulled = added([...(a.extensionPack ?? []), ...(a.extensionDependencies ?? [])], [...(b.extensionPack ?? []), ...(b.extensionDependencies ?? [])]);
    if (pulled.length) {
      out.push({ severity: 'high', category: 'install', change: 'added', title: `${who} now installs other extensions${versionNote}`, detail: pulled.join(', '), where });
    }
    if (!a.activationEvents?.some((x) => ALWAYS_ON.has(x)) && b.activationEvents?.some((x) => ALWAYS_ON.has(x))) {
      out.push({ severity: 'notable', category: 'background', change: 'changed', title: `${who} now starts with every editor window${versionNote}`, detail: b.activationEvents.filter((x) => ALWAYS_ON.has(x)).join(', '), where });
    }
    const npm = added(a.npmDependencies, b.npmDependencies);
    if (npm.length) out.push({ severity: 'notable', category: 'package', change: 'added', title: `${who} bundles ${npm.length} new npm package${npm.length === 1 ? '' : 's'}${versionNote}`, detail: npm.join(', '), where });
    const bins = added(a.nativeBinaries, b.nativeBinaries);
    if (bins.length) out.push({ severity: 'notable', category: 'code', change: 'added', title: `${who} ships new native code${versionNote}`, detail: bins.join(', '), where });
    const domains = added(a.domains, b.domains);
    if (domains.length) out.push({ severity: 'notable', category: 'host', change: 'added', title: `${who} mentions new domains${versionNote}`, detail: domains.join(', '), where });
  }
  if (a.version !== b.version) out.push({ severity: 'info', category: 'identity', change: 'changed', title: `${who} ${a.version} → ${b.version}`, where });
}

/** What changed among installed extensions between two snapshots. */
export function diffExtensions(a: ExtensionsSnapshot, b: ExtensionsSnapshot): DiffReport {
  const findings: Finding[] = [];
  const before = new Map(a.extensions.map((e) => [extensionKey(e), e]));
  for (const e of b.extensions) {
    const old = before.get(extensionKey(e));
    before.delete(extensionKey(e));
    if (!old) {
      const broad = [...e.hostPermissions, ...e.contentScriptMatches].some(isBroadPattern);
      const pulls = (e.extensionPack?.length ?? 0) + (e.extensionDependencies?.length ?? 0) > 0;
      findings.push({
        severity: broad || pulls ? 'high' : 'notable',
        category: 'install',
        change: 'added',
        title: `New extension: ${label(e)}${broad ? ' with access to all websites' : ''}`,
        detail: describeNew(e),
        where: [`${e.hostName} ${e.id}`],
      });
      continue;
    }
    diffOne(old, e, findings);
  }
  for (const gone of before.values()) findings.push({ severity: 'info', category: 'install', change: 'removed', title: `Removed extension: ${label(gone)}` });

  findings.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || CATEGORY_ORDER.indexOf(x.category) - CATEGORY_ORDER.indexOf(y.category) || x.title.localeCompare(y.title));
  const counts: Record<Severity, number> = { high: 0, notable: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const side = (s: ExtensionsSnapshot): DiffReport['from'] => ({ version: `${s.extensions.length} extensions`, build: '', takenAt: s.takenAt, path: '' });
  return {
    app: { name: 'Browser and editor extensions', bundleId: '' },
    from: side(a),
    to: side(b),
    findings,
    counts,
    identical: findings.length === 0,
  };
}

/** A readable list of installed extensions with what each one can reach. */
export function renderExtensions(list: ExtensionRecord[], options: { color?: boolean } = {}): string {
  const warn = (s: string): string => (options.color ? `\x1b[33m${s}\x1b[39m` : s);
  const dim = (s: string): string => (options.color ? `\x1b[2m${s}\x1b[22m` : s);
  const bold = (s: string): string => (options.color ? `\x1b[1m${s}\x1b[22m` : s);
  const lines: string[] = [];
  let group = '';
  for (const e of list) {
    const g = `${e.hostName}${e.profile ? ` · ${e.profile}` : ''}`;
    if (g !== group) {
      lines.push('', bold(g));
      group = g;
    }
    const notes: string[] = [];
    if (e.kind === 'browser') {
      if ([...e.hostPermissions, ...e.contentScriptMatches].some(isBroadPattern)) notes.push(warn('all websites'));
      else if (e.hostPermissions.length + e.contentScriptMatches.length) {
        const n = e.hostPermissions.length + e.contentScriptMatches.length;
        notes.push(`${n} site${n === 1 ? '' : 's'}`);
      }
      const sensitive = e.permissions.filter((p) => SENSITIVE_PERMISSIONS.has(p));
      if (sensitive.length) notes.push(warn(sensitive.join(', ')));
      if (e.active === false) notes.push(dim('disabled'));
    } else {
      if (e.activationEvents?.some((x) => ALWAYS_ON.has(x))) notes.push(warn('starts with every window'));
      if (e.nativeBinaries?.length) notes.push(`${e.nativeBinaries.length} native binar${e.nativeBinaries.length === 1 ? 'y' : 'ies'}`);
      if (e.domains?.length) notes.push(`${e.domains.length} domains in code`);
    }
    lines.push(`  ${e.name.slice(0, 44).padEnd(44)} ${e.version.slice(0, 16).padEnd(16)} ${notes.join(dim(' · '))}`);
  }
  if (!list.length) lines.push('', 'No browser or editor extensions found.');
  lines.push('', dim(`${list.length} extension${list.length === 1 ? '' : 's'}. Browsers: Chrome, Brave, Edge, Arc, Vivaldi, Chromium, Firefox. Editors: VS Code, Cursor, Windsurf, VSCodium.`));
  return lines.join('\n').replace(/^\n/, '') + '\n';
}

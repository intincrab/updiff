import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import { readIdentity } from './bundle.ts';
import { parseSpctl, readSigning } from './codesign.ts';
import { decodeEntities, readPlistFile, str } from './plist.ts';
import { run } from './exec.ts';
import type { NotarizationInfo } from './types.ts';

export interface PkgScript {
  /** Path inside the component's Scripts folder, e.g. "postinstall". */
  name: string;
  /** Runs automatically: preinstall or postinstall. Other files are helpers the scripts may call. */
  hook: boolean;
  interpreter?: string;
  binary: boolean;
  bytes: number;
  lines: number;
  content?: string;
}

export interface PkgLaunchItem {
  path: string;
  kind: 'daemon' | 'agent';
  label?: string;
  program?: string;
  runAtLoad: boolean;
  keepAlive: boolean;
}

export interface PkgApp {
  path: string;
  bundleId?: string;
  version?: string;
  teamId?: string;
}

export interface PkgComponent {
  id?: string;
  version?: string;
  installLocation: string;
  /** "root" means the installer asks for an administrator password. */
  auth?: string;
  scripts: PkgScript[];
  files: number;
  bytes: number;
  apps: PkgApp[];
  launchItems: PkgLaunchItem[];
  /** Install paths outside /Applications, collapsed to their top folders. */
  outsideApplications: string[];
  /** Kernel and system extensions, privileged helpers. */
  systemLevel: string[];
}

export interface PkgReport {
  file: string;
  sha256: string;
  bytes: number;
  signature: { status: string; signer?: string; notarized: boolean };
  gatekeeper: NotarizationInfo;
  distribution?: { title?: string; scripts: string[]; checks: string[] };
  components: PkgComponent[];
}

/** Attribute map of one XML start tag. */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = decodeEntities(m[2]!);
  return out;
}

/** Parses `pkgutil --check-signature`. */
export function parseCheckSignature(text: string): PkgReport['signature'] {
  const status = /Status:\s*(.+)/.exec(text)?.[1]?.trim() ?? 'unknown';
  const signer = /^\s*1\.\s*(.+)$/m.exec(text)?.[1]?.trim();
  return { status, ...(signer ? { signer } : {}), notarized: /Notarization:\s*trusted by the Apple notary service/i.test(text) };
}

/** JavaScript and checks a Distribution file runs when Installer opens it. */
export function parseDistribution(xml: string): NonNullable<PkgReport['distribution']> {
  const title = /<title>([\s\S]*?)<\/title>/.exec(xml)?.[1]?.trim();
  const scripts = [...xml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => decodeEntities(m[1]!.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')).trim())
    .filter(Boolean);
  const checks: string[] = [];
  for (const m of xml.matchAll(/<(installation-check|volume-check)\b([^>]*)>/g)) {
    const a = attrs(m[2]!);
    if (a.script) checks.push(`${m[1]}: ${a.script}`);
  }
  return { ...(title ? { title: decodeEntities(title) } : {}), scripts, checks };
}

function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    createReadStream(file)
      .on('data', (c) => {
        hash.update(c as Buffer);
        bytes += (c as Buffer).length;
      })
      .on('end', () => resolve({ sha256: hash.digest('hex'), bytes }))
      .on('error', reject);
  });
}

interface WalkEntry {
  rel: string;
  isDir: boolean;
  size: number;
}

async function walk(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  const queue = [''];
  while (queue.length) {
    const rel = queue.pop()!;
    let dirents;
    try {
      dirents = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        out.push({ rel: r, isDir: true, size: 0 });
        // Don't descend into app bundles; they are reported as apps.
        if (!d.name.endsWith('.app')) queue.push(r);
      } else if (d.isFile() || d.isSymbolicLink()) {
        let size = 0;
        try {
          size = (await lstat(join(root, r))).size;
        } catch {
          // Unreadable: count it with size 0.
        }
        out.push({ rel: r, isDir: false, size });
      }
    }
  }
  return out;
}

async function readScripts(dir: string, maxBytes: number): Promise<PkgScript[]> {
  const entries = (await walk(dir)).filter((e) => !e.isDir).sort((a, b) => a.rel.localeCompare(b.rel));
  const scripts: PkgScript[] = [];
  for (const e of entries) {
    const buf = await readFile(join(dir, e.rel));
    const binary = buf.subarray(0, 4096).includes(0);
    const text = binary ? undefined : buf.toString('utf8');
    const shebang = text?.startsWith('#!') ? text.slice(2, text.indexOf('\n') >>> 0).trim() : undefined;
    scripts.push({
      name: e.rel,
      hook: e.rel === 'preinstall' || e.rel === 'postinstall',
      ...(shebang ? { interpreter: basename(shebang.split(/\s+/)[0] === '/usr/bin/env' ? (shebang.split(/\s+/)[1] ?? shebang) : shebang.split(/\s+/)[0]!) } : {}),
      binary,
      bytes: buf.length,
      lines: text ? text.split('\n').length : 0,
      ...(text !== undefined && buf.length <= maxBytes ? { content: text } : {}),
    });
  }
  // Hooks first, in the order they run; then helper files.
  const rank = (x: PkgScript): number => (x.name === 'preinstall' ? 0 : x.name === 'postinstall' ? 1 : 2);
  return scripts.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

async function readComponent(dir: string, scriptMaxBytes: number): Promise<PkgComponent> {
  let info: Record<string, string> = {};
  try {
    const xml = await readFile(join(dir, 'PackageInfo'), 'utf8');
    info = attrs(/<pkg-info\b([^>]*)>/.exec(xml)?.[1] ?? '');
  } catch {
    // A component without PackageInfo still has a payload to show.
  }
  const installLocation = info['install-location'] || '/';
  const payloadDir = join(dir, 'Payload');
  const entries = await walk(payloadDir);
  const dest = (rel: string): string => posix.join(installLocation, rel);

  const apps: PkgApp[] = [];
  const launchItems: PkgLaunchItem[] = [];
  const outside = new Set<string>();
  const systemLevel: string[] = [];
  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    const path = dest(e.rel);
    if (!e.isDir) {
      files++;
      bytes += e.size;
    }
    if (e.isDir && e.rel.endsWith('.app') && !/\.app\//.test(e.rel)) {
      const id = await readIdentity(join(payloadDir, e.rel));
      const signing = await readSigning(join(payloadDir, e.rel));
      apps.push({ path, bundleId: id?.bundleId, version: id?.version, teamId: signing.teamId });
    }
    const launchd = /^\/Library\/(LaunchDaemons|LaunchAgents)\/[^/]+\.plist$/.exec(path);
    if (launchd && !e.isDir) {
      const plist = await readPlistFile(join(payloadDir, e.rel));
      const args = plist?.ProgramArguments;
      launchItems.push({
        path,
        kind: launchd[1] === 'LaunchDaemons' ? 'daemon' : 'agent',
        label: str(plist?.Label),
        program: str(plist?.Program) ?? (Array.isArray(args) && typeof args[0] === 'string' ? args[0] : undefined),
        runAtLoad: plist?.RunAtLoad === true,
        keepAlive: plist?.KeepAlive === true || (typeof plist?.KeepAlive === 'object' && plist.KeepAlive !== null),
      });
    }
    if (/\.(kext|systemextension)$/.test(path) || /^\/Library\/PrivilegedHelperTools\/[^/]+$/.test(path)) systemLevel.push(path);
    if (!path.startsWith('/Applications/') && path !== '/Applications' && !e.isDir) {
      // Collapse to the first three levels so a framework doesn't list every file.
      outside.add(path.split('/').slice(0, 4).join('/'));
    }
  }
  return {
    ...(info.identifier ? { id: info.identifier } : {}),
    ...(info.version ? { version: info.version } : {}),
    installLocation,
    ...(info.auth ? { auth: info.auth } : {}),
    scripts: await readScripts(join(dir, 'Scripts'), scriptMaxBytes),
    files,
    bytes,
    apps: apps.sort((a, b) => a.path.localeCompare(b.path)),
    launchItems: launchItems.sort((a, b) => a.path.localeCompare(b.path)),
    outsideApplications: [...outside].sort(),
    systemLevel: [...new Set(systemLevel)].sort(),
  };
}

/**
 * Expands an installer package and reports what it would do: scripts that run
 * during installation, what it installs and where, launch daemons and agents,
 * system-level items, its signature and Gatekeeper's verdict. Nothing is installed
 * and no script is run: `pkgutil --expand-full` only unpacks.
 */
export async function inspectPkg(file: string, options: { scriptMaxBytes?: number } = {}): Promise<PkgReport> {
  const work = await mkdtemp(join(tmpdir(), 'updiff-pkg-'));
  try {
    const out = join(work, 'x');
    const res = await run('/usr/sbin/pkgutil', ['--expand-full', file, out], 15 * 60_000);
    if (res.code !== 0) throw new Error(`pkgutil could not expand ${file}: ${(res.stderr || res.stdout).trim().split('\n').pop()}`);
    const { sha256, bytes } = await sha256File(file);
    const sig = await run('/usr/sbin/pkgutil', ['--check-signature', file]);
    const spctl = await run('/usr/sbin/spctl', ['-a', '-vv', '-t', 'install', file], 120_000);
    const scriptMaxBytes = options.scriptMaxBytes ?? 256 * 1024;

    let distribution: PkgReport['distribution'];
    const components: PkgComponent[] = [];
    const top = await readdir(out, { withFileTypes: true });
    if (top.some((d) => d.name === 'Distribution')) {
      distribution = parseDistribution(await readFile(join(out, 'Distribution'), 'utf8'));
      for (const d of top) if (d.isDirectory() && d.name.endsWith('.pkg')) components.push(await readComponent(join(out, d.name), scriptMaxBytes));
    } else {
      components.push(await readComponent(out, scriptMaxBytes));
    }
    return {
      file,
      sha256,
      bytes,
      signature: parseCheckSignature(sig.stdout + sig.stderr),
      gatekeeper: parseSpctl(spctl.stdout + spctl.stderr),
      ...(distribution ? { distribution } : {}),
      components,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

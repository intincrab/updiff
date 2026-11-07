import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionsSnapshot } from './extensions.ts';
import type { Snapshot } from './types.ts';

export interface StoredSnapshot {
  file: string;
  bundleId: string;
  takenAt: string;
  version: string;
  build: string;
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || '_';
}

export function defaultHome(): string {
  return process.env.UPDIFF_HOME || join(homedir(), '.updiff');
}

export class Store {
  readonly home: string;

  constructor(home: string = defaultHome()) {
    this.home = home;
  }

  get snapshotsDir(): string {
    return join(this.home, 'snapshots');
  }

  get reportsDir(): string {
    return join(this.home, 'reports');
  }

  async save(s: Snapshot): Promise<string> {
    const dir = join(this.snapshotsDir, safe(s.app.bundleId));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${s.takenAt.replace(/[:.]/g, '-')}__${safe(s.app.version)}__${safe(s.app.build)}.json`);
    await writeFile(file, JSON.stringify(s));
    return file;
  }

  async load(file: string): Promise<Snapshot> {
    const s = JSON.parse(await readFile(file, 'utf8')) as Snapshot;
    if (!s.app?.bundleId || !s.fingerprint) throw new Error(`${file} is not an updiff snapshot`);
    return s;
  }

  async bundleIds(): Promise<string[]> {
    try {
      const dirents = await readdir(this.snapshotsDir, { withFileTypes: true });
      return dirents.filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      return [];
    }
  }

  /** Snapshots of one app, oldest first. */
  async list(bundleId: string): Promise<StoredSnapshot[]> {
    const dir = join(this.snapshotsDir, safe(bundleId));
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return [];
    }
    return names.map((n) => {
      const [stamp = '', version = '', build = ''] = n.slice(0, -5).split('__');
      return { file: join(dir, n), bundleId, takenAt: stamp, version, build };
    });
  }

  /** The newest `count` snapshots of one app, newest first. */
  async latest(bundleId: string, count = 1): Promise<Snapshot[]> {
    const list = await this.list(bundleId);
    const picked = list.slice(-count).reverse();
    return Promise.all(picked.map((p) => this.load(p.file)));
  }

  /** Finds a stored app by bundle id or by name, ignoring case. */
  async resolveBundleId(query: string): Promise<string | undefined> {
    const ids = await this.bundleIds();
    const q = query.toLowerCase();
    const exact = ids.find((id) => id.toLowerCase() === q || id.toLowerCase() === safe(query).toLowerCase());
    if (exact) return exact;
    for (const id of ids) {
      const [latest] = await this.latest(id, 1);
      if (latest && latest.app.name.toLowerCase() === q.replace(/\.app$/, '')) return id;
    }
    return undefined;
  }

  async prune(bundleId: string, keep: number): Promise<number> {
    const list = await this.list(bundleId);
    const drop = list.slice(0, Math.max(0, list.length - keep));
    await Promise.all(drop.map((d) => rm(d.file, { force: true })));
    return drop.length;
  }

  get extensionsDir(): string {
    return join(this.home, 'extensions');
  }

  async saveExtensions(snapshot: ExtensionsSnapshot): Promise<string> {
    await mkdir(this.extensionsDir, { recursive: true });
    const file = join(this.extensionsDir, `${snapshot.takenAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(snapshot));
    const all = (await readdir(this.extensionsDir)).filter((n) => n.endsWith('.json')).sort();
    await Promise.all(all.slice(0, Math.max(0, all.length - 10)).map((n) => rm(join(this.extensionsDir, n), { force: true })));
    return file;
  }

  async latestExtensions(): Promise<ExtensionsSnapshot | undefined> {
    try {
      const all = (await readdir(this.extensionsDir)).filter((n) => n.endsWith('.json')).sort();
      const last = all.at(-1);
      return last ? (JSON.parse(await readFile(join(this.extensionsDir, last), 'utf8')) as ExtensionsSnapshot) : undefined;
    } catch {
      return undefined;
    }
  }

  async saveReport(bundleId: string, fromVersion: string, toVersion: string, ext: string, content: string): Promise<string> {
    const dir = join(this.reportsDir, safe(bundleId));
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `${stamp}__${safe(fromVersion)}__to__${safe(toVersion)}.${ext}`);
    await writeFile(file, content);
    return file;
  }
}

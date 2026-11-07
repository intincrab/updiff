import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { run } from '../../src/exec.ts';

export const USER_AGENT = 'updiff-ledger/0.1 (+https://github.com/intincrab/updiff)';

export interface Downloaded {
  file: string;
  bytes: number;
  sha256: string;
}

/**
 * Downloads `url` to `dest`, hashing as it goes. Fails above `maxBytes` and, when
 * `expectedSha256` is given, on a checksum mismatch.
 */
export async function download(url: string, dest: string, options: { maxBytes: number; expectedSha256?: string | null }): Promise<Downloaded> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > options.maxBytes) throw new Error(`Download is ${declared} bytes, over the ${options.maxBytes}-byte limit`);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        cb(new Error(`Download exceeded the ${options.maxBytes}-byte limit`));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(dest));
  const sha256 = hash.digest('hex');
  if (options.expectedSha256 && options.expectedSha256 !== sha256) {
    throw new Error(`Checksum mismatch: expected ${options.expectedSha256}, got ${sha256}`);
  }
  return { file: dest, bytes, sha256 };
}

export type ContainerKind = 'zip' | 'pkg' | 'tar' | 'dmg';

/** Identifies a downloaded installer from its first bytes. Disk images have no fixed header. */
export function detectContainer(head: Buffer): ContainerKind {
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'xar!') return 'pkg';
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tar';
  if (head.length >= 3 && head.toString('latin1', 0, 3) === 'BZh') return 'tar';
  if (head.length >= 6 && head[0] === 0xfd && head.toString('latin1', 1, 5) === '7zXZ') return 'tar';
  if (head.length >= 262 && head.toString('latin1', 257, 262) === 'ustar') return 'tar';
  return 'dmg';
}

async function readHead(file: string): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Finds app bundles under `root` without descending into them. */
export async function findApps(root: string, maxDepth = 8): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      const p = join(dir, d.name);
      if (d.name.endsWith('.app')) found.push(p);
      else if (depth < maxDepth) await walk(p, depth + 1);
    }
  };
  await walk(root, 0);
  return found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

export interface ExtractedApp {
  appPath: string;
  kind: ContainerKind;
  cleanup(): Promise<void>;
}

/**
 * Unpacks an installer into `workDir` and returns the app bundle it holds. Nothing in
 * the installer is run: disk images are mounted read-only, packages are expanded with
 * `pkgutil --expand-full` (scripts are written out, not executed).
 */
export async function extractApp(file: string, workDir: string, appNames: string[]): Promise<ExtractedApp> {
  const kind = detectContainer(await readHead(file));
  const out = join(workDir, 'contents');
  await mkdir(workDir, { recursive: true });
  let mountPoint: string | undefined;
  const cleanup = async (): Promise<void> => {
    if (mountPoint) {
      const res = await run('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet']);
      if (res.code !== 0) await run('/usr/bin/hdiutil', ['detach', mountPoint, '-force', '-quiet']);
    }
    await rm(workDir, { recursive: true, force: true });
  };
  try {
    let res;
    if (kind === 'zip') {
      await mkdir(out);
      res = await run('/usr/bin/ditto', ['-x', '-k', file, out], 15 * 60_000);
    } else if (kind === 'pkg') {
      res = await run('/usr/sbin/pkgutil', ['--expand-full', file, out], 15 * 60_000);
    } else if (kind === 'tar') {
      await mkdir(out);
      res = await run('/usr/bin/tar', ['-xf', file, '-C', out], 15 * 60_000);
    } else {
      mountPoint = join(workDir, 'mnt');
      await mkdir(mountPoint);
      // "Y" accepts a licence agreement if the image shows one.
      res = await run('/usr/bin/hdiutil', ['attach', file, '-readonly', '-nobrowse', '-noautoopen', '-noverify', '-mountpoint', mountPoint], 10 * 60_000, 'Y\n');
      if (res.code !== 0) mountPoint = undefined;
    }
    if (res.code !== 0) throw new Error(`Could not unpack the ${kind}: ${(res.stderr || res.stdout).trim().split('\n').pop()}`);

    const apps = await findApps(mountPoint ?? out);
    const wanted = appNames.map((n) => n.toLowerCase());
    const appPath = apps.find((p) => wanted.includes(p.slice(p.lastIndexOf('/') + 1).toLowerCase())) ?? apps[0];
    if (!appPath) throw new Error(`No .app bundle found in the ${kind}`);
    return { appPath, kind, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

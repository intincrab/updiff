import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPackageWithOptions, extractFile } from '@electron/asar';
import { AsarArchive } from '../src/asar.ts';

function makeSource(): string {
  const src = mkdtempSync(join(tmpdir(), 'updiff-asar-src-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'demo', version: '1.2.3' }),
    'dist/main.js': 'fetch("https://api.demo.dev/v1")',
    'dist/deep/nested/file.txt': 'x'.repeat(10_000),
    'node_modules/@scope/pkg/package.json': JSON.stringify({ name: '@scope/pkg', version: '0.0.1' }),
    'native/addon.node': 'NOT-REALLY-NATIVE https://native.demo.dev',
    'empty.txt': '',
  };
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(src, p, '..'), { recursive: true });
    writeFileSync(join(src, p), content);
  }
  return src;
}

test('reads archives written by @electron/asar, including unpacked files', async () => {
  const src = makeSource();
  const out = join(mkdtempSync(join(tmpdir(), 'updiff-asar-')), 'app.asar');
  await createPackageWithOptions(src, out, { unpack: '*.node' });

  const archive = AsarArchive.open(out);
  try {
    const files = [...archive.files()];
    const paths = files.map((f) => f.path).sort();
    assert.deepEqual(paths, [
      'dist/deep/nested/file.txt',
      'dist/main.js',
      'empty.txt',
      'native/addon.node',
      'node_modules/@scope/pkg/package.json',
      'package.json',
    ]);
    for (const f of files) {
      const expected = extractFile(out, f.path);
      assert.equal(archive.read(f).toString('utf8'), expected.toString('utf8'), f.path);
    }
    const addon = files.find((f) => f.path === 'native/addon.node')!;
    assert.equal(addon.unpacked, true);
    const big = files.find((f) => f.path === 'dist/deep/nested/file.txt')!;
    assert.equal(archive.read(big, 100).length, 100);
  } finally {
    archive.close();
  }
});

test('rejects files that are not asar archives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'updiff-asar-bad-'));
  const bad = join(dir, 'bad.asar');
  writeFileSync(bad, 'hello');
  assert.throws(() => AsarArchive.open(bad));
  const garbage = join(dir, 'garbage.asar');
  writeFileSync(garbage, Buffer.from([4, 0, 0, 0, 255, 255, 255, 255, 1, 2, 3]));
  assert.throws(() => AsarArchive.open(garbage));
});

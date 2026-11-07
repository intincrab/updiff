import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseSpctl, parseStapler } from '../src/codesign.ts';
import { diffSnapshots } from '../src/diff.ts';
import { extractFeedUrls } from '../src/hosts.ts';
import { isEncryptedMachO } from '../src/macho.ts';
import { SNAPSHOT_SCHEMA, type Snapshot } from '../src/types.ts';
import { hasCompiler } from './fixtures.ts';

/** A thin 64-bit Mach-O header followed by a segment command and an encryption command. */
function machO(cryptid: number | null): Buffer {
  const cmds: Buffer[] = [];
  const seg = Buffer.alloc(72);
  seg.writeUInt32LE(0x19, 0); // LC_SEGMENT_64
  seg.writeUInt32LE(72, 4);
  cmds.push(seg);
  if (cryptid !== null) {
    const enc = Buffer.alloc(24);
    enc.writeUInt32LE(0x2c, 0); // LC_ENCRYPTION_INFO_64
    enc.writeUInt32LE(24, 4);
    enc.writeUInt32LE(0x4000, 8);
    enc.writeUInt32LE(0x8000, 12);
    enc.writeUInt32LE(cryptid, 16);
    cmds.push(enc);
  }
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(cmds.length, 16);
  header.writeUInt32LE(cmds.reduce((n, c) => n + c.length, 0), 20);
  return Buffer.concat([header, ...cmds]);
}

test('detects FairPlay-encrypted Mach-O images from their load commands', () => {
  assert.equal(isEncryptedMachO(machO(1)), true);
  assert.equal(isEncryptedMachO(machO(0)), false);
  assert.equal(isEncryptedMachO(machO(null)), false);
  assert.equal(isEncryptedMachO(Buffer.from('#!/bin/sh\necho hi\n'.padEnd(64))), undefined);
});

test('a freshly compiled binary is not encrypted', (t) => {
  if (!hasCompiler()) {
    t.skip('no C compiler');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'updiff-macho-'));
  writeFileSync(join(dir, 'a.c'), 'int main(void){return 0;}');
  execFileSync('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-o', join(dir, 'a'), join(dir, 'a.c')]);
  assert.equal(isEncryptedMachO(readFileSync(join(dir, 'a')).subarray(0, 65536)), false);
});

test('parses spctl verdicts', () => {
  assert.deepEqual(
    parseSpctl('/Applications/Ghostty.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Mitchell Hashimoto (24VZTF6M5V)\n'),
    { assessment: 'accepted', source: 'Notarized Developer ID', origin: 'Developer ID Application: Mitchell Hashimoto (24VZTF6M5V)' },
  );
  assert.deepEqual(parseSpctl('/tmp/x: rejected\n'), { assessment: 'rejected' });
  assert.deepEqual(parseSpctl('/tmp/x: rejected\nsource=no usable signature\n'), { assessment: 'rejected', source: 'no usable signature' });
  assert.deepEqual(parseSpctl('spctl: some failure'), { assessment: 'unknown' });
});

test('reads stapler by its message, not its exit status', () => {
  assert.equal(parseStapler({ stdout: 'Processing: /A.app\nThe validate action worked!\n', stderr: '' }), true);
  assert.equal(parseStapler({ stdout: 'A.app does not have a ticket stapled to it.\n', stderr: '' }), false);
  assert.equal(parseStapler({ stdout: '', stderr: 'xcrun: error: unable to find utility "stapler"' }), undefined);
});

test('finds Sparkle feeds in code, stopping at NUL separators', () => {
  const binary = 'x\0https://release.files.example-app.org/appcast.xml\0\0\0https://tip.files.example-app.org/appcast.xml\0SPUUpdaterDelegate';
  assert.deepEqual([...extractFeedUrls(binary, false)].sort(), [
    'https://release.files.example-app.org/appcast.xml',
    'https://tip.files.example-app.org/appcast.xml',
  ]);
  const xml = '"https://downloads.vendor.io/mac/updates/stable.xml" "https://www.vendor.io/sitemap.xml"';
  assert.deepEqual([...extractFeedUrls(xml, true)], ['https://downloads.vendor.io/mac/updates/stable.xml']);
  assert.deepEqual([...extractFeedUrls(xml, false)], [], 'update .xml URLs only count when Sparkle is bundled');
});

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    tool: { name: 'updiff', version: 'test' },
    takenAt: '2026-11-01T00:00:00.000Z',
    fingerprint: 'a',
    app: { path: '/Applications/Foo.app', name: 'Foo', bundleId: 'com.example.foo', version: '1', build: '1', sizeBytes: 1, fileCount: 1 },
    info: { urlSchemes: [], privacyUsage: {}, atsArbitraryLoads: false, atsExceptionDomains: [], backgroundOnly: false, privilegedExecutables: [] },
    signing: { status: 'signed', teamId: 'T', authorities: [], hardenedRuntime: true, flags: [] },
    code: [],
    backgroundItems: [],
    hosts: {},
    stats: { scanMs: 0, filesScanned: 0, bytesScanned: 0, deep: false, warnings: [] },
    ...over,
  };
}

const NOTARIZED = { assessment: 'accepted' as const, source: 'Notarized Developer ID', stapled: true };

test('flags an update that is no longer notarized', () => {
  const r = diffSnapshots(snap({ notarization: NOTARIZED }), snap({ fingerprint: 'b', notarization: { assessment: 'accepted', source: 'Developer ID', stapled: false } }));
  const titles = r.findings.map((f) => `${f.severity}: ${f.title}`);
  assert.ok(titles.includes('high: No longer notarized by Apple'));
  assert.ok(titles.includes('info: Notarization ticket no longer stapled'));
});

test('flags an update that Gatekeeper rejects', () => {
  const r = diffSnapshots(snap({ notarization: NOTARIZED }), snap({ fingerprint: 'b', notarization: { assessment: 'rejected', stapled: true } }));
  assert.deepEqual(r.findings.filter((f) => f.severity === 'high').map((f) => f.title), ['Gatekeeper now rejects the app']);
});

test('notes distribution changes and skips sides without a verdict', () => {
  const r = diffSnapshots(snap({ notarization: NOTARIZED }), snap({ fingerprint: 'b', notarization: { assessment: 'accepted', source: 'Mac App Store', stapled: true } }));
  assert.ok(r.findings.some((f) => f.severity === 'notable' && f.title === 'Distribution changed'));
  const one = diffSnapshots(snap(), snap({ fingerprint: 'b', notarization: NOTARIZED }));
  assert.ok(!one.findings.some((f) => f.category === 'signing'));
  assert.deepEqual(one.notes, ['Notarization was only checked on one side, so it was not compared.']);
});

test('reports update feeds in code, App Store moves and encrypted binaries', () => {
  const a = snap({ info: { ...snap().info, sparkleFeedsInCode: ['https://a.example-app.org/appcast.xml'] } });
  const b = snap({
    fingerprint: 'b',
    info: { ...snap().info, sparkleFeedsInCode: ['https://b.example-cdn.net/appcast.xml'], appStoreReceipt: true },
    encryptedBinaries: ['Contents/MacOS/Foo'],
  });
  const r = diffSnapshots(a, b);
  const feed = r.findings.find((f) => f.title === 'Update feed in the code changed')!;
  assert.equal(feed.severity, 'notable');
  assert.equal(feed.detail, 'https://a.example-app.org/appcast.xml → https://b.example-cdn.net/appcast.xml');
  assert.ok(r.findings.some((f) => f.title === 'Now distributed through the Mac App Store'));
  assert.match(r.notes?.[0] ?? '', /Encrypted binaries .* Contents\/MacOS\/Foo/);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeEntities, parsePlistXml, readPlistFile, toPlistXml, type PlistValue } from '../src/plist.ts';

test('parses every plist type', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- a comment -->
  <key>s</key><string>a &lt;b&gt; &amp; &quot;c&quot; &#x41;&#66;</string>
  <key>i</key><integer>-42</integer>
  <key>r</key><real>1.5</real>
  <key>t</key><true/>
  <key>f</key><false/>
  <key>d</key><date>2026-11-07T12:00:00Z</date>
  <key>data</key><data>
    aGVs
    bG8=
  </data>
  <key>empty</key><string/>
  <key>arr</key><array><string>x</string><dict><key>n</key><integer>1</integer></dict><array/></array>
  <key>emptyDict</key><dict/>
</dict>
</plist>`;
  assert.deepEqual(parsePlistXml(xml), {
    s: 'a <b> & "c" AB',
    i: -42,
    r: 1.5,
    t: true,
    f: false,
    d: '2026-11-07T12:00:00Z',
    data: 'data:aGVsbG8=',
    empty: '',
    arr: ['x', { n: 1 }, []],
    emptyDict: {},
  });
});

test('an empty plist document is undefined', () => {
  assert.equal(parsePlistXml('<?xml version="1.0"?><plist version="1.0"></plist>'), undefined);
  assert.equal(parsePlistXml(''), undefined);
});

test('rejects malformed plists', () => {
  assert.throws(() => parsePlistXml('<plist><dict><key>a</key></dict></plist>'));
  assert.throws(() => parsePlistXml('<plist><dict><string>no key</string></dict></plist>'));
  assert.throws(() => parsePlistXml('<plist><array><string>open</array></plist>'));
});

test('round-trips through the serializer', () => {
  const value: PlistValue = { a: 'x & <y>', b: [1, 2.25, true, false], c: { nested: [] , d: {} } };
  assert.deepEqual(parsePlistXml(toPlistXml(value)), value);
});

test('decodes numeric entities beyond the BMP', () => {
  assert.equal(decodeEntities('&#x1F600;'), '😀');
});

test('reads binary plists through plutil', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'updiff-plist-'));
  const file = join(dir, 'Info.plist');
  writeFileSync(file, toPlistXml({ CFBundleIdentifier: 'com.example.x', list: ['a', 'b'], n: 7 }));
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', file]);
  assert.deepEqual(await readPlistFile(file), { CFBundleIdentifier: 'com.example.x', list: ['a', 'b'], n: 7 });
  assert.equal(await readPlistFile(join(dir, 'missing.plist')), undefined);
});

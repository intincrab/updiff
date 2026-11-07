import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractHosts, isIgnoredHost, mergeHosts, registrableDomain } from '../src/hosts.ts';
import { isScannableText, normalizeKey, pickFatSlice } from '../src/bundle.ts';

function hosts(text: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [h, r] of extractHosts(text, 'f')) out[h] = r.viaUrl;
  return out;
}

test('finds hosts after URL schemes', () => {
  assert.deepEqual(
    hosts(`
      fetch("https://API.Vendor.io/v1?x=1");
      const ws = 'wss://live.vendor.io:8443/socket';
      const u = "http://user:pw@legacy.example-corp.com/path";
      const f = "ftp://files.mirror.org.";
    `),
    { 'api.vendor.io': true, 'live.vendor.io': true, 'legacy.example-corp.com': true, 'files.mirror.org': true },
  );
});

test('finds quoted hostnames only with common top-level domains', () => {
  assert.deepEqual(
    hosts(`
      const a = "events.tracker.ai";
      const b = 'sentry.io';
      const c = "Claude.app";          // app bundle, not a host
      const d = "README.md";           // file
      const e = "build.sh";            // script
      const f = "e.g";                 // abbreviation
      const g = "window.location";     // property path
      const h = \`cdn.vendor.co.uk\`;
    `),
    { 'events.tracker.ai': false, 'sentry.io': false, 'cdn.vendor.co.uk': false },
  );
});

test('skips namespaces, placeholders and reserved names', () => {
  assert.deepEqual(
    hosts(`
      xmlns="http://www.w3.org/2000/svg"
      "https://example.com/docs" "http://localhost:3000" "https://printer.local"
      "https://api.service.test" "https://real.service.com"
    `),
    { 'real.service.com': true },
  );
  assert.equal(isIgnoredHost('foo.internal'), true);
  assert.equal(isIgnoredHost('foo.com'), false);
});

test('ignores numeric "hosts" such as IP addresses and versions', () => {
  assert.deepEqual(hosts('http://127.0.0.1:8080 https://10.0.0.1 "1.2.3"'), {});
});

test('records counts and up to three locations', () => {
  const map = extractHosts('"https://a.vendor.io" "https://a.vendor.io"', 'one');
  extractHosts('https://a.vendor.io', 'two', map);
  extractHosts('https://a.vendor.io', 'three', map);
  extractHosts('https://a.vendor.io', 'four', map);
  const rec = map.get('a.vendor.io')!;
  assert.equal(rec.count, 5);
  assert.deepEqual(rec.where, ['one', 'two', 'three']);

  const other = extractHosts('"b.vendor.io"', 'x');
  mergeHosts(map, other);
  assert.equal(map.get('b.vendor.io')!.viaUrl, false);
});

test('groups hosts by registrable domain', () => {
  assert.equal(registrableDomain('api.eu.vendor.com'), 'vendor.com');
  assert.equal(registrableDomain('vendor.com'), 'vendor.com');
  assert.equal(registrableDomain('www.shop.co.uk'), 'shop.co.uk');
  assert.equal(registrableDomain('user.github.io'), 'user.github.io');
  assert.equal(registrableDomain('bucket.s3.amazonaws.com'), 'bucket.s3.amazonaws.com');
  assert.equal(registrableDomain('x.y.amazonaws.com'), 'amazonaws.com');
});

test('decides which files are worth reading as text', () => {
  assert.equal(isScannableText('dist/main.js'), true);
  assert.equal(isScannableText('dist/main.js.map'), false);
  assert.equal(isScannableText('node_modules/x/README.md'), false);
  assert.equal(isScannableText('node_modules/x/LICENSE.txt'), false);
  assert.equal(isScannableText('node_modules/x/package.json'), false);
  assert.equal(isScannableText('package.json'), true);
  assert.equal(isScannableText('types/index.d.ts'), false);
  assert.equal(isScannableText('assets/logo.png'), false);
});

test('normalises framework version folders', () => {
  assert.equal(
    normalizeKey('Contents/Frameworks/X.framework/Versions/154.0.1/Helpers/H.app'),
    'Contents/Frameworks/X.framework/Versions/*/Helpers/H.app',
  );
  assert.equal(normalizeKey('Contents/MacOS/X'), 'Contents/MacOS/X');
});

test('picks the arm64 slice of a universal binary', () => {
  const head = Buffer.alloc(8 + 2 * 20);
  head.writeUInt32BE(0xcafebabe, 0);
  head.writeUInt32BE(2, 4);
  // x86_64 slice
  head.writeUInt32BE(0x01000007, 8);
  head.writeUInt32BE(4096, 16);
  head.writeUInt32BE(1000, 20);
  // arm64 slice
  head.writeUInt32BE(0x0100000c, 28);
  head.writeUInt32BE(8192, 36);
  head.writeUInt32BE(2000, 40);
  assert.deepEqual(pickFatSlice(head, 20_000), { offset: 8192, size: 2000 });
  // A slice past the end of the file is ignored.
  assert.deepEqual(pickFatSlice(head, 9000), { offset: 4096, size: 1000 });
  // Thin binary.
  const thin = Buffer.alloc(8);
  thin.writeUInt32BE(0xcffaedfe, 0);
  assert.equal(pickFatSlice(thin, 100), undefined);
  // Java class files share the magic number but have a large version field.
  const java = Buffer.alloc(8);
  java.writeUInt32BE(0xcafebabe, 0);
  java.writeUInt32BE(0x00000034, 4);
  assert.equal(pickFatSlice(java, 100), undefined);
});

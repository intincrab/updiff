import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildSite } from '../ledger/src/site.ts';
import { LedgerStore } from '../ledger/src/store.ts';
import { backfill, updateApp } from '../ledger/src/update.ts';
import { buildApp, V1, V2 } from './fixtures.ts';

const root = mkdtempSync(join(tmpdir(), 'updiff-ledger-'));
const files = join(root, 'files');
let server: Server;
let base = '';
/** The cask document the fake Homebrew API serves. */
let cask: Record<string, unknown> = {};

function sha(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function caskFor(version: string, file: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'fixture',
    name: ['Fixture'],
    desc: 'A test app',
    homepage: 'https://fixture.example.org/',
    version,
    url: `${base}/files/${file}`,
    sha256: sha(join(files, file)),
    artifacts: [{ app: [['Fixture.app']] }],
    ...extra,
  };
}

before(async () => {
  mkdirSync(files, { recursive: true });
  const v1 = await buildApp(join(root, 'v1'), V1);
  // The update also carries markup in a privacy prompt, to prove the site escapes it.
  const v2 = await buildApp(join(root, 'v2'), {
    ...V2,
    info: { ...V2.info, NSCameraUsageDescription: 'Fixture can now see you <script>alert("x")</script>' },
  });
  const v3 = await buildApp(join(root, 'v3'), { ...V1, version: '3.0.0', build: '300' });

  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', v1, join(files, 'Fixture-1.0.0.zip')]);
  // v2 is a bzip2 image (UDBZ, like Slack's and Chrome's): its first bytes read "BZh".
  for (const [dir, name, format] of [
    [join(root, 'v1'), 'Fixture-1.0.0.dmg', 'UDZO'],
    [join(root, 'v2'), 'Fixture-2.0.0.dmg', 'UDBZ'],
  ] as const) {
    execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-ov', '-volname', 'Fixture', '-srcfolder', dir, '-format', format, join(files, name)]);
  }
  execFileSync('/usr/bin/pkgbuild', ['--quiet', '--component', v3, '--install-location', '/Applications', join(files, 'Fixture-3.0.0.pkg')]);

  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/api/fixture.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(cask));
      return;
    }
    // Like Warp's Homebrew URL: only Homebrew clients get the file.
    const brewOnly = url.startsWith('/brew-only/');
    if (brewOnly && !String(req.headers['user-agent'] ?? '').startsWith('Homebrew/')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const m = /^\/(?:files|brew-only)\/([\w.-]+)$/.exec(url);
    if (m && existsSync(join(files, m[1]!))) {
      res.end(readFileSync(join(files, m[1]!)));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LEDGER_CASK_API = `${base}/api`;
});

after(() => {
  server?.close();
  delete process.env.LEDGER_CASK_API;
  rmSync(root, { recursive: true, force: true });
});

describe('following an app through releases', () => {
  const store = new LedgerStore(join(root, 'data-a'));
  const app = { cask: 'fixture' };
  const opts = { store, workRoot: root };

  test('the first release becomes the baseline (from a zip)', async () => {
    cask = caskFor('1.0.0', 'Fixture-1.0.0.zip');
    const o = await updateApp(app, opts);
    assert.equal(o.status, 'baseline', o.error);
    const state = await store.loadState('fixture');
    assert.equal(state?.latest?.version, '1.0.0');
    assert.equal(state?.latest?.appVersion, '1.0.0');
    assert.equal(state?.latest?.sha256, cask.sha256);
    assert.equal(state?.bundleId, 'com.example.updiff-fixture');
    const snap = await store.loadSnapshot('fixture');
    assert.equal(snap?.app.path, 'Fixture 1.0.0 (Homebrew cask fixture)');
  });

  test('an unchanged cask is skipped without downloading', async () => {
    const o = await updateApp(app, opts);
    assert.equal(o.status, 'unchanged');
  });

  test('a new release (from a bzip2 disk image) produces a report', async () => {
    assert.equal(readFileSync(join(files, 'Fixture-2.0.0.dmg')).subarray(0, 3).toString('latin1'), 'BZh');
    cask = caskFor('2.0.0', 'Fixture-2.0.0.dmg');
    const o = await updateApp(app, opts);
    assert.equal(o.status, 'updated', o.error);
    assert.equal(o.from, '1.0.0');
    assert.equal(o.counts?.high, 6);
    const report = await store.loadReport('fixture', o.report!);
    assert.equal(report.from.version, '1.0.0');
    assert.equal(report.to.version, '2.0.0');
    assert.ok(report.report.findings.some((f) => f.title === 'New login item: FixtureLauncher.app'));
    // The disk image was detached again.
    const mounts = execFileSync('/sbin/mount').toString();
    assert.ok(!mounts.includes(root), 'no fixture image left mounted');
  });

  test('installer packages are expanded, not installed', async () => {
    cask = caskFor('3.0.0', 'Fixture-3.0.0.pkg', { artifacts: [{ pkg: [['Fixture-3.0.0.pkg']] }] });
    const o = await updateApp(app, opts);
    assert.equal(o.status, 'updated', o.error);
    assert.equal(o.from, '2.0.0');
    assert.ok(!existsSync('/Applications/Fixture.app'), 'the package must not be installed');
    const report = await store.loadReport('fixture', o.report!);
    assert.ok(report.report.findings.some((f) => f.title === 'Removed login item: FixtureLauncher.app'));
  });

  test('a checksum mismatch fails and is recorded', async () => {
    cask = { ...caskFor('4.0.0', 'Fixture-2.0.0.dmg'), sha256: 'f'.repeat(64) };
    const o = await updateApp(app, opts);
    assert.equal(o.status, 'failed');
    assert.match(o.error!, /Checksum mismatch/);
    const state = await store.loadState('fixture');
    assert.equal(state?.latest?.version, '3.0.0', 'the last good release is kept');
    assert.match(state?.lastError?.message ?? '', /Checksum mismatch/);
  });

  test('builds a site with escaped content and a feed', async () => {
    const out = join(root, 'site');
    const res = await buildSite(store, [app], { out, baseUrl: 'https://ledger.example.org/', repoUrl: 'https://github.com/intincrab/updiff' });
    assert.equal(res.reports, 2);
    for (const page of ['index.html', 'apps.html', 'about.html', 'feed.xml', 'style.css', '.nojekyll', 'apps/fixture.html']) {
      assert.ok(existsSync(join(out, page)), page);
    }
    const reportPages = readdirSync(join(out, 'updates', 'fixture'));
    assert.equal(reportPages.length, 2);
    const v2Page = readFileSync(join(out, 'updates', 'fixture', reportPages.find((p) => p.includes('__to__2.0.0'))!), 'utf8');
    assert.match(v2Page, /Fixture <span class="ver">1\.0\.0 → 2\.0\.0<\/span>/);
    assert.match(v2Page, /6 high/);
    assert.ok(!v2Page.includes('<script>alert'), 'markup from the bundle must be escaped');
    assert.ok(v2Page.includes('&lt;script&gt;alert'), 'and still be shown');
    assert.match(v2Page, /updiff diff Old\.app New\.app/);

    const index = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(index, /Flagged high/);
    assert.match(index, /<strong>1<\/strong> apps · <strong>3<\/strong> releases scanned · <strong>2<\/strong> updates compared/);
    const appsPage = readFileSync(join(out, 'apps.html'), 'utf8');
    assert.match(appsPage, /last check failed/);

    const feed = readFileSync(join(out, 'feed.xml'), 'utf8');
    assert.equal((feed.match(/<entry>/g) ?? []).length, 2);
    assert.match(feed, /<link href="https:\/\/ledger\.example\.org\/updates\/fixture\/[^"]+__to__3\.0\.0\.html"\/>/);
    assert.ok(!feed.includes('<script>'));
  });
});

test('retries a refused download with a Homebrew-compatible User-Agent', async () => {
  const store = new LedgerStore(join(root, 'data-c'));
  cask = { ...caskFor('1.0.0', 'Fixture-1.0.0.zip'), url: `${base}/brew-only/Fixture-1.0.0.zip` };
  const o = await updateApp({ cask: 'fixture' }, { store, workRoot: root });
  assert.equal(o.status, 'baseline', o.error);
});

describe('backfilling an older release', () => {
  test('derives the old download URL and reports against it on the next update', async () => {
    const store = new LedgerStore(join(root, 'data-b'));
    const app = { cask: 'fixture' };
    cask = caskFor('2.0.0', 'Fixture-2.0.0.dmg');
    const b = await backfill(app, '1.0.0', { store, workRoot: root });
    assert.equal(b.status, 'baseline');
    const state = await store.loadState('fixture');
    assert.equal(state?.latest?.url, `${base}/files/Fixture-1.0.0.dmg`);
    await assert.rejects(backfill(app, '1.0.0', { store, workRoot: root }), /already has a baseline/);

    const o = await updateApp(app, { store, workRoot: root });
    assert.equal(o.status, 'updated', o.error);
    assert.equal(o.counts?.high, 6);
  });
});

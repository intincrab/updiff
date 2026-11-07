import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { main } from '../src/commands.ts';
import { compareVersions, diffExtensions, discoverExtensions, isBroadPattern, type ExtensionsSnapshot } from '../src/extensions.ts';

const root = mkdtempSync(join(tmpdir(), 'updiff-ext-'));
const home = join(root, 'home');
const store = join(root, 'store');
const support = join(home, 'Library', 'Application Support');
const CHROME_ID = 'a'.repeat(32);
const BRAVE_ID = 'b'.repeat(32);

function write(path: string, content: string | object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function chromeExtension(version: string, manifest: object): void {
  const dir = join(support, 'Google/Chrome/Default/Extensions', CHROME_ID, `${version}_0`);
  write(join(dir, 'manifest.json'), { manifest_version: 3, name: '__MSG_extName__', default_locale: 'en', version, ...manifest });
  write(join(dir, '_locales/en/messages.json'), { extName: { message: 'Page Helper' } });
}

function firefox(addons: object[]): void {
  write(join(support, 'Firefox/Profiles/abcd1234.default-release/extensions.json'), { schemaVersion: 36, addons });
}

const notes = { id: 'notes@example.org', type: 'extension', location: 'app-profile', signedState: 2, version: '3.0', active: true, defaultLocale: { name: 'Notes' }, userPermissions: { permissions: ['storage'], origins: ['https://notes.example-app.com/*'] }, optionalPermissions: { permissions: [], origins: [] } };
const mozillaNewTab = { id: 'newtab@mozilla.org', type: 'extension', location: 'app-profile', signedState: 3, version: '161.0', defaultLocale: { name: 'New Tab' }, userPermissions: { permissions: [], origins: [] } };
const systemAddon = { id: 'formautofill@mozilla.org', type: 'extension', location: 'app-system-defaults', version: '1.0', defaultLocale: { name: 'Form Autofill' } };

function vscodeExtension(version: string, pkg: object, files: Record<string, string> = {}): string {
  const dir = join(home, '.vscode/extensions', `acme.linter-${version}`);
  write(join(dir, 'package.json'), { name: 'linter', publisher: 'acme', displayName: '%displayName%', version, engines: { vscode: '^1.90.0' }, ...pkg });
  write(join(dir, 'package.nls.json'), { displayName: 'Acme Linter' });
  for (const [rel, content] of Object.entries(files)) write(join(dir, rel), content);
  return dir;
}

let before1: ExtensionsSnapshot;
let after1: ExtensionsSnapshot;

before(async () => {
  process.env.UPDIFF_EXTENSIONS_ROOT = home;
  // An older version left next to the current one must be ignored.
  chromeExtension('0.9.0', { permissions: ['storage'] });
  chromeExtension('1.0.0', { permissions: ['storage'], host_permissions: ['https://docs.example-app.com/*'], update_url: 'https://clients2.google.com/service/update2/crx' });
  write(join(support, 'BraveSoftware/Brave-Browser/Profile 1/Extensions', BRAVE_ID, '2.0_0/manifest.json'), {
    manifest_version: 2,
    name: 'Tab Saver',
    version: '2.0',
    permissions: ['tabs', 'https://*/*'],
    content_scripts: [{ matches: ['https://news.example-site.com/*'], js: ['c.js'] }],
  });
  firefox([notes, mozillaNewTab, systemAddon]);
  vscodeExtension('1.0.0', { activationEvents: ['onLanguage:python'], main: './out/extension.js', dependencies: { minimatch: '^9.0.0' } }, { 'out/extension.js': 'fetch("https://api.acme-lint.dev/v1/rules");' });
  before1 = { schema: 1, takenAt: '2026-11-01T00:00:00.000Z', extensions: await discoverExtensions() };
});

after(() => {
  delete process.env.UPDIFF_EXTENSIONS_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe('finding extensions', () => {
  test('reads Chromium, Firefox and VS Code extensions', () => {
    assert.deepEqual(
      before1.extensions.map((e) => [e.hostName, e.profile, e.name, e.version]),
      [
        ['Brave', 'Profile 1', 'Tab Saver', '2.0'],
        ['Chrome', 'Default', 'Page Helper', '1.0.0'],
        ['Firefox', 'default-release', 'Notes', '3.0'],
        ['VS Code', undefined, 'Acme Linter', '1.0.0'],
      ],
    );
  });

  test('splits MV2 host patterns out of permissions and reads content scripts', () => {
    const brave = before1.extensions.find((e) => e.host === 'brave')!;
    assert.deepEqual(brave.permissions, ['tabs']);
    assert.deepEqual(brave.hostPermissions, ['https://*/*']);
    assert.deepEqual(brave.contentScriptMatches, ['https://news.example-site.com/*']);
  });

  test('records what an editor extension runs and contacts', () => {
    const vs = before1.extensions.find((e) => e.host === 'vscode')!;
    assert.equal(vs.id, 'acme.linter');
    assert.deepEqual(vs.activationEvents, ['onLanguage:python']);
    assert.deepEqual(vs.npmDependencies, ['minimatch']);
    assert.deepEqual(vs.domains, ['acme-lint.dev']);
  });
});

test('broad host patterns and version ordering', () => {
  for (const p of ['<all_urls>', '*://*/*', 'https://*/*', 'http://*/*', 'file:///*']) assert.equal(isBroadPattern(p), true, p);
  for (const p of ['https://*.example.com/*', 'https://docs.example.com/*']) assert.equal(isBroadPattern(p), false, p);
  assert.ok(compareVersions('1.10.0', '1.9.2') > 0);
  assert.ok(compareVersions('2026.1012.1545', '2026.1001.1') > 0);
});

describe('an update that quietly widens access', () => {
  before(async () => {
    // Chrome: new cookie access, every website, and a different update server.
    chromeExtension('1.1.0', {
      permissions: ['storage', 'cookies', 'alarms'],
      host_permissions: ['https://docs.example-app.com/*', '<all_urls>'],
      update_url: 'https://updates.example-thirdparty.net/crx',
    });
    // Brave: uninstalled.
    rmSync(join(support, 'BraveSoftware'), { recursive: true, force: true });
    // Firefox: a new add-on that can read every website.
    firefox([notes, mozillaNewTab, systemAddon, { ...notes, id: 'coupons@example.net', defaultLocale: { name: 'Coupon Finder' }, version: '1.0', userPermissions: { permissions: ['webRequest'], origins: ['<all_urls>'] } }]);
    // VS Code: always on, pulls in another extension, new package, new domain, native code.
    const dir = vscodeExtension(
      '1.1.0',
      { activationEvents: ['onStartupFinished'], extensionPack: ['acme.telemetry'], main: './out/extension.js', dependencies: { minimatch: '^9.0.0', 'analytics-node': '^6.0.0' } },
      { 'out/extension.js': 'fetch("https://api.acme-lint.dev/v1/rules"); track("https://events.collector-cdn.io/v2");' },
    );
    mkdirSync(join(dir, 'bin'), { recursive: true });
    copyFileSync('/usr/bin/true', join(dir, 'bin', 'helper.node'));
    chmodSync(join(dir, 'bin', 'helper.node'), 0o755);
    after1 = { schema: 1, takenAt: '2026-11-08T00:00:00.000Z', extensions: await discoverExtensions() };
  });

  test('reports each change at the right severity', () => {
    const r = diffExtensions(before1, after1);
    const titles = r.findings.map((f) => `${f.severity}: ${f.title}`);
    for (const t of [
      'high: Page Helper (Chrome) can now read and change all websites in 1.1.0',
      'high: Page Helper (Chrome) gained the "cookies" permission in 1.1.0',
      'high: Page Helper (Chrome) now updates from a different server',
      'high: New extension: Coupon Finder (Firefox, default-release) with access to all websites',
      'high: Acme Linter (VS Code) now installs other extensions in 1.1.0',
      'notable: Acme Linter (VS Code) now starts with every editor window in 1.1.0',
      'notable: Acme Linter (VS Code) bundles 1 new npm package in 1.1.0',
      'notable: Acme Linter (VS Code) ships new native code in 1.1.0',
      'notable: Acme Linter (VS Code) mentions new domains in 1.1.0',
      'info: Page Helper (Chrome) gained the "alarms" permission in 1.1.0',
      'info: Removed extension: Tab Saver (Brave, Profile 1)',
      'info: Page Helper (Chrome) 1.0.0 → 1.1.0',
    ]) {
      assert.ok(titles.includes(t), `missing: ${t}\n${titles.join('\n')}`);
    }
    assert.equal(r.findings.find((f) => f.title.includes('mentions new domains'))!.detail, 'collector-cdn.io');
    assert.equal(r.findings.find((f) => f.title.includes('installs other extensions'))!.detail, 'acme.telemetry');
  });

  test('the same set twice has no findings', () => {
    assert.equal(diffExtensions(after1, after1).findings.length, 0);
  });
});

describe('the extensions commands', () => {
  const cli = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await main([...args, '--home', store], { out: (s) => (out += s), err: (s) => (err += s), color: false });
    return { code, out, err };
  };

  test('lists extensions', async () => {
    const r = await cli(['extensions']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Chrome · Default\n\s+Page Helper\s+1\.1\.0\s+all websites · cookies/);
    assert.match(r.out, /Acme Linter\s+1\.1\.0\s+starts with every window · 1 native binary · 2 domains in code/);
    assert.match(r.out, /4 extensions\./);
  });

  test('check takes a baseline, then reports changes', async () => {
    let r = await cli(['extensions', 'check']);
    assert.match(r.out, /Saved a baseline of 4 extensions/);
    r = await cli(['extensions', 'check']);
    assert.match(r.out, /No changes in 4 extensions/);
    chromeExtension('1.2.0', { permissions: ['storage', 'cookies', 'alarms', 'history'], host_permissions: ['https://docs.example-app.com/*', '<all_urls>'], update_url: 'https://updates.example-thirdparty.net/crx' });
    r = await cli(['extensions', 'check', '--format', 'json']);
    const json = JSON.parse(r.out);
    assert.equal(json.changes.counts.high, 1);
    assert.ok(json.changes.findings.some((f: { title: string }) => f.title === 'Page Helper (Chrome) gained the "history" permission in 1.2.0'));
    assert.match(json.reportFile, /reports\/extensions\//);
  });

  test('check --extensions includes them with the apps', async () => {
    const r = await cli(['check', '--extensions', '--apps-dir', join(root, 'no-apps'), '--format', 'json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).extensions.count, 4);
  });
});

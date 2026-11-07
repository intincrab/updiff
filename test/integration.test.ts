import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DOMAIN_LIST_THRESHOLD, scanBundle } from '../src/bundle.ts';
import { main } from '../src/commands.ts';
import { diffSnapshots } from '../src/diff.ts';
import type { DiffReport, Snapshot } from '../src/types.ts';
import { BUNDLE_ID, buildApp, hasCompiler, V1, V2 } from './fixtures.ts';

const root = mkdtempSync(join(tmpdir(), 'updiff-it-'));
let v1Path = '';
let v2Path = '';
let s1: Snapshot;
let s2: Snapshot;
let report: DiffReport;

async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const code = await main(args, { out: (s) => (out += s), err: (s) => (err += s), color: false });
    return { code, out, err };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

before(async () => {
  v1Path = await buildApp(join(root, 'v1'), V1);
  v2Path = await buildApp(join(root, 'v2'), V2);
  s1 = await scanBundle(v1Path);
  s2 = await scanBundle(v2Path);
  report = diffSnapshots(s1, s2);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('scanning a signed fixture app', () => {
  test('reads identity, signing and entitlements', () => {
    assert.equal(s1.app.bundleId, BUNDLE_ID);
    assert.equal(s1.app.version, '1.0.0');
    assert.equal(s1.app.build, '100');
    assert.equal(s1.signing.status, 'adhoc');
    assert.equal(s1.signing.hardenedRuntime, true);
    assert.equal(s2.signing.hardenedRuntime, false);
    const main1 = s1.code.find((c) => c.kind === 'main')!;
    assert.deepEqual(main1.entitlements, { 'com.apple.security.cs.allow-jit': true });
    assert.deepEqual(Object.keys(s1.info.privacyUsage), ['NSMicrophoneUsageDescription']);
    assert.deepEqual(s1.info.urlSchemes, ['fixture']);
  });

  test('finds nested code, background items and Electron details', () => {
    const kinds = (s: Snapshot): string[] => s.code.map((c) => `${c.kind}:${c.key}`).sort();
    assert.deepEqual(kinds(s1), [
      'framework:Contents/Frameworks/Electron Framework.framework',
      'helperApp:Contents/Frameworks/Fixture Helper.app',
      'main:Contents/MacOS/Fixture',
    ]);
    assert.deepEqual(kinds(s2), [
      'framework:Contents/Frameworks/Electron Framework.framework',
      'helperApp:Contents/Frameworks/Fixture Helper.app',
      'loginItem:Contents/Library/LoginItems/FixtureLauncher.app',
      'main:Contents/MacOS/Fixture',
      'nativeModule:Contents/Resources/app.asar.unpacked/node_modules/fastnative/build/Release/fastnative.node',
    ]);
    const helper = s1.code.find((c) => c.kind === 'helperApp')!;
    assert.equal(helper.bundleId, `${BUNDLE_ID}.helper`);
    assert.deepEqual(helper.entitlements, { 'com.apple.security.cs.allow-jit': true });
    assert.equal(s1.code.find((c) => c.kind === 'framework')!.version, '33.2.0');

    assert.deepEqual(s1.backgroundItems, []);
    assert.deepEqual(s2.backgroundItems, [
      {
        kind: 'launchAgent',
        file: `Contents/Library/LaunchAgents/${BUNDLE_ID}.agent.plist`,
        label: `${BUNDLE_ID}.agent`,
        program: 'Contents/MacOS/Fixture',
        runAtLoad: true,
        keepAlive: true,
      },
    ]);
    assert.equal(s1.electron?.electronVersion, '33.2.0');
    assert.equal(s1.electron?.appSource, 'Contents/Resources/app.asar');
    assert.equal(s1.electron?.appName, 'Fixture');
    assert.equal(s1.electron?.appVersion, '1.0.0');
    assert.deepEqual(s1.electron?.packages, { 'left-pad': ['1.3.0'] });
    assert.deepEqual(s2.electron?.packages, { 'ai-plugin': ['0.3.0'], 'left-pad': ['1.3.0'] });
  });

  test('finds hostnames in code but not in docs, manifests or source maps', (t) => {
    const hosts1 = Object.keys(s1.hosts);
    assert.ok(hosts1.includes('api.fixture-app.com'));
    assert.deepEqual(s1.hosts['api.fixture-app.com']!.where, ['Contents/Resources/app.asar:dist/main.js']);
    const hosts2 = Object.keys(s2.hosts);
    assert.ok(hosts2.includes('telemetry.newvendor.io'));
    assert.equal(s2.hosts['events.tracker.ai']?.viaUrl, false);
    for (const skipped of ['readme-only-host.example-docs.com', 'github.com', 'sourcemap-only.example-maps.io']) {
      assert.ok(!hosts2.includes(skipped), `${skipped} should not be scanned`);
    }
    // Frameworks are only read with --deep.
    assert.ok(!hosts2.includes('chromium-framework.example-electron.org'));
    if (!hasCompiler()) {
      t.skip('no C compiler: fixture binaries carry no strings');
      return;
    }
    assert.ok(hosts1.includes('updates.fixture-app.com'), 'host in the main executable');
    assert.ok(hosts2.includes('native.newvendor.io'), 'host in the unpacked native module');
    assert.deepEqual(s2.hosts['native.newvendor.io']!.where, ['Contents/Resources/app.asar.unpacked/node_modules/fastnative/build/Release/fastnative.node']);
  });

  test('--deep also reads framework binaries', async (t) => {
    if (!hasCompiler()) {
      t.skip('no C compiler');
      return;
    }
    const deep = await scanBundle(v1Path, { deep: true });
    assert.ok('chromium-framework.example-electron.org' in deep.hosts);
    assert.equal(deep.stats.deep, true);
  });

  test('ignores framework versions that Versions/Current does not point to', async () => {
    const app = await buildApp(join(root, 'stale'), { ...V1, staleFrameworkVersion: true, unsigned: true });
    const s = await scanBundle(app, { deep: true });
    assert.ok(!s.code.some((c) => c.path.includes('Versions/OLD')));
    assert.ok(!('stale.leftover.io' in s.hosts));
    assert.ok(s.stats.warnings.some((w) => w.includes('Versions/OLD')));
    // The bundle was never signed; on Apple silicon the linker still ad-hoc signs binaries.
    assert.notEqual(s.signing.status, 'signed');
  });
});

test('drops bundled domain lists but keeps real URLs from the same file', async () => {
  const list = Array.from({ length: DOMAIN_LIST_THRESHOLD + 50 }, (_, i) => `"city${i}.region.jp"`).join(',');
  const app = await buildApp(join(root, 'list'), {
    ...V1,
    unsigned: true,
    asar: { ...V1.asar, 'dist/psl.js': `const SUFFIXES = [${list}]; fetch("https://psl-updates.listvendor.com/latest");` },
  });
  const s = await scanBundle(app);
  assert.ok(!('city1.region.jp' in s.hosts));
  assert.ok('psl-updates.listvendor.com' in s.hosts);
  assert.ok('api.fixture-app.com' in s.hosts);
  assert.ok(s.stats.warnings.some((w) => w.includes(`Skipped ${DOMAIN_LIST_THRESHOLD + 50} bare hostnames in Contents/Resources/app.asar:dist/psl.js`)));
});

describe('diffing the two fixture versions', () => {
  test('reports every planted change at the right severity', () => {
    const high = report.findings.filter((f) => f.severity === 'high').map((f) => f.title).sort();
    assert.deepEqual(high, [
      'App can now use the camera',
      'App dropped the hardened runtime',
      'Can now ask for access to Camera',
      'Helper app Fixture Helper.app dropped the hardened runtime',
      'New background agent: com.example.updiff-fixture.agent.plist',
      'New login item: FixtureLauncher.app',
    ].sort());
    const notable = report.findings.filter((f) => f.severity === 'notable').map((f) => f.title);
    for (const t of [
      'Electron 33.2.0 → 35.1.0',
      'Opens fixture-auth:// links',
      'New native Node module: fastnative.node',
      '1 new bundled npm package',
      'New domain newvendor.io',
      'New domain tracker.ai',
    ]) {
      assert.ok(notable.includes(t), `missing notable finding: ${t}`);
    }
    const domain = report.findings.find((f) => f.title === 'New domain newvendor.io')!;
    assert.ok(domain.where!.some((w) => w.endsWith('dist/ai.js')));
    assert.ok(report.findings.some((f) => f.title === 'Version 1.0.0 (100) → 2.0.0 (200)'));
  });

  test('a snapshot compared with itself is identical', () => {
    const r = diffSnapshots(s1, s1);
    assert.equal(r.identical, true);
    assert.equal(r.findings.length, 0);
  });

  test('rescanning an unchanged app gives the same fingerprint and no findings', async () => {
    const again = await scanBundle(v1Path);
    assert.equal(again.fingerprint, s1.fingerprint);
    const r = diffSnapshots(s1, again);
    assert.equal(r.identical, true);
  });
});

describe('the command line', () => {
  const home = join(root, 'home');
  const apps = join(root, 'apps');
  const base = ['--home', home, '--apps-dir', apps];

  test('snapshot, check, diff and list follow an app through an update', async () => {
    mkdirSync(apps, { recursive: true });
    cpSync(v1Path, join(apps, 'Fixture.app'), { recursive: true, verbatimSymlinks: true });

    let r = await cli(['snapshot', ...base]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 app: 1 new, 0 changed, 0 unchanged, 0 failed/);

    r = await cli(['snapshot', ...base]);
    assert.match(r.out, /1 unchanged/);

    r = await cli(['diff', 'Fixture', ...base]);
    assert.equal(r.code, 2);
    assert.match(r.err, /Only one snapshot/);

    // The app updates.
    rmSync(join(apps, 'Fixture.app'), { recursive: true, force: true });
    cpSync(v2Path, join(apps, 'Fixture.app'), { recursive: true, verbatimSymlinks: true });

    // Before a new snapshot exists, diffing the installed app compares it with the stored one.
    r = await cli(['diff', 'Fixture', '--format', 'json', ...base]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).counts.high, 6);

    r = await cli(['check', '--format', 'json', ...base]);
    assert.equal(r.code, 0, r.err);
    const checked = JSON.parse(r.out);
    assert.equal(checked.checked, 1);
    assert.equal(checked.changed.length, 1);
    assert.equal(checked.changed[0].counts.high, 6);
    const reportFile: string = checked.changed[0].reportFile;
    assert.ok(existsSync(reportFile));
    assert.match(readFileSync(reportFile, 'utf8'), /^# Fixture: 1\.0\.0 → 2\.0\.0/);

    // A second check finds nothing new.
    r = await cli(['check', ...base]);
    assert.match(r.out, /Checked 1 app, 0 updated\./);

    r = await cli(['diff', BUNDLE_ID, '--min-severity', 'high', ...base]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /6 high · 0 notable · 0 info/);
    assert.match(r.out, /App can now use the camera/);

    r = await cli(['diff', BUNDLE_ID, '--format', 'md', '--out', join(root, 'r.md'), ...base]);
    assert.equal(r.code, 0);
    assert.match(readFileSync(join(root, 'r.md'), 'utf8'), /## High/);

    r = await cli(['list', ...base]);
    assert.match(r.out, /Fixture\s+2\.0\.0\s+2 snapshots\s+com\.example\.updiff-fixture/);
    r = await cli(['list', BUNDLE_ID, '--format', 'json', ...base]);
    assert.deepEqual(JSON.parse(r.out).map((s: { version: string }) => s.version), ['1.0.0', '2.0.0']);
  });

  test('diff compares two bundles or snapshot files directly', async () => {
    let r = await cli(['diff', v1Path, v2Path, '--format', 'json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).counts.high, 6);

    const files = (await cli(['list', BUNDLE_ID, '--format', 'json', ...base])).out;
    const [first, second] = JSON.parse(files) as Array<{ file: string }>;
    r = await cli(['diff', first!.file, second!.file, '--format', 'json']);
    assert.equal(JSON.parse(r.out).counts.high, 6);
  });

  test('scan prints a summary', async () => {
    const r = await cli(['scan', v2Path]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Fixture 2\.0\.0 \(200\)/);
    assert.match(r.out, /Signing\s+adhoc, no hardened runtime/);
    assert.match(r.out, /Background\s+com\.example\.updiff-fixture\.agent → Contents\/MacOS\/Fixture/);
    assert.match(r.out, /Electron\s+35\.1\.0/);
  });

  test('agent writes a LaunchAgent without loading it', async () => {
    const agents = join(root, 'LaunchAgents');
    let r = await cli(['agent', 'install', '--dry-run', ...base]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /<key>Label<\/key>\s*<string>dev\.updiff\.check<\/string>/);
    assert.match(r.out, /<string>check<\/string>/);
    assert.match(r.out, /<key>WatchPaths<\/key>/);
    assert.ok(!existsSync(join(agents, 'dev.updiff.check.plist')));

    r = await cli(['agent', 'install', '--no-load', ...base], { UPDIFF_LAUNCH_AGENTS_DIR: agents });
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(agents, 'dev.updiff.check.plist')));
    r = await cli(['agent', 'uninstall', '--no-load'], { UPDIFF_LAUNCH_AGENTS_DIR: agents });
    assert.match(r.out, /Removed/);
    assert.ok(!existsSync(join(agents, 'dev.updiff.check.plist')));
  });

  test('reports usage errors with exit code 2', async () => {
    assert.equal((await cli(['frobnicate'])).code, 2);
    assert.equal((await cli(['diff', 'No Such App Anywhere', ...base])).code, 2);
    assert.equal((await cli(['diff', '--format', 'xml', 'x'])).code, 2);
    assert.equal((await cli(['--bogus-flag'])).code, 2);
    assert.equal((await cli([])).code, 2);
    assert.match((await cli(['--help'])).out, /Usage:/);
  });
});

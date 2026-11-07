import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { main } from '../src/commands.ts';
import { inspectPkg, parseCheckSignature, parseDistribution, type PkgReport } from '../src/pkg.ts';
import { toPlistXml } from '../src/plist.ts';
import { lineDiff } from '../src/util.ts';
import { buildApp, V1, V2 } from './fixtures.ts';

const root = mkdtempSync(join(tmpdir(), 'updiff-pkg-'));
const sentinel = join(root, 'SENTINEL-a-script-ran');
let v1Pkg = '';
let v2Pkg = '';
let v2: PkgReport;

function writeScript(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** Builds a component package, then wraps it in a product archive with an optional Distribution script. */
function buildPkg(name: string, payload: string, scripts: string, version: string, js?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const comp = join(dir, 'component.pkg');
  execFileSync('/usr/bin/pkgbuild', ['--quiet', '--root', payload, '--scripts', scripts, '--identifier', 'com.example.fixture', '--version', version, '--install-location', '/', comp]);
  const dist = join(dir, 'Distribution.xml');
  execFileSync('/usr/bin/productbuild', ['--quiet', '--synthesize', '--package', comp, dist]);
  if (js) {
    const xml = readFileSync(dist, 'utf8').replace('</installer-gui-script>', `    <title>Fixture</title>\n    <installation-check script="check()"/>\n    <script>${js}</script>\n</installer-gui-script>`);
    writeFileSync(dist, xml);
  }
  const out = join(dir, `Fixture-${version}.pkg`);
  execFileSync('/usr/bin/productbuild', ['--quiet', '--distribution', dist, '--package-path', dir, out]);
  return out;
}

before(async () => {
  // Version 1: the app, plus scripts that would leave a trace if anything ran them.
  const p1 = join(root, 'payload1');
  const s1 = join(root, 'scripts1');
  mkdirSync(join(p1, 'Applications'), { recursive: true });
  mkdirSync(s1, { recursive: true });
  cpSync(await buildApp(join(root, 'app1'), V1), join(p1, 'Applications', 'Fixture.app'), { recursive: true, verbatimSymlinks: true });
  writeScript(join(s1, 'preinstall'), `#!/bin/bash\ntouch "${sentinel}"\n`);
  writeScript(join(s1, 'postinstall'), '#!/bin/sh\nlaunchctl kickstart -k system/com.example.fixture\nexit 0\n');
  v1Pkg = buildPkg('v1', p1, s1, '1.0.0');

  // Version 2: a root launch daemon, a privileged helper, a command-line tool, changed scripts and installer JavaScript.
  const p2 = join(root, 'payload2');
  const s2 = join(root, 'scripts2');
  for (const d of ['Applications', 'Library/LaunchDaemons', 'Library/PrivilegedHelperTools', 'usr/local/bin']) mkdirSync(join(p2, d), { recursive: true });
  mkdirSync(s2, { recursive: true });
  cpSync(await buildApp(join(root, 'app2'), V2), join(p2, 'Applications', 'Fixture.app'), { recursive: true, verbatimSymlinks: true });
  writeFileSync(
    join(p2, 'Library/LaunchDaemons/com.example.fixture.helper.plist'),
    toPlistXml({ Label: 'com.example.fixture.helper', Program: '/Library/PrivilegedHelperTools/com.example.fixture.helper', RunAtLoad: true, KeepAlive: true }),
  );
  copyFileSync('/usr/bin/true', join(p2, 'Library/PrivilegedHelperTools/com.example.fixture.helper'));
  writeScript(join(p2, 'usr/local/bin/fixture'), '#!/bin/sh\necho fixture\n');
  writeScript(join(s2, 'preinstall'), `#!/bin/bash\ntouch "${sentinel}"\n`);
  writeScript(join(s2, 'postinstall'), '#!/bin/sh\nlaunchctl kickstart -k system/com.example.fixture\ncurl -s https://telemetry.example-vendor.io/installed\nexit 0\n');
  writeScript(join(s2, 'helper.sh'), '#!/bin/sh\necho helper\n');
  v2Pkg = buildPkg('v2', p2, s2, '2.0.0', 'function check() { return system.compareVersions(system.version.ProductVersion, "13.0") >= 0; }');
  v2 = await inspectPkg(v2Pkg);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('inspecting an installer package', () => {
  test('never runs its scripts', () => {
    assert.ok(!existsSync(sentinel), 'a package script ran');
  });

  test('reads identity, signature, Gatekeeper and root rights', () => {
    assert.equal(v2.components.length, 1);
    const c = v2.components[0]!;
    assert.equal(c.id, 'com.example.fixture');
    assert.equal(c.version, '2.0.0');
    assert.equal(c.auth, 'root');
    assert.equal(v2.signature.status, 'no signature');
    assert.equal(v2.signature.notarized, false);
    assert.equal(v2.gatekeeper.assessment, 'rejected');
    assert.match(v2.sha256, /^[0-9a-f]{64}$/);
  });

  test('lists scripts in the order they run, with their text', () => {
    const c = v2.components[0]!;
    assert.deepEqual(c.scripts.map((s) => [s.name, s.hook, s.interpreter]), [
      ['preinstall', true, 'bash'],
      ['postinstall', true, 'sh'],
      ['helper.sh', false, 'sh'],
    ]);
    assert.match(c.scripts[1]!.content!, /curl -s https:\/\/telemetry\.example-vendor\.io\/installed/);
  });

  test('finds apps, launch daemons, privileged helpers and files outside /Applications', () => {
    const c = v2.components[0]!;
    assert.deepEqual(c.apps.map((a) => [a.path, a.bundleId, a.version]), [['/Applications/Fixture.app', 'com.example.updiff-fixture', '2.0.0']]);
    assert.deepEqual(c.launchItems, [
      {
        path: '/Library/LaunchDaemons/com.example.fixture.helper.plist',
        kind: 'daemon',
        label: 'com.example.fixture.helper',
        program: '/Library/PrivilegedHelperTools/com.example.fixture.helper',
        runAtLoad: true,
        keepAlive: true,
      },
    ]);
    assert.deepEqual(c.systemLevel, ['/Library/PrivilegedHelperTools/com.example.fixture.helper']);
    assert.deepEqual(c.outsideApplications, ['/Library/LaunchDaemons/com.example.fixture.helper.plist', '/Library/PrivilegedHelperTools/com.example.fixture.helper', '/usr/local/bin']);
  });

  test('shows the installer JavaScript', () => {
    assert.equal(v2.distribution?.title, 'Fixture');
    assert.deepEqual(v2.distribution?.checks, ['installation-check: check()']);
    assert.match(v2.distribution?.scripts[0] ?? '', /function check\(\)/);
  });
});

describe('the pkg command', () => {
  const cli = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await main(args, { out: (s) => (out += s), err: (s) => (err += s), color: false });
    return { code, out, err };
  };

  test('prints what the package would do', async () => {
    const r = await cli(['pkg', v2Pkg]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Runs as\s+root: the installer asks for an administrator password/);
    assert.match(r.out, /Launch daemon \/Library\/LaunchDaemons\/com\.example\.fixture\.helper\.plist\s+label com\.example\.fixture\.helper · runs \/Library\/PrivilegedHelperTools\/com\.example\.fixture\.helper · starts at boot · kept alive/);
    assert.match(r.out, /Runs after installing as root: postinstall \(sh, 5 lines/);
    assert.match(r.out, /│ curl -s https:\/\/telemetry\.example-vendor\.io\/installed/);
    assert.match(r.out, /Installer UI\s+2 JavaScript checks run when the installer opens/);
    assert.match(r.out, /Nothing was installed or run/);
  });

  test('compares two versions, newest first', async () => {
    const r = await cli(['pkg', v2Pkg, v1Pkg, '--format', 'json']);
    assert.equal(r.code, 0, r.err);
    const report = JSON.parse(r.out);
    assert.equal(report.from.version, '1.0.0');
    assert.equal(report.to.version, '2.0.0');
    const titles: string[] = report.findings.map((f: { severity: string; title: string }) => `${f.severity}: ${f.title}`);
    for (const t of [
      'high: Installs a new launch daemon: /Library/LaunchDaemons/com.example.fixture.helper.plist',
      'high: Installs a new system-level item: /Library/PrivilegedHelperTools/com.example.fixture.helper',
      'notable: Script postinstall changed (+1 −0 lines)',
      'notable: New helper file helper.sh',
      'notable: Installer JavaScript changed',
      'notable: Installs files in new places outside /Applications',
    ]) {
      assert.ok(titles.includes(t), `missing: ${t}\n${titles.join('\n')}`);
    }
    const script = report.findings.find((f: { title: string }) => f.title.startsWith('Script postinstall changed'));
    assert.equal(script.detail, '+ curl -s https://telemetry.example-vendor.io/installed');
    assert.ok(!existsSync(sentinel));
  });

  test('a package compared with itself has no findings', async () => {
    const r = await cli(['pkg', v1Pkg, v1Pkg, '--format', 'json']);
    assert.equal(JSON.parse(r.out).findings.length, 0);
  });

  test('reports a missing file as a usage error', async () => {
    assert.equal((await cli(['pkg', join(root, 'nope.pkg')])).code, 2);
  });
});

test('parses package signatures and Distribution files', () => {
  assert.deepEqual(
    parseCheckSignature(`Package "Zoom.pkg":
   Status: signed by a developer certificate issued by Apple for distribution
   Notarization: trusted by the Apple notary service
   Signed with a trusted timestamp on: 2026-10-30 08:00:00 +0000
   Certificate Chain:
    1. Developer ID Installer: Zoom Communications, Inc. (BJ4HAAB9B3)
       Expires: 2027-03-01 00:00:00 +0000
    2. Developer ID Certification Authority`),
    { status: 'signed by a developer certificate issued by Apple for distribution', signer: 'Developer ID Installer: Zoom Communications, Inc. (BJ4HAAB9B3)', notarized: true },
  );
  assert.deepEqual(parseDistribution('<installer-gui-script><title>A &amp; B</title><script><![CDATA[function x() { return 1 < 2; }]]></script></installer-gui-script>'), {
    title: 'A & B',
    scripts: ['function x() { return 1 < 2; }'],
    checks: [],
  });
});

test('line diff marks added and removed lines', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd'), ['- b', '+ d']);
  assert.deepEqual(lineDiff('same', 'same'), []);
});

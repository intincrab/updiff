import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffSnapshots, filterBySeverity } from '../src/diff.ts';
import { renderJson, renderMarkdown, renderText } from '../src/report.ts';
import { SNAPSHOT_SCHEMA, type CodeItem, type DiffReport, type Snapshot } from '../src/types.ts';

function base(): Snapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    tool: { name: 'updiff', version: 'test' },
    takenAt: '2026-11-01T00:00:00.000Z',
    fingerprint: 'aaa',
    app: { path: '/Applications/Foo.app', name: 'Foo', bundleId: 'com.example.foo', version: '1.0', build: '100', sizeBytes: 1000, fileCount: 10 },
    info: {
      executable: 'Foo',
      urlSchemes: ['foo'],
      privacyUsage: { NSCameraUsageDescription: 'For video calls.' },
      atsArbitraryLoads: false,
      atsExceptionDomains: [],
      backgroundOnly: false,
      sparkleFeedUrl: 'https://foo.example-cdn.com/appcast.xml',
      sparklePublicKey: 'KEY1',
      privilegedExecutables: [],
    },
    signing: { status: 'signed', teamId: 'TEAM1', authorities: ['Developer ID Application: Foo Inc (TEAM1)'], hardenedRuntime: true, flags: ['runtime'] },
    code: [
      {
        kind: 'main',
        key: 'Contents/MacOS/Foo',
        path: 'Contents/MacOS/Foo',
        bundleId: 'com.example.foo',
        signing: { status: 'signed', teamId: 'TEAM1', authorities: ['Developer ID Application: Foo Inc (TEAM1)'], hardenedRuntime: true, flags: ['runtime'] },
        entitlements: { 'com.apple.security.app-sandbox': true, 'com.apple.security.application-groups': ['TEAM1.group'] },
      },
      {
        kind: 'helperApp',
        key: 'Contents/Frameworks/Foo Helper.app',
        path: 'Contents/Frameworks/Foo Helper.app',
        bundleId: 'com.example.foo.helper',
        signing: { status: 'signed', teamId: 'TEAM1', authorities: [], hardenedRuntime: true, flags: ['runtime'] },
        entitlements: {},
      },
      {
        kind: 'framework',
        key: 'Contents/Frameworks/Electron Framework.framework',
        path: 'Contents/Frameworks/Electron Framework.framework',
        version: '33.0.0',
      },
    ],
    backgroundItems: [],
    electron: { electronVersion: '33.0.0', appSource: 'Contents/Resources/app.asar', packages: { 'left-pad': ['1.0.0'], lodash: ['4.17.20'] }, fileCount: 3 },
    hosts: {
      'api.foo.com': { count: 2, viaUrl: true, where: ['Contents/Resources/app.asar:dist/main.js'] },
      'docs.foo.com': { count: 1, viaUrl: true, where: ['Contents/Resources/app.asar:dist/main.js'] },
    },
    stats: { scanMs: 1, filesScanned: 1, bytesScanned: 1, deep: false, warnings: [] },
  };
}

function clone(s: Snapshot): Snapshot {
  return structuredClone(s);
}

function next(): Snapshot {
  const s = clone(base());
  s.takenAt = '2026-11-02T00:00:00.000Z';
  s.fingerprint = 'bbb';
  s.app.version = '2.0';
  s.app.build = '200';
  return s;
}

function titles(r: DiffReport, sev?: string): string[] {
  return r.findings.filter((f) => !sev || f.severity === sev).map((f) => f.title);
}

function main(s: Snapshot): CodeItem {
  return s.code.find((c) => c.kind === 'main')!;
}

test('the same snapshot twice is identical', () => {
  const r = diffSnapshots(base(), base());
  assert.equal(r.identical, true);
  assert.deepEqual(r.findings, []);
});

test('a plain version bump only reports the version', () => {
  const r = diffSnapshots(base(), next());
  assert.equal(r.identical, false);
  assert.deepEqual(titles(r), ['Version 1.0 (100) → 2.0 (200)']);
  assert.deepEqual(r.counts, { high: 0, notable: 0, info: 1 });
});

test('flags signing changes', () => {
  const b = next();
  b.code[0]!.signing = { status: 'signed', teamId: 'EVIL9', authorities: ['Developer ID Application: Someone Else (EVIL9)'], hardenedRuntime: false, flags: [] };
  const r = diffSnapshots(base(), b);
  assert.deepEqual(titles(r, 'high').sort(), ['App dropped the hardened runtime', 'App is signed by a different developer team']);

  const c = next();
  main(c).signing = { status: 'adhoc', authorities: [], hardenedRuntime: true, flags: ['adhoc', 'runtime'] };
  assert.ok(titles(diffSnapshots(base(), c), 'high').includes('App is no longer signed by a developer'));
});

test('flags entitlement changes by sensitivity', () => {
  const b = next();
  const ents = main(b).entitlements!;
  ents['com.apple.security.device.camera'] = true;
  ents['com.apple.security.cs.allow-jit'] = true;
  ents['com.apple.security.network.client'] = true;
  (ents['com.apple.security.application-groups'] as string[]).push('TEAM1.other');
  delete ents['com.apple.security.app-sandbox'];
  const r = diffSnapshots(base(), b);
  assert.deepEqual(titles(r, 'high').sort(), ['App can now use the camera', 'App is no longer sandboxed']);
  const notable = titles(r, 'notable');
  assert.ok(notable.includes('App can now generate code at runtime (JIT)'));
  assert.ok(notable.includes('App gained entitlement com.apple.security.network.client'));
  assert.ok(notable.includes('com.apple.security.application-groups gained 1 value'));
});

test('sandbox switched to false is still high', () => {
  const b = next();
  main(b).entitlements!['com.apple.security.app-sandbox'] = false;
  assert.deepEqual(titles(diffSnapshots(base(), b), 'high'), ['App is no longer sandboxed']);
});

test('flags Info.plist changes', () => {
  const b = next();
  b.info.privacyUsage.NSMicrophoneUsageDescription = 'To hear you.';
  b.info.privacyUsage.NSCameraUsageDescription = 'For video calls and photos.';
  b.info.urlSchemes = ['foo', 'foo-auth'];
  b.info.atsArbitraryLoads = true;
  b.info.sparklePublicKey = 'KEY2';
  b.info.sparkleFeedUrl = 'https://elsewhere.example-cdn.net/appcast.xml';
  b.info.privilegedExecutables = ['com.example.foo.helper'];
  const r = diffSnapshots(base(), b);
  assert.deepEqual(titles(r, 'high').sort(), [
    'Allows unencrypted HTTP connections (App Transport Security relaxed)',
    'Can now ask for access to Microphone',
    'Declares a new privileged helper: com.example.foo.helper',
    'Update feed moved',
    'Update signing key changed',
  ]);
  assert.ok(titles(r, 'notable').includes('Opens foo-auth:// links'));
  assert.ok(titles(r, 'info').includes('Explanation for Camera access changed'));
});

test('flags new code and background items', () => {
  const b = next();
  b.code.push(
    { kind: 'loginItem', key: 'Contents/Library/LoginItems/FooLauncher.app', path: 'Contents/Library/LoginItems/FooLauncher.app', bundleId: 'com.example.launcher', signing: { status: 'signed', teamId: 'TEAM1', authorities: [], hardenedRuntime: true, flags: [] }, entitlements: {} },
    {
      kind: 'xpcService',
      key: 'Contents/XPCServices/Sync.xpc',
      path: 'Contents/XPCServices/Sync.xpc',
      signing: { status: 'signed', teamId: 'OTHER', authorities: ['Developer ID Application: Vendor (OTHER)'], hardenedRuntime: true, flags: [] },
      entitlements: { 'com.apple.security.device.audio-input': true },
    },
  );
  b.backgroundItems.push({ kind: 'launchAgent', file: 'Contents/Library/LaunchAgents/com.example.foo.agent.plist', label: 'com.example.foo.agent', program: 'Contents/MacOS/Foo', runAtLoad: true, keepAlive: false });
  const r = diffSnapshots(base(), b);
  assert.deepEqual(titles(r, 'high').sort(), [
    'New XPC service Sync.xpc is signed by another developer team',
    'New background agent: com.example.foo.agent.plist',
    'New login item: FooLauncher.app',
    'XPC service Sync.xpc can now record from the microphone',
  ]);
  assert.ok(titles(r, 'notable').includes('New XPC service: Sync.xpc'));
  const agent = r.findings.find((f) => f.category === 'background')!;
  assert.match(agent.detail!, /label com\.example\.foo\.agent · runs Contents\/MacOS\/Foo · starts at login/);
});

test('matches a renamed helper by bundle id', () => {
  const b = next();
  const helper = b.code.find((c) => c.kind === 'helperApp')!;
  helper.key = helper.path = 'Contents/Frameworks/Foo Helper (Renderer).app';
  const r = diffSnapshots(base(), b);
  assert.deepEqual(titles(r).filter((t) => t.includes('helper')), []);
});

test('reports removals as info', () => {
  const b = next();
  b.code = b.code.filter((c) => c.kind !== 'helperApp');
  b.info.privacyUsage = {};
  b.info.urlSchemes = [];
  const r = diffSnapshots(base(), b);
  assert.equal(r.counts.high, 0);
  assert.equal(r.counts.notable, 0);
  assert.ok(titles(r, 'info').includes('Removed helper app: Foo Helper.app'));
  assert.ok(titles(r, 'info').includes('No longer asks for Camera'));
});

test('reports Electron, package and host changes', () => {
  const b = next();
  b.code.find((c) => c.kind === 'framework')!.version = '35.1.0';
  b.electron!.packages['ai-plugin'] = ['0.3.0'];
  b.electron!.packages.lodash = ['4.17.21'];
  delete b.electron!.packages['left-pad'];
  b.hosts['telemetry.newvendor.io'] = { count: 1, viaUrl: true, where: ['Contents/Resources/app.asar:dist/ai.js'] };
  b.hosts['events.newvendor.io'] = { count: 1, viaUrl: false, where: ['Contents/Resources/app.asar:dist/ai.js'] };
  b.hosts['quiet.strings.dev'] = { count: 1, viaUrl: false, where: ['x'] };
  b.hosts['beta.foo.com'] = { count: 1, viaUrl: true, where: ['y'] };
  delete b.hosts['docs.foo.com'];
  const r = diffSnapshots(base(), b);
  const notable = r.findings.filter((f) => f.severity === 'notable');
  assert.deepEqual(notable.map((f) => f.title), ['Electron 33.0.0 → 35.1.0', '1 new bundled npm package', 'New domain newvendor.io', 'New domain strings.dev']);
  assert.equal(notable[1]!.detail, 'ai-plugin@0.3.0');
  assert.equal(notable[2]!.detail, 'events.newvendor.io, telemetry.newvendor.io');
  assert.match(notable[3]!.detail!, /bare string/);
  assert.ok(titles(r, 'info').includes('New host under foo.com'));
  assert.ok(titles(r, 'info').includes('1 bundled npm package removed'));
  assert.ok(titles(r, 'info').includes('1 bundled npm package changed version'));
});

test('different apps are called out', () => {
  const b = next();
  b.app.bundleId = 'com.other.app';
  assert.ok(titles(diffSnapshots(base(), b), 'high').includes('These are different apps'));
});

test('filters by severity and renders every format', () => {
  const b = next();
  main(b).entitlements!['com.apple.security.device.camera'] = true;
  b.hosts['telemetry.newvendor.io'] = { count: 1, viaUrl: true, where: ['dist/ai.js'] };
  const r = diffSnapshots(base(), b);
  const highOnly = filterBySeverity(r, 'high');
  assert.deepEqual(highOnly.counts, { high: 1, notable: 0, info: 0 });

  const text = renderText(r);
  assert.match(text, /Foo {2}1\.0 \(100\) → 2\.0 \(200\)/);
  assert.match(text, /HIGH\n {2}\+ App can now use the camera/);
  assert.match(text, /not proof/);
  assert.doesNotMatch(text, /\x1b\[/);
  assert.match(renderText(r, { color: true }), /\x1b\[31m/);

  const md = renderMarkdown(r);
  assert.match(md, /^# Foo: 1\.0 → 2\.0/);
  assert.match(md, /## High\n\n- Added: \*\*App can now use the camera\*\*/);
  assert.deepEqual(JSON.parse(renderJson(r)).counts, r.counts);
});

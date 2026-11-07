/**
 * Records the README demo: a real run of `updiff snapshot`, an app update, then
 * `updiff check`, captured through a pseudo-terminal so the colours are the CLI's own.
 *
 *   node scripts/demo/record.ts            # writes scripts/demo/transcript.json
 *   node scripts/demo/render-svg.ts        # turns it into docs/demo.svg
 *
 * The demo app "Lumen" is a fictional app built on the fly with the test fixtures
 * (clang, @electron/asar, codesign). Its 4.3.0 "update" adds a camera permission and
 * prompt, a login item, a background agent, an analytics package and a new domain.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type FixtureSpec } from '../../test/fixtures.ts';

const repo = join(import.meta.dirname, '..', '..');
const cli = join(repo, 'src', 'cli.ts');

const BASE: FixtureSpec = {
  name: 'Lumen',
  bundleId: 'com.example.lumen',
  version: '4.2.0',
  build: '420',
  hardenedRuntime: true,
  entitlements: { 'com.apple.security.cs.allow-jit': true },
  info: {
    NSMicrophoneUsageDescription: 'Lumen records voice notes.',
    CFBundleURLTypes: [{ CFBundleURLName: 'lumen', CFBundleURLSchemes: ['lumen'] }],
  },
  electronVersion: '33.2.0',
  mainStrings: ['https://updates.lumen-app.dev/check'],
  asar: {
    'package.json': JSON.stringify({ name: 'lumen', productName: 'Lumen', version: '4.2.0', main: 'dist/main.js' }),
    'dist/main.js': 'fetch("https://api.lumen-app.dev/v1/sync");',
    'node_modules/marked/package.json': JSON.stringify({ name: 'marked', version: '15.0.4' }),
    'node_modules/marked/index.js': 'module.exports = {};',
  },
};

const UPDATE: FixtureSpec = {
  ...BASE,
  version: '4.3.0',
  build: '430',
  entitlements: { ...BASE.entitlements, 'com.apple.security.device.camera': true },
  info: { ...BASE.info, NSCameraUsageDescription: 'Lumen can add video to your notes.' },
  electronVersion: '35.1.0',
  asar: {
    ...BASE.asar,
    'package.json': JSON.stringify({ name: 'lumen', productName: 'Lumen', version: '4.3.0', main: 'dist/main.js' }),
    'dist/main.js': 'fetch("https://api.lumen-app.dev/v1/sync"); import "./assist.js";',
    'dist/assist.js': 'navigator.sendBeacon("https://events.datastreamr.io/v1/collect", payload);',
    'node_modules/@datastreamr/sdk/package.json': JSON.stringify({ name: '@datastreamr/sdk', version: '2.4.1' }),
    'node_modules/@datastreamr/sdk/index.js': 'module.exports = {};',
  },
  loginItem: true,
  launchAgent: true,
};

export type Step = { kind: 'command'; text: string } | { kind: 'comment'; text: string } | { kind: 'output'; lines: string[] };

const root = realpathSync(mkdtempSync(join(tmpdir(), 'updiff-demo-')));
try {
  const home = join(root, 'home');
  const apps = join(home, 'Applications');
  mkdirSync(apps, { recursive: true });
  const v1 = await buildApp(join(root, 'v1'), BASE);
  const v2 = await buildApp(join(root, 'v2'), UPDATE);

  // Colours on (no NO_COLOR), a private home for ~/.updiff, and only the demo app folder.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, UPDIFF_APPS_DIRS: apps };
  delete env.NO_COLOR;

  /** Runs the CLI in a pseudo-terminal and returns its output lines, with ANSI colours. */
  const runCli = (args: string[]): string[] => {
    const r = spawnSync('/usr/bin/script', ['-q', '/dev/null', process.execPath, cli, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) throw new Error(`updiff ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
    return r.stdout
      .replace(/^\^D\x08\x08/, '')
      .replaceAll(home, '~')
      .replace(/\r/g, '')
      .replace(/\n+$/, '')
      .split('\n');
  };

  const steps: Step[] = [];
  cpSync(v1, join(apps, 'Lumen.app'), { recursive: true, verbatimSymlinks: true });
  steps.push({ kind: 'command', text: 'updiff snapshot' });
  steps.push({ kind: 'output', lines: runCli(['snapshot']) });

  // The update.
  rmSync(join(apps, 'Lumen.app'), { recursive: true, force: true });
  cpSync(v2, join(apps, 'Lumen.app'), { recursive: true, verbatimSymlinks: true });
  steps.push({ kind: 'comment', text: '# a week later, Lumen updates itself to 4.3.0…' });
  steps.push({ kind: 'command', text: 'updiff check' });
  steps.push({ kind: 'output', lines: runCli(['check']) });

  const out = join(import.meta.dirname, 'transcript.json');
  writeFileSync(out, JSON.stringify({ recordedAt: new Date().toISOString(), steps }, null, 2) + '\n');
  process.stdout.write(`Wrote ${out}\n`);
  for (const s of steps) {
    if (s.kind === 'output') process.stdout.write(s.lines.join('\n') + '\n');
    else process.stdout.write(`$ ${s.text}\n`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

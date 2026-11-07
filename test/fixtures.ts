import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPackageWithOptions } from '@electron/asar';
import { toPlistXml, type PlistDict } from '../src/plist.ts';

let compiler: boolean | undefined;

/** Whether a C compiler is available to build fixture binaries. */
export function hasCompiler(): boolean {
  if (compiler === undefined) {
    try {
      execFileSync('/usr/bin/xcrun', ['--find', 'clang'], { stdio: 'ignore' });
      compiler = true;
    } catch {
      compiler = false;
    }
  }
  return compiler;
}

/**
 * Writes a Mach-O binary that contains `strings`. Uses clang when available; without
 * it, copies /usr/bin/true (the strings are then missing and host checks are skipped).
 */
function writeBinary(path: string, strings: string[], kind: 'exe' | 'bundle' = 'exe'): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!hasCompiler()) {
    copyFileSync('/usr/bin/true', path);
    chmodSync(path, 0o755);
    return;
  }
  const src = `${path}.c`;
  const decls = strings.map((s, i) => `const char *s${i} = ${JSON.stringify(s)};`).join('\n');
  const uses = strings.map((_, i) => `n += s${i}[0];`).join(' ');
  const body =
    kind === 'exe'
      ? `int main(void) { int n = 0; ${uses} return n == -1; }`
      : `int fixture_entry(void) { int n = 0; ${uses} return n; }`;
  writeFileSync(src, `${decls}\n${body}\n`);
  const args = ['clang', '-O0', '-o', path, src];
  if (kind === 'bundle') args.splice(1, 0, '-bundle');
  execFileSync('/usr/bin/xcrun', args, { stdio: 'pipe' });
  execFileSync('/bin/rm', [src]);
}

function writeInfo(path: string, dict: PlistDict, binary = true): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toPlistXml(dict));
  if (binary) execFileSync('/usr/bin/plutil', ['-convert', 'binary1', path]);
}

function sign(path: string, entitlements?: PlistDict, runtime = false): void {
  const args = ['-f', '-s', '-'];
  if (runtime) args.push('-o', 'runtime');
  if (entitlements && Object.keys(entitlements).length) {
    const file = join(mkdtempSync(join(tmpdir(), 'updiff-ent-')), 'e.plist');
    writeFileSync(file, toPlistXml(entitlements));
    args.push('--entitlements', file);
  }
  execFileSync('/usr/bin/codesign', [...args, path], { stdio: 'pipe' });
}

export interface FixtureSpec {
  /** App name (default "Fixture"); helpers and the login item are named after it. */
  name?: string;
  /** Bundle identifier (default BUNDLE_ID). */
  bundleId?: string;
  version: string;
  build: string;
  hardenedRuntime: boolean;
  entitlements: PlistDict;
  info?: PlistDict;
  electronVersion: string;
  asar: Record<string, string>;
  /** A native Node module, unpacked next to app.asar, with these strings inside. */
  nativeModule?: { path: string; strings: string[] };
  mainStrings: string[];
  loginItem?: boolean;
  launchAgent?: boolean;
  /** Leave an extra, stale framework version beside Versions/Current. */
  staleFrameworkVersion?: boolean;
  /** Skip code signing (for structure-only tests). */
  unsigned?: boolean;
}

export const BUNDLE_ID = 'com.example.updiff-fixture';

/** Builds a small Electron-shaped app bundle and returns its path. */
export async function buildApp(parent: string, spec: FixtureSpec): Promise<string> {
  const name = spec.name ?? 'Fixture';
  const id = spec.bundleId ?? BUNDLE_ID;
  const app = join(parent, `${name}.app`);
  const c = join(app, 'Contents');
  mkdirSync(join(c, 'MacOS'), { recursive: true });
  mkdirSync(join(c, 'Resources'), { recursive: true });

  writeInfo(join(c, 'Info.plist'), {
    CFBundleIdentifier: id,
    CFBundleName: name,
    CFBundleExecutable: name,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: spec.version,
    CFBundleVersion: spec.build,
    LSMinimumSystemVersion: '12.0',
    ...spec.info,
  });
  writeBinary(join(c, 'MacOS', name), spec.mainStrings);

  // Electron Framework, with the usual Versions/A + Current layout.
  const fw = join(c, 'Frameworks', 'Electron Framework.framework');
  const versionDir = join(fw, 'Versions', 'A');
  writeBinary(join(versionDir, 'Electron Framework'), ['https://chromium-framework.example-electron.org/'], 'bundle');
  writeInfo(join(versionDir, 'Resources', 'Info.plist'), {
    CFBundleIdentifier: 'com.github.Electron.framework',
    CFBundleExecutable: 'Electron Framework',
    CFBundlePackageType: 'FMWK',
    CFBundleShortVersionString: spec.electronVersion,
    CFBundleVersion: spec.electronVersion,
  }, false);
  symlinkSync('A', join(fw, 'Versions', 'Current'));
  symlinkSync('Versions/Current/Electron Framework', join(fw, 'Electron Framework'));
  symlinkSync('Versions/Current/Resources', join(fw, 'Resources'));
  if (spec.staleFrameworkVersion) {
    writeBinary(join(fw, 'Versions', 'OLD', 'Helpers', 'stale-tool'), ['https://stale.leftover.io/']);
  }

  // Helper app.
  const helper = join(c, 'Frameworks', `${name} Helper.app`);
  writeInfo(join(helper, 'Contents', 'Info.plist'), {
    CFBundleIdentifier: `${id}.helper`,
    CFBundleExecutable: `${name} Helper`,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: spec.version,
  });
  writeBinary(join(helper, 'Contents', 'MacOS', `${name} Helper`), []);

  let loginItem: string | undefined;
  if (spec.loginItem) {
    loginItem = join(c, 'Library', 'LoginItems', `${name}Launcher.app`);
    writeInfo(join(loginItem, 'Contents', 'Info.plist'), {
      CFBundleIdentifier: `${id}.launcher`,
      CFBundleExecutable: `${name}Launcher`,
      CFBundlePackageType: 'APPL',
      CFBundleShortVersionString: spec.version,
    });
    writeBinary(join(loginItem, 'Contents', 'MacOS', `${name}Launcher`), []);
  }
  if (spec.launchAgent) {
    writeInfo(join(c, 'Library', 'LaunchAgents', `${id}.agent.plist`), {
      Label: `${id}.agent`,
      BundleProgram: `Contents/MacOS/${name}`,
      RunAtLoad: true,
      KeepAlive: true,
    }, false);
  }

  // app.asar with its unpacked native module.
  const src = mkdtempSync(join(tmpdir(), 'updiff-fixture-src-'));
  for (const [p, content] of Object.entries(spec.asar)) {
    mkdirSync(dirname(join(src, p)), { recursive: true });
    writeFileSync(join(src, p), content);
  }
  if (spec.nativeModule) writeBinary(join(src, spec.nativeModule.path), spec.nativeModule.strings, 'bundle');
  await createPackageWithOptions(src, join(c, 'Resources', 'app.asar'), { unpack: '*.node' });

  if (!spec.unsigned) {
    if (spec.nativeModule) sign(join(c, 'Resources', 'app.asar.unpacked', spec.nativeModule.path));
    sign(fw);
    sign(helper, { 'com.apple.security.cs.allow-jit': true }, spec.hardenedRuntime);
    if (loginItem) sign(loginItem, {}, spec.hardenedRuntime);
    sign(app, spec.entitlements, spec.hardenedRuntime);
  }
  return app;
}

export const V1: FixtureSpec = {
  version: '1.0.0',
  build: '100',
  hardenedRuntime: true,
  entitlements: { 'com.apple.security.cs.allow-jit': true },
  info: {
    NSMicrophoneUsageDescription: 'Fixture records voice notes.',
    CFBundleURLTypes: [{ CFBundleURLName: 'fixture', CFBundleURLSchemes: ['fixture'] }],
  },
  electronVersion: '33.2.0',
  mainStrings: ['https://updates.fixture-app.com/check'],
  asar: {
    'package.json': JSON.stringify({ name: 'fixture', productName: 'Fixture', version: '1.0.0', main: 'dist/main.js' }),
    'dist/main.js': 'fetch("https://api.fixture-app.com/v1/me"); const DOCS = "https://docs.fixture-app.com";',
    'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', version: '1.3.0', homepage: 'https://github.com/left-pad/left-pad' }),
    'node_modules/left-pad/index.js': 'module.exports = (s) => s;',
    'node_modules/left-pad/README.md': 'See https://readme-only-host.example-docs.com',
  },
};

export const V2: FixtureSpec = {
  version: '2.0.0',
  build: '200',
  hardenedRuntime: false,
  entitlements: { 'com.apple.security.cs.allow-jit': true, 'com.apple.security.device.camera': true },
  info: {
    NSMicrophoneUsageDescription: 'Fixture records voice notes.',
    NSCameraUsageDescription: 'Fixture can now see you.',
    CFBundleURLTypes: [{ CFBundleURLName: 'fixture', CFBundleURLSchemes: ['fixture', 'fixture-auth'] }],
  },
  electronVersion: '35.1.0',
  mainStrings: ['https://updates.fixture-app.com/check'],
  asar: {
    ...V1.asar,
    'package.json': JSON.stringify({ name: 'fixture', productName: 'Fixture', version: '2.0.0', main: 'dist/main.js' }),
    'dist/main.js': `${V1.asar['dist/main.js']} import "./ai.js";`,
    'dist/ai.js': 'navigator.sendBeacon("https://telemetry.newvendor.io/collect"); const EVENTS = "events.tracker.ai";',
    'dist/ai.js.map': '{"sources":["https://sourcemap-only.example-maps.io/x"]}',
    'node_modules/ai-plugin/package.json': JSON.stringify({ name: 'ai-plugin', version: '0.3.0' }),
    'node_modules/ai-plugin/index.js': 'module.exports = {};',
  },
  nativeModule: { path: 'node_modules/fastnative/build/Release/fastnative.node', strings: ['https://native.newvendor.io/upload'] },
  loginItem: true,
  launchAgent: true,
};

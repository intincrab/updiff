import type { PlistDict } from './plist.ts';

export const SNAPSHOT_SCHEMA = 1;

export interface SigningInfo {
  status: 'signed' | 'adhoc' | 'unsigned' | 'error';
  teamId?: string;
  identifier?: string;
  authorities: string[];
  hardenedRuntime: boolean;
  flags: string[];
  error?: string;
}

export type CodeKind =
  | 'main'
  | 'helperApp'
  | 'xpcService'
  | 'appExtension'
  | 'loginItem'
  | 'privilegedHelper'
  | 'systemExtension'
  | 'framework'
  | 'plugin'
  | 'executable'
  | 'nativeModule';

export interface CodeItem {
  kind: CodeKind;
  /** Bundle-relative path with `Versions/<x>/` normalised to `Versions/*\/`. */
  key: string;
  /** Bundle-relative path as found. */
  path: string;
  bundleId?: string;
  version?: string;
  signing?: SigningInfo;
  entitlements?: PlistDict;
}

export interface BackgroundItem {
  kind: 'launchAgent' | 'launchDaemon';
  file: string;
  label?: string;
  program?: string;
  runAtLoad?: boolean;
  keepAlive?: boolean;
}

export interface HostRecord {
  count: number;
  /** True when at least one sighting was a full URL rather than a bare string. */
  viaUrl: boolean;
  /** Up to three places it was seen, for example `Contents/Resources/app.asar:dist/main.js`. */
  where: string[];
}

export interface ElectronInfo {
  electronVersion?: string;
  /** Where the app code lives: an asar archive or a plain folder. */
  appSource?: string;
  appName?: string;
  appVersion?: string;
  /** npm packages bundled with the app: name → versions found. */
  packages: Record<string, string[]>;
  /** Files inside asar archives. */
  fileCount: number;
}

export interface InfoSummary {
  executable?: string;
  minimumSystemVersion?: string;
  urlSchemes: string[];
  privacyUsage: Record<string, string>;
  atsArbitraryLoads: boolean;
  atsExceptionDomains: string[];
  backgroundOnly: boolean;
  sparkleFeedUrl?: string;
  sparklePublicKey?: string;
  privilegedExecutables: string[];
}

export interface Snapshot {
  schema: number;
  tool: { name: string; version: string };
  takenAt: string;
  fingerprint: string;
  app: {
    path: string;
    name: string;
    bundleId: string;
    version: string;
    build: string;
    sizeBytes: number;
    fileCount: number;
  };
  info: InfoSummary;
  signing: SigningInfo;
  code: CodeItem[];
  backgroundItems: BackgroundItem[];
  electron?: ElectronInfo;
  hosts: Record<string, HostRecord>;
  stats: {
    scanMs: number;
    filesScanned: number;
    bytesScanned: number;
    deep: boolean;
    warnings: string[];
  };
}

export type Severity = 'high' | 'notable' | 'info';

export interface Finding {
  severity: Severity;
  category:
    | 'identity'
    | 'signing'
    | 'entitlement'
    | 'privacy'
    | 'urlScheme'
    | 'network'
    | 'updater'
    | 'code'
    | 'background'
    | 'electron'
    | 'package'
    | 'host';
  change: 'added' | 'removed' | 'changed';
  title: string;
  detail?: string;
  /** Where it was found: a bundle path, an archive path, a key. */
  where?: string[];
}

export interface DiffReport {
  app: { name: string; bundleId: string };
  from: { version: string; build: string; takenAt: string; path: string };
  to: { version: string; build: string; takenAt: string; path: string };
  findings: Finding[];
  counts: Record<Severity, number>;
  identical: boolean;
}

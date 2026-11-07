import { registrableDomain } from './hosts.ts';
import type { PlistDict, PlistValue } from './plist.ts';
import type { BackgroundItem, CodeItem, CodeKind, DiffReport, Finding, HostRecord, Severity, Snapshot } from './types.ts';
import { formatBytes, stableJson } from './util.ts';

/** Entitlements that change what the app can reach or how safely it runs. */
const SENSITIVE_ENTITLEMENTS: Record<string, string> = {
  'com.apple.security.device.camera': 'use the camera',
  'com.apple.security.device.audio-input': 'record from the microphone',
  'com.apple.security.device.microphone': 'record from the microphone',
  'com.apple.security.device.usb': 'talk to USB devices',
  'com.apple.security.device.bluetooth': 'use Bluetooth',
  'com.apple.security.personal-information.location': 'read your location',
  'com.apple.security.personal-information.addressbook': 'read your contacts',
  'com.apple.security.personal-information.calendars': 'read your calendars',
  'com.apple.security.personal-information.photos-library': 'read your photo library',
  'com.apple.security.automation.apple-events': 'control other apps through Apple Events',
  'com.apple.security.cs.disable-library-validation': 'load code signed by other developers',
  'com.apple.security.cs.allow-dyld-environment-variables': 'be injected with libraries through environment variables',
  'com.apple.security.cs.allow-unsigned-executable-memory': 'run unsigned executable memory',
  'com.apple.security.cs.disable-executable-page-protection': 'turn off executable page protection',
  'com.apple.security.cs.debugger': 'debug other processes',
  'com.apple.security.get-task-allow': 'be debugged and inspected by other processes',
  'com.apple.developer.endpoint-security.client': 'watch system-wide process and file activity (Endpoint Security)',
  'com.apple.developer.system-extension.install': 'install system extensions',
  'com.apple.developer.networking.networkextension': 'filter, proxy or route network traffic (Network Extension)',
  'com.apple.developer.networking.vpn.api': 'configure VPNs',
  'com.apple.security.cs.allow-jit': 'generate code at runtime (JIT)',
};
/** Entitlements that are common and low-risk enough to stay "notable" when added. */
const MILD_ENTITLEMENTS = new Set(['com.apple.security.cs.allow-jit']);

const PRIVACY_NAMES: Record<string, string> = {
  NSCameraUsageDescription: 'Camera',
  NSMicrophoneUsageDescription: 'Microphone',
  NSAudioCaptureUsageDescription: 'System audio recording',
  NSContactsUsageDescription: 'Contacts',
  NSCalendarsUsageDescription: 'Calendars',
  NSCalendarsFullAccessUsageDescription: 'Calendars (full access)',
  NSCalendarsWriteOnlyAccessUsageDescription: 'Calendars (add events)',
  NSRemindersUsageDescription: 'Reminders',
  NSRemindersFullAccessUsageDescription: 'Reminders (full access)',
  NSPhotoLibraryUsageDescription: 'Photos',
  NSPhotoLibraryAddUsageDescription: 'Photos (add only)',
  NSLocationUsageDescription: 'Location',
  NSLocationWhenInUseUsageDescription: 'Location',
  NSLocationAlwaysUsageDescription: 'Location (always)',
  NSLocationAlwaysAndWhenInUseUsageDescription: 'Location (always)',
  NSAppleEventsUsageDescription: 'Control other apps (Apple Events)',
  NSBluetoothAlwaysUsageDescription: 'Bluetooth',
  NSBluetoothPeripheralUsageDescription: 'Bluetooth',
  NSLocalNetworkUsageDescription: 'Devices on your local network',
  NSSpeechRecognitionUsageDescription: 'Speech recognition',
  NSDesktopFolderUsageDescription: 'Desktop folder',
  NSDocumentsFolderUsageDescription: 'Documents folder',
  NSDownloadsFolderUsageDescription: 'Downloads folder',
  NSRemovableVolumesUsageDescription: 'Removable drives',
  NSNetworkVolumesUsageDescription: 'Network drives',
  NSFileProviderDomainUsageDescription: 'Cloud file providers',
  NSSystemAdministrationUsageDescription: 'Administrator actions',
  NSMotionUsageDescription: 'Motion data',
  NSHomeKitUsageDescription: 'HomeKit',
  NSFocusStatusUsageDescription: 'Focus status',
  NSFaceIDUsageDescription: 'Face ID',
  NSIdentityUsageDescription: 'Identity documents',
};

const KIND_LABEL: Record<CodeKind, string> = {
  main: 'main executable',
  helperApp: 'helper app',
  xpcService: 'XPC service',
  appExtension: 'app extension',
  loginItem: 'login item',
  privilegedHelper: 'privileged helper (runs as root)',
  systemExtension: 'system extension',
  framework: 'framework',
  plugin: 'plug-in bundle',
  executable: 'executable',
  nativeModule: 'native Node module',
};

const HIGH_RISK_KINDS = new Set<CodeKind>(['loginItem', 'privilegedHelper', 'systemExtension']);

function privacyName(key: string): string {
  return PRIVACY_NAMES[key] ?? key.replace(/^NS/, '').replace(/UsageDescription$/, '');
}

/** "Helper app Foo Helper.app", for the start of a finding title. */
function subjectOf(item: CodeItem): string {
  const label = KIND_LABEL[item.kind];
  return `${label[0]!.toUpperCase()}${label.slice(1)} ${shortName(item.path)}`;
}

function show(v: PlistValue | undefined): string {
  if (v === undefined) return '(none)';
  if (typeof v === 'string') return v;
  return stableJson(v);
}

function entitlementSeverity(key: string): Severity {
  if (key.startsWith('com.apple.security.temporary-exception.')) return 'high';
  if (MILD_ENTITLEMENTS.has(key)) return 'notable';
  return key in SENSITIVE_ENTITLEMENTS ? 'high' : 'notable';
}

function entitlementTitle(key: string, item: CodeItem): string {
  const what = SENSITIVE_ENTITLEMENTS[key];
  const subject = item.kind === 'main' ? 'App' : subjectOf(item);
  return what ? `${subject} can now ${what}` : `${subject} gained entitlement ${key}`;
}

function shortName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isEnabled(v: PlistValue | undefined): boolean {
  return v !== undefined && v !== false && v !== 0 && !(Array.isArray(v) && v.length === 0);
}

function diffEntitlements(a: PlistDict, b: PlistDict, item: CodeItem, out: Finding[]): void {
  const where = [item.path];
  for (const key of Object.keys(b)) {
    const before = a[key];
    const after = b[key]!;
    if (stableJson(before) === stableJson(after)) continue;
    if (!isEnabled(before) && isEnabled(after)) {
      out.push({
        severity: entitlementSeverity(key),
        category: 'entitlement',
        change: 'added',
        title: entitlementTitle(key, item),
        detail: `${key} = ${show(after)}`,
        where,
      });
    } else if (Array.isArray(before) && Array.isArray(after)) {
      const beforeSet = new Set(before.map(stableJson));
      const afterSet = new Set(after.map(stableJson));
      const added = after.filter((x) => !beforeSet.has(stableJson(x)));
      const removed = before.filter((x) => !afterSet.has(stableJson(x)));
      if (added.length) {
        out.push({
          severity: key.startsWith('com.apple.security.temporary-exception.') ? 'high' : 'notable',
          category: 'entitlement',
          change: 'changed',
          title: `${key} gained ${added.length} value${added.length === 1 ? '' : 's'}`,
          detail: added.map(show).join(', '),
          where,
        });
      }
      if (removed.length) {
        out.push({
          severity: 'info',
          category: 'entitlement',
          change: 'changed',
          title: `${key} lost ${removed.length} value${removed.length === 1 ? '' : 's'}`,
          detail: removed.map(show).join(', '),
          where,
        });
      }
    } else if (isEnabled(before) && !isEnabled(after)) {
      if (key === 'com.apple.security.app-sandbox') out.push(sandboxRemoved(item, 'changed'));
      else out.push({ severity: 'info', category: 'entitlement', change: 'removed', title: `Entitlement ${key} turned off`, where });
    } else {
      out.push({
        severity: 'notable',
        category: 'entitlement',
        change: 'changed',
        title: `Entitlement ${key} changed`,
        detail: `${show(before)} → ${show(after)}`,
        where,
      });
    }
  }
  for (const key of Object.keys(a)) {
    if (key in b) continue;
    if (key === 'com.apple.security.app-sandbox' && isEnabled(a[key])) out.push(sandboxRemoved(item, 'removed'));
    else out.push({ severity: 'info', category: 'entitlement', change: 'removed', title: `Entitlement ${key} removed`, where });
  }
}

function sandboxRemoved(item: CodeItem, change: Finding['change']): Finding {
  return {
    severity: 'high',
    category: 'entitlement',
    change,
    title: item.kind === 'main' ? 'App is no longer sandboxed' : `${subjectOf(item)} is no longer sandboxed`,
    where: [item.path],
  };
}

function diffSigning(a: CodeItem, b: CodeItem, out: Finding[]): void {
  const sa = a.signing;
  const sb = b.signing;
  if (!sa || !sb) return;
  const subject = b.kind === 'main' ? 'App' : subjectOf(b);
  const where = [b.path];
  const trusted = (s: typeof sa): boolean => s.status === 'signed';
  if (trusted(sa) && !trusted(sb)) {
    out.push({ severity: 'high', category: 'signing', change: 'changed', title: `${subject} is no longer signed by a developer`, detail: `signature: ${sa.status} → ${sb.status}`, where });
  } else if (sa.status !== sb.status) {
    out.push({ severity: 'info', category: 'signing', change: 'changed', title: `${subject} signature changed`, detail: `${sa.status} → ${sb.status}`, where });
  }
  if (sa.teamId && sb.teamId && sa.teamId !== sb.teamId) {
    out.push({
      severity: 'high',
      category: 'signing',
      change: 'changed',
      title: `${subject} is signed by a different developer team`,
      detail: `${sa.teamId} → ${sb.teamId}${sb.authorities[0] ? ` (${sb.authorities[0]})` : ''}`,
      where,
    });
  } else if ((sa.authorities[0] ?? '') !== (sb.authorities[0] ?? '') && sa.authorities[0] && sb.authorities[0]) {
    out.push({ severity: 'notable', category: 'signing', change: 'changed', title: `${subject} signing certificate changed`, detail: `${sa.authorities[0]} → ${sb.authorities[0]}`, where });
  }
  if (sa.hardenedRuntime && !sb.hardenedRuntime) {
    out.push({ severity: 'high', category: 'signing', change: 'removed', title: `${subject} dropped the hardened runtime`, where });
  } else if (!sa.hardenedRuntime && sb.hardenedRuntime) {
    out.push({ severity: 'info', category: 'signing', change: 'added', title: `${subject} enabled the hardened runtime`, where });
  }
}

function matchCode(a: CodeItem[], b: CodeItem[]): { pairs: Array<[CodeItem, CodeItem]>; added: CodeItem[]; removed: CodeItem[] } {
  const byKeyA = new Map(a.map((c) => [`${c.kind}|${c.key}`, c]));
  const pairs: Array<[CodeItem, CodeItem]> = [];
  const unmatchedB: CodeItem[] = [];
  const usedA = new Set<CodeItem>();
  for (const c of b) {
    const m = byKeyA.get(`${c.kind}|${c.key}`) ?? (c.kind === 'main' ? a.find((x) => x.kind === 'main') : undefined);
    if (m && !usedA.has(m)) {
      pairs.push([m, c]);
      usedA.add(m);
    } else unmatchedB.push(c);
  }
  // A renamed bundle keeps its bundle identifier.
  const added: CodeItem[] = [];
  for (const c of unmatchedB) {
    const m = c.bundleId ? a.find((x) => !usedA.has(x) && x.kind === c.kind && x.bundleId === c.bundleId) : undefined;
    if (m) {
      pairs.push([m, c]);
      usedA.add(m);
    } else added.push(c);
  }
  return { pairs, added, removed: a.filter((x) => !usedA.has(x)) };
}

function describeCode(c: CodeItem): string {
  const parts: string[] = [];
  if (c.bundleId) parts.push(c.bundleId);
  if (c.version) parts.push(`v${c.version}`);
  if (c.signing?.teamId) parts.push(`team ${c.signing.teamId}`);
  const ents = Object.keys(c.entitlements ?? {});
  if (ents.length) parts.push(`entitlements: ${ents.join(', ')}`);
  return parts.join(' · ');
}

function diffCode(a: Snapshot, b: Snapshot, out: Finding[]): void {
  const { pairs, added, removed } = matchCode(a.code, b.code);
  const mainTeam = b.signing.teamId;
  for (const [ca, cb] of pairs) {
    diffSigning(ca, cb, out);
    if (ca.entitlements || cb.entitlements) diffEntitlements(ca.entitlements ?? {}, cb.entitlements ?? {}, cb, out);
    if (cb.kind === 'framework' && ca.version !== cb.version && cb.version) {
      const isElectron = cb.path.endsWith('/Electron Framework.framework');
      out.push({
        severity: isElectron ? 'notable' : 'info',
        category: isElectron ? 'electron' : 'code',
        change: 'changed',
        title: isElectron ? `Electron ${ca.version ?? '?'} → ${cb.version}` : `${shortName(cb.path)} ${ca.version ?? '?'} → ${cb.version}`,
        where: [cb.path],
      });
    }
  }
  for (const c of added) {
    out.push({
      severity: HIGH_RISK_KINDS.has(c.kind) ? 'high' : 'notable',
      category: 'code',
      change: 'added',
      title: `New ${KIND_LABEL[c.kind]}: ${shortName(c.path)}`,
      detail: describeCode(c) || undefined,
      where: [c.path],
    });
    if (c.signing?.teamId && mainTeam && c.signing.teamId !== mainTeam) {
      out.push({
        severity: 'high',
        category: 'signing',
        change: 'added',
        title: `New ${KIND_LABEL[c.kind]} ${shortName(c.path)} is signed by another developer team`,
        detail: `${c.signing.teamId}${c.signing.authorities[0] ? ` (${c.signing.authorities[0]})` : ''}; the app is ${mainTeam}`,
        where: [c.path],
      });
    }
    for (const [key, value] of Object.entries(c.entitlements ?? {})) {
      if (entitlementSeverity(key) !== 'high' || !isEnabled(value)) continue;
      out.push({ severity: 'high', category: 'entitlement', change: 'added', title: entitlementTitle(key, c), detail: `${key} = ${show(value)}`, where: [c.path] });
    }
  }
  for (const c of removed) {
    out.push({ severity: 'info', category: 'code', change: 'removed', title: `Removed ${KIND_LABEL[c.kind]}: ${shortName(c.path)}`, where: [c.path] });
  }
}

function describeBackground(i: BackgroundItem): string {
  const parts = [i.label ? `label ${i.label}` : undefined, i.program ? `runs ${i.program}` : undefined];
  if (i.runAtLoad) parts.push('starts at login');
  if (i.keepAlive) parts.push('kept alive');
  return parts.filter(Boolean).join(' · ');
}

function diffBackground(a: BackgroundItem[], b: BackgroundItem[], out: Finding[]): void {
  const byFile = new Map(a.map((i) => [i.file, i]));
  for (const i of b) {
    const prev = byFile.get(i.file);
    const kind = i.kind === 'launchAgent' ? 'background agent' : 'background daemon (runs as root)';
    if (!prev) {
      out.push({ severity: 'high', category: 'background', change: 'added', title: `New ${kind}: ${shortName(i.file)}`, detail: describeBackground(i), where: [i.file] });
      continue;
    }
    byFile.delete(i.file);
    if (stableJson(prev) !== stableJson(i)) {
      out.push({
        severity: 'notable',
        category: 'background',
        change: 'changed',
        title: `${shortName(i.file)} changed`,
        detail: `${describeBackground(prev)} → ${describeBackground(i)}`,
        where: [i.file],
      });
    }
  }
  for (const i of byFile.values()) {
    out.push({ severity: 'info', category: 'background', change: 'removed', title: `Removed background item ${shortName(i.file)}`, where: [i.file] });
  }
}

function diffInfo(a: Snapshot, b: Snapshot, out: Finding[]): void {
  const ia = a.info;
  const ib = b.info;
  for (const [key, text] of Object.entries(ib.privacyUsage)) {
    if (!(key in ia.privacyUsage)) {
      out.push({ severity: 'high', category: 'privacy', change: 'added', title: `Can now ask for access to ${privacyName(key)}`, detail: `${key}: “${text}”`, where: ['Contents/Info.plist'] });
    } else if (ia.privacyUsage[key] !== text) {
      out.push({ severity: 'info', category: 'privacy', change: 'changed', title: `Explanation for ${privacyName(key)} access changed`, detail: `“${ia.privacyUsage[key]}” → “${text}”`, where: ['Contents/Info.plist'] });
    }
  }
  for (const key of Object.keys(ia.privacyUsage)) {
    if (!(key in ib.privacyUsage)) out.push({ severity: 'info', category: 'privacy', change: 'removed', title: `No longer asks for ${privacyName(key)}`, where: ['Contents/Info.plist'] });
  }

  const addedSchemes = ib.urlSchemes.filter((s) => !ia.urlSchemes.includes(s));
  const removedSchemes = ia.urlSchemes.filter((s) => !ib.urlSchemes.includes(s));
  for (const s of addedSchemes) out.push({ severity: 'notable', category: 'urlScheme', change: 'added', title: `Opens ${s}:// links`, detail: 'Web pages and other apps can launch it with this URL scheme.', where: ['Contents/Info.plist'] });
  if (removedSchemes.length) out.push({ severity: 'info', category: 'urlScheme', change: 'removed', title: `Stopped handling ${removedSchemes.map((s) => `${s}://`).join(', ')}`, where: ['Contents/Info.plist'] });

  if (!ia.atsArbitraryLoads && ib.atsArbitraryLoads) {
    out.push({ severity: 'high', category: 'network', change: 'added', title: 'Allows unencrypted HTTP connections (App Transport Security relaxed)', where: ['Contents/Info.plist'] });
  } else if (ia.atsArbitraryLoads && !ib.atsArbitraryLoads) {
    out.push({ severity: 'info', category: 'network', change: 'removed', title: 'No longer allows arbitrary HTTP connections', where: ['Contents/Info.plist'] });
  }
  const newExceptions = ib.atsExceptionDomains.filter((d) => !ia.atsExceptionDomains.includes(d));
  if (newExceptions.length) out.push({ severity: 'notable', category: 'network', change: 'added', title: `New App Transport Security exceptions`, detail: newExceptions.join(', '), where: ['Contents/Info.plist'] });

  if (ia.backgroundOnly !== ib.backgroundOnly) {
    out.push({ severity: 'notable', category: 'identity', change: 'changed', title: ib.backgroundOnly ? 'Now runs without a Dock icon (agent app)' : 'Now shows a Dock icon', where: ['Contents/Info.plist'] });
  }

  if (ia.sparkleFeedUrl && ib.sparkleFeedUrl && ia.sparkleFeedUrl !== ib.sparkleFeedUrl) {
    out.push({ severity: 'high', category: 'updater', change: 'changed', title: 'Update feed moved', detail: `${ia.sparkleFeedUrl} → ${ib.sparkleFeedUrl}`, where: ['Contents/Info.plist'] });
  } else if (!ia.sparkleFeedUrl && ib.sparkleFeedUrl) {
    out.push({ severity: 'notable', category: 'updater', change: 'added', title: 'Added a Sparkle update feed', detail: ib.sparkleFeedUrl, where: ['Contents/Info.plist'] });
  } else if (ia.sparkleFeedUrl && !ib.sparkleFeedUrl) {
    out.push({ severity: 'notable', category: 'updater', change: 'removed', title: 'Removed its Sparkle update feed', detail: ia.sparkleFeedUrl, where: ['Contents/Info.plist'] });
  }
  if (ia.sparklePublicKey && ia.sparklePublicKey !== ib.sparklePublicKey) {
    out.push({
      severity: 'high',
      category: 'updater',
      change: ib.sparklePublicKey ? 'changed' : 'removed',
      title: ib.sparklePublicKey ? 'Update signing key changed' : 'Update signing key removed',
      detail: 'Future updates are verified against a different key. Confirm this with the developer.',
      where: ['Contents/Info.plist'],
    });
  }

  for (const p of ib.privilegedExecutables.filter((x) => !ia.privilegedExecutables.includes(x))) {
    out.push({ severity: 'high', category: 'background', change: 'added', title: `Declares a new privileged helper: ${p}`, detail: 'Helpers installed this way run as root.', where: ['Contents/Info.plist'] });
  }
  if (ia.minimumSystemVersion !== ib.minimumSystemVersion && ib.minimumSystemVersion) {
    out.push({ severity: 'info', category: 'identity', change: 'changed', title: `Minimum macOS ${ia.minimumSystemVersion ?? '?'} → ${ib.minimumSystemVersion}`, where: ['Contents/Info.plist'] });
  }
}

/** Apple has vouched for it: notarized, or distributed by Apple (App Store, system). */
const isApproved = (source: string | undefined): boolean => /notarized|mac app store|apple system/i.test(source ?? '');

function diffNotarization(a: Snapshot, b: Snapshot, out: Finding[]): void {
  const na = a.notarization;
  const nb = b.notarization;
  // Older snapshots (and scans with notarization off) have nothing to compare.
  if (!na || !nb) return;
  const where = [b.app.path];
  if (na.assessment === 'accepted' && nb.assessment === 'rejected') {
    out.push({
      severity: 'high',
      category: 'signing',
      change: 'changed',
      title: 'Gatekeeper now rejects the app',
      detail: `${na.source ?? 'accepted'} → rejected`,
      where,
    });
  } else if (isApproved(na.source) && !isApproved(nb.source) && nb.assessment !== 'unknown') {
    out.push({
      severity: 'high',
      category: 'signing',
      change: 'removed',
      title: 'No longer notarized by Apple',
      detail: `${na.source} → ${nb.source ?? nb.assessment}`,
      where,
    });
  } else if (na.source && nb.source && na.source !== nb.source) {
    out.push({ severity: 'notable', category: 'signing', change: 'changed', title: 'Distribution changed', detail: `${na.source} → ${nb.source}`, where });
  }
  if (na.stapled === true && nb.stapled === false) {
    out.push({
      severity: 'info',
      category: 'signing',
      change: 'removed',
      title: 'Notarization ticket no longer stapled',
      detail: 'Gatekeeper checks it online instead; first launch offline may fail.',
      where,
    });
  } else if (na.stapled === false && nb.stapled === true) {
    out.push({ severity: 'info', category: 'signing', change: 'added', title: 'Notarization ticket now stapled', where });
  }
}

function diffSparkleCode(a: Snapshot, b: Snapshot, out: Finding[]): void {
  const fa = a.info.sparkleFeedsInCode ?? [];
  const fb = b.info.sparkleFeedsInCode ?? [];
  const added = fb.filter((u) => !fa.includes(u));
  const removed = fa.filter((u) => !fb.includes(u));
  if (added.length && fa.length) {
    out.push({
      severity: 'notable',
      category: 'updater',
      change: 'changed',
      title: 'Update feed in the code changed',
      detail: `${removed.length ? `${removed.join(', ')} → ` : ''}${added.join(', ')}`,
      where: [b.app.path],
    });
  } else if (added.length) {
    out.push({ severity: 'notable', category: 'updater', change: 'added', title: 'Update feed set in the code', detail: added.join(', '), where: [b.app.path] });
  } else if (removed.length) {
    out.push({ severity: 'info', category: 'updater', change: 'removed', title: 'Update feed no longer in the code', detail: removed.join(', '), where: [b.app.path] });
  }
}

function diffElectron(a: Snapshot, b: Snapshot, out: Finding[]): void {
  const pa = a.electron?.packages ?? {};
  const pb = b.electron?.packages ?? {};
  const added = Object.keys(pb).filter((n) => !(n in pa)).sort();
  const removed = Object.keys(pa).filter((n) => !(n in pb)).sort();
  const bumped = Object.keys(pb).filter((n) => n in pa && stableJson(pa[n]) !== stableJson(pb[n])).sort();
  const fmt = (n: string, p: Record<string, string[]>): string => `${n}@${(p[n] ?? []).join('|')}`;
  if (added.length) {
    out.push({
      severity: 'notable',
      category: 'package',
      change: 'added',
      title: `${added.length} new bundled npm package${added.length === 1 ? '' : 's'}`,
      detail: added.map((n) => fmt(n, pb)).join(', '),
      where: b.electron?.appSource ? [b.electron.appSource] : undefined,
    });
  }
  if (removed.length) {
    out.push({ severity: 'info', category: 'package', change: 'removed', title: `${removed.length} bundled npm package${removed.length === 1 ? '' : 's'} removed`, detail: removed.join(', ') });
  }
  if (bumped.length) {
    out.push({
      severity: 'info',
      category: 'package',
      change: 'changed',
      title: `${bumped.length} bundled npm package${bumped.length === 1 ? '' : 's'} changed version`,
      detail: bumped.map((n) => `${n} ${(pa[n] ?? []).join('|')} → ${(pb[n] ?? []).join('|')}`).join(', '),
    });
  }
  if (!a.electron && b.electron) {
    out.push({ severity: 'notable', category: 'electron', change: 'added', title: 'Now built with Electron', detail: b.electron.electronVersion ? `Electron ${b.electron.electronVersion}` : undefined });
  }
}

function groupByDomain(hosts: Record<string, HostRecord>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const h of Object.keys(hosts)) {
    const d = registrableDomain(h);
    const list = out.get(d);
    if (list) list.push(h);
    else out.set(d, [h]);
  }
  return out;
}

function diffHosts(a: Snapshot, b: Snapshot, out: Finding[]): void {
  const domainsA = groupByDomain(a.hosts);
  const domainsB = groupByDomain(b.hosts);
  for (const [domain, hosts] of [...domainsB].sort(([x], [y]) => x.localeCompare(y))) {
    const before = domainsA.get(domain);
    if (!before) {
      const viaUrl = hosts.some((h) => b.hosts[h]!.viaUrl);
      const where = [...new Set(hosts.flatMap((h) => b.hosts[h]!.where))].slice(0, 3);
      out.push({
        severity: 'notable',
        category: 'host',
        change: 'added',
        title: `New domain ${domain}`,
        detail: `${hosts.sort().join(', ')}${viaUrl ? '' : ' (seen only as a bare string, not in a URL)'}`,
        where,
      });
      continue;
    }
    const newHosts = hosts.filter((h) => !before.includes(h)).sort();
    if (newHosts.length) {
      out.push({
        severity: 'info',
        category: 'host',
        change: 'added',
        title: `New host${newHosts.length === 1 ? '' : 's'} under ${domain}`,
        detail: newHosts.join(', '),
        where: [...new Set(newHosts.flatMap((h) => b.hosts[h]!.where))].slice(0, 3),
      });
    }
  }
  const gone = [...domainsA.keys()].filter((d) => !domainsB.has(d)).sort();
  if (gone.length) {
    out.push({ severity: 'info', category: 'host', change: 'removed', title: `${gone.length} domain${gone.length === 1 ? '' : 's'} no longer mentioned`, detail: gone.join(', ') });
  }
}

export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, notable: 1, info: 2 };
export const CATEGORY_ORDER: Finding['category'][] = [
  'signing', 'privacy', 'permission', 'entitlement', 'background', 'script', 'install', 'updater', 'network', 'code', 'urlScheme', 'electron', 'package', 'host', 'identity',
];

export function diffSnapshots(a: Snapshot, b: Snapshot): DiffReport {
  const findings: Finding[] = [];
  if (a.app.bundleId !== b.app.bundleId) {
    findings.push({ severity: 'high', category: 'identity', change: 'changed', title: 'These are different apps', detail: `${a.app.bundleId} → ${b.app.bundleId}` });
  }
  diffInfo(a, b, findings);
  diffCode(a, b, findings);
  diffBackground(a.backgroundItems, b.backgroundItems, findings);
  diffElectron(a, b, findings);
  diffNotarization(a, b, findings);
  diffSparkleCode(a, b, findings);
  if (!a.info.appStoreReceipt !== !b.info.appStoreReceipt) {
    findings.push({
      severity: 'notable',
      category: 'identity',
      change: b.info.appStoreReceipt ? 'added' : 'removed',
      title: b.info.appStoreReceipt ? 'Now distributed through the Mac App Store' : 'No longer a Mac App Store build',
    });
  }
  diffHosts(a, b, findings);

  const substantive = findings.length;
  if (a.app.version !== b.app.version || a.app.build !== b.app.build) {
    findings.push({ severity: 'info', category: 'identity', change: 'changed', title: `Version ${a.app.version} (${a.app.build}) → ${b.app.version} (${b.app.build})` });
  }
  if (a.app.sizeBytes !== b.app.sizeBytes) {
    const delta = b.app.sizeBytes - a.app.sizeBytes;
    const pct = a.app.sizeBytes ? ((delta / a.app.sizeBytes) * 100).toFixed(1) : '∞';
    findings.push({ severity: 'info', category: 'identity', change: 'changed', title: `Size ${delta >= 0 ? '+' : ''}${formatBytes(delta)} (${delta >= 0 ? '+' : ''}${pct}%), files ${a.app.fileCount} → ${b.app.fileCount}` });
  }

  findings.sort(
    (x, y) =>
      SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] ||
      CATEGORY_ORDER.indexOf(x.category) - CATEGORY_ORDER.indexOf(y.category) ||
      x.title.localeCompare(y.title),
  );
  const counts: Record<Severity, number> = { high: 0, notable: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const notes: string[] = [];
  const encrypted = [...new Set([...(a.encryptedBinaries ?? []), ...(b.encryptedBinaries ?? [])])];
  if (encrypted.length) {
    notes.push(`Encrypted binaries (an iPhone or iPad app) can't be searched for hostnames: ${encrypted.slice(0, 3).join(', ')}${encrypted.length > 3 ? '…' : ''}.`);
  }
  if (!a.notarization !== !b.notarization) notes.push('Notarization was only checked on one side, so it was not compared.');
  return {
    app: { name: b.app.name, bundleId: b.app.bundleId },
    from: { version: a.app.version, build: a.app.build, takenAt: a.takenAt, path: a.app.path },
    to: { version: b.app.version, build: b.app.build, takenAt: b.takenAt, path: b.app.path },
    findings,
    counts,
    identical: substantive === 0 && a.fingerprint === b.fingerprint,
    ...(notes.length ? { notes } : {}),
  };
}

export function filterBySeverity(report: DiffReport, min: Severity): DiffReport {
  const findings = report.findings.filter((f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[min]);
  const counts: Record<Severity, number> = { high: 0, notable: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { ...report, findings, counts };
}

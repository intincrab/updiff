import { run } from './exec.ts';
import { isDict, parsePlistXml, type PlistDict } from './plist.ts';
import type { NotarizationInfo, SigningInfo } from './types.ts';

/** Parses the stderr of `codesign -dvvv`. Exported for tests. */
export function parseCodesignDetails(stderr: string, code: number): SigningInfo {
  if (/not signed at all/i.test(stderr)) {
    return { status: 'unsigned', authorities: [], hardenedRuntime: false, flags: [] };
  }
  if (code !== 0 && !/^Identifier=/m.test(stderr)) {
    return { status: 'error', authorities: [], hardenedRuntime: false, flags: [], error: stderr.trim().split('\n').pop() };
  }
  const authorities: string[] = [];
  let teamId: string | undefined;
  let identifier: string | undefined;
  let flags: string[] = [];
  let adhoc = false;
  for (const line of stderr.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'Authority') authorities.push(value);
    else if (key === 'TeamIdentifier') teamId = value === 'not set' ? undefined : value;
    else if (key === 'Identifier') identifier = value;
    else if (key === 'Signature' && value === 'adhoc') adhoc = true;
    else if (key === 'CodeDirectory v') {
      // CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=...
      const m = /flags=0x[0-9a-f]+\(([^)]*)\)/i.exec(line);
      if (m?.[1]) flags = m[1].split(',').map((s) => s.trim()).filter((s) => s && s !== 'none');
    }
  }
  return {
    status: adhoc ? 'adhoc' : 'signed',
    teamId,
    identifier,
    authorities,
    hardenedRuntime: flags.includes('runtime'),
    flags,
  };
}

export async function readSigning(path: string): Promise<SigningInfo> {
  const res = await run('/usr/bin/codesign', ['-dvvv', path]);
  return parseCodesignDetails(res.stderr, res.code);
}

export async function readEntitlements(path: string): Promise<PlistDict> {
  const res = await run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', path]);
  const xml = res.stdout.trim();
  if (res.code !== 0 || !xml.startsWith('<')) return {};
  try {
    const value = parsePlistXml(xml);
    return isDict(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Parses `spctl -a -vvv -t exec` output:
 *   /Applications/X.app: accepted
 *   source=Notarized Developer ID
 *   origin=Developer ID Application: Example Inc (TEAMID)
 */
export function parseSpctl(output: string): Pick<NotarizationInfo, 'assessment' | 'source' | 'origin' | 'error'> {
  const verdict = /:\s*(accepted|rejected)\s*$/m.exec(output)?.[1];
  const source = /^source=(.+)$/m.exec(output)?.[1]?.trim();
  const origin = /^origin=(.+)$/m.exec(output)?.[1]?.trim();
  const assessment = verdict === 'accepted' || verdict === 'rejected' ? verdict : 'unknown';
  // Without a verdict spctl prints "<path>: <reason>", e.g. a broken seal.
  const error = assessment === 'unknown' ? /^.*?:\s*(.+)$/m.exec(output.trim())?.[1]?.trim() : undefined;
  return {
    assessment,
    ...(source ? { source } : {}),
    ...(origin ? { origin } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Reads `stapler validate` by its message: its exit status is 0 whether or not a
 * ticket is stapled. Undefined when stapler isn't available (no Xcode tools).
 */
export function parseStapler(res: { stdout: string; stderr: string }): boolean | undefined {
  const text = `${res.stdout}\n${res.stderr}`;
  if (/The validate action worked/i.test(text)) return true;
  if (/does not have a ticket stapled/i.test(text)) return false;
  return undefined;
}

/** Asks Gatekeeper about a bundle and checks for a stapled notarization ticket. */
export async function readNotarization(path: string): Promise<NotarizationInfo> {
  const spctl = await run('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'exec', path], 120_000);
  const info: NotarizationInfo = parseSpctl(`${spctl.stdout}\n${spctl.stderr}`);
  const stapled = parseStapler((await run('/usr/bin/xcrun', ['stapler', 'validate', path], 60_000)));
  if (stapled !== undefined) info.stapled = stapled;
  return info;
}

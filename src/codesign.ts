import { run } from './exec.ts';
import { isDict, parsePlistXml, type PlistDict } from './plist.ts';
import type { SigningInfo } from './types.ts';

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

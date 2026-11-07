import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCodesignDetails } from '../src/codesign.ts';

test('parses a Developer ID signature with hardened runtime', () => {
  const stderr = `Executable=/Applications/Ghostty.app/Contents/MacOS/ghostty
Identifier=com.mitchellh.ghostty
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=12345 flags=0x10000(runtime) hashes=375+7 location=embedded
Signature size=9000
Authority=Developer ID Application: Mitchell Hashimoto (24VZTF6M5V)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Sep 23, 2026 at 10:00:00
TeamIdentifier=24VZTF6M5V
Runtime Version=15.0.0
`;
  assert.deepEqual(parseCodesignDetails(stderr, 0), {
    status: 'signed',
    teamId: '24VZTF6M5V',
    identifier: 'com.mitchellh.ghostty',
    authorities: ['Developer ID Application: Mitchell Hashimoto (24VZTF6M5V)', 'Developer ID Certification Authority', 'Apple Root CA'],
    hardenedRuntime: true,
    flags: ['runtime'],
  });
});

test('parses an ad-hoc signature', () => {
  const stderr = `Executable=/tmp/x
Identifier=x
CodeDirectory v=20400 size=331 flags=0x2(adhoc) hashes=4+2 location=embedded
Signature=adhoc
TeamIdentifier=not set
`;
  const info = parseCodesignDetails(stderr, 0);
  assert.equal(info.status, 'adhoc');
  assert.equal(info.teamId, undefined);
  assert.equal(info.hardenedRuntime, false);
  assert.deepEqual(info.flags, ['adhoc']);
});

test('recognises unsigned code and errors', () => {
  assert.equal(parseCodesignDetails('/tmp/x: code object is not signed at all\n', 1).status, 'unsigned');
  const err = parseCodesignDetails('/tmp/x: No such file or directory\n', 1);
  assert.equal(err.status, 'error');
  assert.equal(err.error, '/tmp/x: No such file or directory');
});

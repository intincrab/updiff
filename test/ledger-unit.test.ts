import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCask, urlForVersion } from '../ledger/src/cask.ts';
import { detectContainer } from '../ledger/src/fetch-app.ts';
import { esc, safeHref } from '../ledger/src/site.ts';

const SLACK = {
  token: 'slack',
  name: ['Slack'],
  desc: 'Team communication and collaboration software',
  homepage: 'https://slack.com/',
  version: '4.53.280',
  url: 'https://downloads.slack-edge.com/desktop-releases/mac/arm64/4.53.280/Slack-4.53.280-macOS.dmg',
  sha256: 'C8A329A745' + '0'.repeat(54),
  artifacts: [{ uninstall: [{ quit: 'com.tinyspeck.slackmacgap' }] }, { app: [['Slack.app']] }, { zap: [{ trash: [] }] }],
};

test('parses a cask document', () => {
  const c = parseCask(SLACK);
  assert.equal(c.token, 'slack');
  assert.equal(c.name, 'Slack');
  assert.equal(c.version, '4.53.280');
  assert.equal(c.sha256, 'c8a329a745' + '0'.repeat(54));
  assert.deepEqual(c.appNames, ['Slack.app']);
  assert.deepEqual(c.pkgNames, []);
});

test('handles packages, targets and unpinned checksums', () => {
  const zoom = parseCask({
    token: 'zoom',
    name: ['Zoom'],
    version: '7.2.5.90525',
    url: 'https://cdn.zoom.us/prod/7.2.5.90525/arm64/zoomusInstallerFull.pkg',
    sha256: 'no_check',
    artifacts: [{ pkg: [['zoomusInstallerFull.pkg']] }, { app: [['Foo.app', { target: 'Bar.app' }]] }],
  });
  assert.equal(zoom.sha256, null);
  assert.deepEqual(zoom.pkgNames, ['zoomusInstallerFull.pkg']);
  assert.deepEqual(zoom.appNames, ['Foo.app']);
  assert.throws(() => parseCask({ token: 'x' }), /Not a Homebrew cask/);
  assert.throws(() => parseCask(null), /Not a Homebrew cask/);
});

test('derives the download URL of another version', () => {
  const slack = parseCask(SLACK);
  assert.equal(
    urlForVersion(slack, '4.52.1'),
    'https://downloads.slack-edge.com/desktop-releases/mac/arm64/4.52.1/Slack-4.52.1-macOS.dmg',
  );
  const iterm = parseCask({ ...SLACK, token: 'iterm2', version: '3.7.7', url: 'https://iterm2.com/downloads/stable/iTerm2-3_7_7.zip' });
  assert.equal(urlForVersion(iterm, '3.7.6'), 'https://iterm2.com/downloads/stable/iTerm2-3_7_6.zip');
  const arc = parseCask({ ...SLACK, token: 'arc', version: '1.172.1,90370', url: 'https://releases.arc.net/release/Arc-1.172.1-90370.zip' });
  assert.equal(urlForVersion(arc, '1.171.0,90001'), 'https://releases.arc.net/release/Arc-1.171.0-90001.zip');
  assert.equal(urlForVersion(arc, '1.171.0'), undefined, 'part counts must match');
  const chrome = parseCask({ ...SLACK, token: 'google-chrome', version: '157.0.8103.39', url: 'https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg' });
  assert.equal(urlForVersion(chrome, '156.0.1'), undefined, 'no version in the URL');
});

test('recognises installer formats from their first bytes', () => {
  assert.equal(detectContainer(Buffer.from('PK\x03\x04rest', 'latin1')), 'zip');
  assert.equal(detectContainer(Buffer.from('xar!\x00\x1c', 'latin1')), 'pkg');
  assert.equal(detectContainer(Buffer.from([0x1f, 0x8b, 8, 0])), 'tar');
  assert.equal(detectContainer(Buffer.from('BZh91AY', 'latin1')), 'tar');
  const ustar = Buffer.alloc(512);
  ustar.write('ustar', 257, 'latin1');
  assert.equal(detectContainer(ustar), 'tar');
  assert.equal(detectContainer(Buffer.alloc(512)), 'dmg');
  // A bzip2-compressed disk image starts like a bzip2 file; its koly trailer decides.
  const koly = Buffer.alloc(512);
  koly.write('koly', 0, 'latin1');
  assert.equal(detectContainer(Buffer.from('BZh91AY', 'latin1'), koly), 'dmg');
  assert.equal(detectContainer(Buffer.from('BZh91AY', 'latin1'), Buffer.alloc(512)), 'tar');
});

test('escapes HTML and only links to http(s)', () => {
  assert.equal(esc(`<script>alert("x")</script> & 'y'`), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;');
  assert.equal(safeHref('javascript:alert(1)'), undefined);
  assert.equal(safeHref('data:text/html,hi'), undefined);
  assert.equal(safeHref('not a url'), undefined);
  assert.equal(safeHref('https://example.org/a?b=1&c="2"'), 'https://example.org/a?b=1&amp;c=%222%22');
});

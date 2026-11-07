import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { applyVersionMethods, parseCaskSource, resolveCaskUrl } from '../src/cask-history.ts';
import { main } from '../src/commands.ts';
import { guessCaskToken, pickRelease } from '../src/fetch.ts';
import { buildApp, V1, V2 } from './fixtures.ts';

const SHA = (c: string): string => c.repeat(64);

describe('reading cask sources', () => {
  test('a plain cask', () => {
    assert.deepEqual(
      parseCaskSource(`cask "rectangle" do
  version "2.0.4"
  sha256 "${SHA('a')}"

  url "https://github.com/rxhanson/Rectangle/releases/download/v#{version}/Rectangle#{version}.dmg"
  name "Rectangle"
end`),
      { version: '2.0.4', sha256: SHA('a'), url: 'https://github.com/rxhanson/Rectangle/releases/download/v#{version}/Rectangle#{version}.dmg', arch: undefined },
    );
  });

  test('keeps the current-Mac stanzas and drops old-macOS, Intel and livecheck blocks', () => {
    const slack = `cask "slack" do
  arch arm: "arm64", intel: "x64"

  on_monterey :or_older do
    on_big_sur :or_older do
      version "4.45.69"
      sha256 arm:   "${SHA('1')}",
             intel: "${SHA('2')}"
      url "https://downloads.slack-edge.com/releases/macos/#{version}/prod/#{arch}/Slack-#{version}-macOS.dmg"
    end
    livecheck do
      skip "Legacy version"
    end
  end
  on_ventura :or_newer do
    version "4.53.280"
    sha256 arm:   "${SHA('c')}",
           intel: "${SHA('d')}"

    url "https://downloads.slack-edge.com/desktop-releases/mac/#{arch}/#{version}/Slack-#{version}-macOS.dmg"

    livecheck do
      url "https://slack.com/api/desktop.latestRelease?arch=#{arch}&variant=dmg"
      strategy :json do |json|
        json["version"]
      end
    end
  end

  name "Slack"
end`;
    const c = parseCaskSource(slack);
    assert.equal(c.version, '4.53.280');
    assert.equal(c.sha256, SHA('c'));
    assert.equal(c.arch, 'arm64');
    assert.equal(resolveCaskUrl(c.url!, c.version!, c.arch), 'https://downloads.slack-edge.com/desktop-releases/mac/arm64/4.53.280/Slack-4.53.280-macOS.dmg');
  });

  test('on_arm and on_intel blocks', () => {
    const c = parseCaskSource(`cask "x" do
  on_intel do
    version "1.0.0"
    sha256 "${SHA('1')}"
    url "https://x.example-dl.com/x-#{version}-intel.zip"
  end
  on_arm do
    version "1.0.1"
    sha256 "${SHA('2')}"
    url "https://x.example-dl.com/x-#{version}-arm.zip"
  end
end`);
    assert.deepEqual({ v: c.version, s: c.sha256, u: c.url }, { v: '1.0.1', s: SHA('2'), u: 'https://x.example-dl.com/x-#{version}-arm.zip' });
  });

  test('unpinned checksums and versions set only inside an OS block', () => {
    const c = parseCaskSource(`cask "chrome" do
  version "157.0.8103.39"
  sha256 :no_check
  url "https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg"
end`);
    assert.equal(c.sha256, null);
    const d = parseCaskSource(`cask "y" do
  on_sonoma do
    version "2.0"
  end
  on_sequoia do
    version "3.0"
  end
  url "https://y.example-dl.com/#{version}.dmg"
end`);
    assert.equal(d.version, '3.0');
  });
});

test('applies Homebrew version methods', () => {
  assert.equal(applyVersionMethods('1.172.1,90370', ['csv', 'first']), '1.172.1');
  assert.equal(applyVersionMethods('1.172.1,90370', ['csv', 'second']), '90370');
  assert.equal(applyVersionMethods('1.172.1,90370', ['before_comma']), '1.172.1');
  assert.equal(applyVersionMethods('3.7.7', ['dots_to_underscores']), '3_7_7');
  assert.equal(applyVersionMethods('3.7.7', ['major_minor']), '3.7');
  assert.equal(applyVersionMethods('3.7.7', ['major']), '3');
  assert.equal(applyVersionMethods('3.7.7', ['csv', 'first', 'no_dots']), '377');
  assert.equal(applyVersionMethods('3.7.7', ['csv', 'third']), undefined);
  assert.equal(applyVersionMethods('3.7.7', ['frobnicate']), undefined);
  assert.equal(resolveCaskUrl('https://x/#{version.csv.first}-#{version.csv.second}.zip', '1.2,99', undefined), 'https://x/1.2-99.zip');
  assert.equal(resolveCaskUrl('https://x/#{language}.zip', '1.2', undefined), undefined, 'unknown interpolation');
  assert.equal(resolveCaskUrl('https://x/#{arch}.zip', '1.2', undefined), undefined, 'arch without an arch stanza');
});

test('guesses cask tokens and picks the release before the installed one', () => {
  assert.equal(guessCaskToken('Google Chrome'), 'google-chrome');
  assert.equal(guessCaskToken('Visual Studio Code.app'), 'visual-studio-code');
  assert.equal(guessCaskToken('1Password'), '1password');
  const releases = ['3.0', '2.1', '2.0', '1.0'].map((version) => ({ version, sha256: null, commit: 'c', date: '' }));
  assert.equal(pickRelease(releases, undefined, '2.1').version, '2.0');
  assert.equal(pickRelease(releases, undefined, undefined).version, '2.1');
  assert.equal(pickRelease(releases, undefined, '9.9').version, '2.1', 'installed version not in history');
  assert.equal(pickRelease(releases, '1.0', '3.0').version, '1.0');
  assert.throws(() => pickRelease(releases, '0.5', undefined), /isn't in the cask's recent history/);
  const csv = [{ version: '1.172.0,90280', sha256: null, commit: 'c', date: '' }];
  assert.equal(pickRelease(csv, '1.172.0', undefined).version, '1.172.0,90280');
});

describe('updiff fetch against a fake Homebrew and GitHub', () => {
  const root = mkdtempSync(join(tmpdir(), 'updiff-fetch-'));
  const files = join(root, 'files');
  let server: Server;
  let base = '';
  let badChecksum = false;
  const shaOf = (f: string): string => createHash('sha256').update(readFileSync(join(files, f))).digest('hex');
  const caskRuby = (version: string): string => `cask "fixture" do
  version "${version}"
  sha256 "${badChecksum ? SHA('f') : shaOf(`Fixture-${version}.zip`)}"

  url "${base}/files/Fixture-#{version}.zip"
  name "Fixture"
end
`;

  before(async () => {
    mkdirSync(files, { recursive: true });
    const v1 = await buildApp(join(root, 'v1'), V1);
    const v2 = await buildApp(join(root, 'v2'), V2);
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', v1, join(files, 'Fixture-1.0.0.zip')]);
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', v2, join(files, 'Fixture-2.0.0.zip')]);
    mkdirSync(join(root, 'apps'), { recursive: true });
    cpSync(v2, join(root, 'apps', 'Fixture.app'), { recursive: true, verbatimSymlinks: true });

    server = createServer((req, res) => {
      const url = req.url ?? '';
      const send = (body: string | Buffer, type = 'application/json'): void => {
        res.setHeader('content-type', type);
        res.end(body);
      };
      if (url === '/api/fixture.json') {
        return send(JSON.stringify({ token: 'fixture', name: ['Fixture'], version: '2.0.0', url: `${base}/files/Fixture-2.0.0.zip`, sha256: shaOf('Fixture-2.0.0.zip'), artifacts: [{ app: [['Fixture.app']] }], ruby_source_path: 'Casks/f/fixture.rb' }));
      }
      if (url.startsWith('/github/repos/Homebrew/homebrew-cask/commits?')) {
        assert.match(url, /path=Casks%2Ff%2Ffixture\.rb/);
        return send(JSON.stringify([
          { sha: 'c3'.padEnd(40, '0'), commit: { committer: { date: '2026-11-02T00:00:00Z' } } },
          { sha: 'c2'.padEnd(40, '0'), commit: { committer: { date: '2026-10-20T00:00:00Z' } } },
          { sha: 'c1'.padEnd(40, '0'), commit: { committer: { date: '2026-10-01T00:00:00Z' } } },
        ]));
      }
      const raw = /^\/raw\/Homebrew\/homebrew-cask\/(c\d)0+\/Casks\/f\/fixture\.rb$/.exec(url);
      // c3 and c2 are both 2.0.0 (a style-only commit); c1 is 1.0.0.
      if (raw) return send(caskRuby(raw[1] === 'c1' ? '1.0.0' : '2.0.0'), 'text/plain');
      const file = /^\/files\/([\w.-]+)$/.exec(url);
      if (file && existsSync(join(files, file[1]!))) return send(readFileSync(join(files, file[1]!)), 'application/zip');
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.UPDIFF_CASK_API = `${base}/api`;
    process.env.UPDIFF_GITHUB_API = `${base}/github`;
    process.env.UPDIFF_GITHUB_RAW = `${base}/raw`;
  });

  after(() => {
    server?.close();
    delete process.env.UPDIFF_CASK_API;
    delete process.env.UPDIFF_GITHUB_API;
    delete process.env.UPDIFF_GITHUB_RAW;
    rmSync(root, { recursive: true, force: true });
  });

  const cli = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await main([...args, '--home', join(root, 'home'), '--apps-dir', join(root, 'apps')], { out: (s) => (out += s), err: (s) => (err += s), color: false });
    return { code, out, err };
  };

  test('--list shows one entry per version and marks the installed one', async () => {
    const r = await cli(['fetch', 'Fixture', '--list', '--format', 'json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(
      JSON.parse(r.out).map((x: { version: string; installed: boolean; checksum: string }) => [x.version, x.installed, x.checksum]),
      [['2.0.0', true, 'pinned'], ['1.0.0', false, 'pinned']],
    );
  });

  test('fetches the release before the installed one and compares them', async () => {
    const r = await cli(['fetch', 'Fixture', '--format', 'json']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /Checksum matches the cask/);
    const report = JSON.parse(r.out);
    assert.equal(report.from.version, '1.0.0');
    assert.equal(report.to.version, '2.0.0');
    assert.equal(report.counts.high, 6);
    // The fetched release is now the baseline: a later check reports the same update.
    const check = await cli(['check', '--format', 'json']);
    assert.equal(JSON.parse(check.out).changed[0].counts.high, 6);
  });

  test('refuses a download whose checksum does not match the cask', async () => {
    badChecksum = true;
    try {
      const r = await cli(['fetch', 'Fixture', '1.0.0']);
      assert.equal(r.code, 1);
      assert.match(r.err, /^updiff: Checksum mismatch/m);
      assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
    } finally {
      badChecksum = false;
    }
  });

  test('says when no cask matches', async () => {
    const r = await cli(['fetch', 'No Such App']);
    assert.equal(r.code, 1);
    assert.match(r.err, /No Homebrew cask found for "no-such-app"/);
  });
});

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HOSTNAME_CAVEAT } from '../../src/report.ts';
import type { Finding, Severity } from '../../src/types.ts';
import { versionSlug, type AppState, type LedgerReport, type LedgerStore, type TrackedApp } from './store.ts';

export interface SiteOptions {
  out: string;
  /** Absolute URL the site is served from, used in the feed, e.g. https://intincrab.github.io/updiff/ */
  baseUrl?: string;
  repoUrl?: string;
  now?: Date;
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An href that can only be an http(s) URL. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? esc(u.href) : undefined;
  } catch {
    return undefined;
  }
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function reportSlug(r: LedgerReport): string {
  return `${r.detectedAt.slice(0, 10)}__${versionSlug(r.from.version)}__to__${versionSlug(r.to.version)}`;
}

function chips(counts: Record<Severity, number>): string {
  const parts: string[] = [];
  if (counts.high) parts.push(`<span class="chip high">${counts.high} high</span>`);
  if (counts.notable) parts.push(`<span class="chip notable">${counts.notable} notable</span>`);
  if (!counts.high && !counts.notable) parts.push('<span class="chip quiet">quiet update</span>');
  return parts.join(' ');
}

const MARK: Record<Finding['change'], string> = { added: '+', removed: '−', changed: '~' };

function layout(title: string, depth: number, body: string, description: string): string {
  const up = '../'.repeat(depth);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="stylesheet" href="${up}style.css">
<link rel="alternate" type="application/atom+xml" title="updiff ledger" href="${up}feed.xml">
</head>
<body>
<header class="site">
  <a class="brand" href="${up}index.html"><span class="mark">±</span> updiff ledger</a>
  <nav><a href="${up}index.html">Updates</a><a href="${up}apps.html">Apps</a><a href="${up}about.html">About</a><a href="${up}feed.xml">Feed</a></nav>
</header>
<main>
${body}
</main>
<footer class="site">
  <p>Static analysis of the installers Homebrew points to. ${esc(HOSTNAME_CAVEAT)}</p>
</footer>
</body>
</html>
`;
}

function keyFindings(r: LedgerReport, max: number): Finding[] {
  return r.report.findings.filter((f) => f.severity !== 'info').slice(0, max);
}

function updateRow(r: LedgerReport, depth: number, showApp: boolean): string {
  const up = '../'.repeat(depth);
  const href = `${up}updates/${esc(r.cask)}/${esc(reportSlug(r))}.html`;
  const findings = keyFindings(r, 3);
  const more = r.report.counts.high + r.report.counts.notable - findings.length;
  return `<li class="update">
  <div class="update-head">
    <a class="update-title" href="${href}">${showApp ? `${esc(r.name)} ` : ''}<span class="ver">${esc(r.from.version)} → ${esc(r.to.version)}</span></a>
    <span class="meta">${fmtDate(r.detectedAt)}</span>
  </div>
  <div class="chips">${chips(r.report.counts)}</div>
  ${
    findings.length
      ? `<ul class="key">${findings.map((f) => `<li class="${f.severity}"><span class="m">${MARK[f.change]}</span>${esc(f.title)}</li>`).join('')}${more > 0 ? `<li class="more"><a href="${href}">and ${more} more</a></li>` : ''}</ul>`
      : ''
  }
</li>`;
}

function indexPage(reports: LedgerReport[], states: AppState[], opts: SiteOptions): string {
  const releases = states.reduce((n, s) => n + s.history.length, 0);
  const lastChecked = states.map((s) => s.lastCheckedAt ?? '').sort().pop();
  const flagged = reports.filter((r) => r.report.counts.high > 0).slice(0, 5);
  const body = `
<section class="hero">
  <h1>What changed inside the latest Mac app updates</h1>
  <p class="lede">Release notes say "bug fixes and improvements". This ledger reads the installers themselves:
  permissions, privacy prompts, things that run in the background, new helpers, bundled packages and the hosts the code mentions.
  It follows ${states.length} popular apps through Homebrew and scans every new release with <a href="${opts.repoUrl ? safeHref(opts.repoUrl) ?? '#' : '#'}">updiff</a>.</p>
  <p class="stats"><strong>${states.length}</strong> apps · <strong>${releases}</strong> releases scanned · <strong>${reports.length}</strong> updates compared · last checked ${fmtDate(lastChecked)}</p>
</section>
${
  flagged.length
    ? `<section><h2>Flagged high</h2><ul class="updates">${flagged.map((r) => updateRow(r, 0, true)).join('\n')}</ul></section>`
    : ''
}
<section>
  <h2>Latest updates</h2>
  ${
    reports.length
      ? `<ul class="updates">${reports.slice(0, 60).map((r) => updateRow(r, 0, true)).join('\n')}</ul>`
      : `<p class="empty">No updates compared yet. Baselines are recorded for ${states.length} apps; the first reports appear when they next release.</p>`
  }
</section>`;
  return layout('updiff ledger: what changed inside Mac app updates', 0, body, 'What changed inside the latest releases of popular Mac apps, read from the installers.');
}

function appsPage(states: AppState[], reportsByCask: Map<string, LedgerReport[]>): string {
  const rows = states
    .map((s) => {
      const latestReport = reportsByCask.get(s.cask)?.[0];
      return `<tr>
  <td><a href="apps/${esc(s.cask)}.html">${esc(s.name)}</a>${s.lastError ? ' <span class="chip high" title="' + esc(s.lastError.message) + '">last check failed</span>' : ''}</td>
  <td class="mono">${esc(s.latest?.version ?? '—')}</td>
  <td>${latestReport ? `<a href="updates/${esc(s.cask)}/${esc(reportSlug(latestReport))}.html">${fmtDate(latestReport.detectedAt)}</a> ${chips(latestReport.report.counts)}` : '<span class="meta">none yet</span>'}</td>
  <td class="num">${s.history.length}</td>
</tr>`;
    })
    .join('\n');
  const body = `<h1>Tracked apps</h1>
<p class="lede">Each app is followed through its Homebrew cask. Its first scanned release is the baseline; every later release is compared with the one before.</p>
<div class="table-wrap"><table>
<thead><tr><th>App</th><th>Current</th><th>Last update</th><th class="num">Releases</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`;
  return layout('Tracked apps · updiff ledger', 0, body, 'Apps followed by the updiff ledger.');
}

function appPage(s: AppState, reports: LedgerReport[]): string {
  const history = s.history
    .map((h) => {
      const r = reports.find((x) => x.to.version === h.version && x.to.fingerprint === h.fingerprint);
      return `<tr>
  <td class="mono">${esc(h.version)}${h.appVersion !== h.version ? ` <span class="meta">(app ${esc(h.appVersion)})</span>` : ''}</td>
  <td>${fmtDate(h.scannedAt)}</td>
  <td>${r ? `<a href="../updates/${esc(s.cask)}/${esc(reportSlug(r))}.html">compared with ${esc(r.from.version)}</a> ${chips(r.report.counts)}` : '<span class="meta">baseline</span>'}</td>
  <td class="mono small">${esc(h.sha256.slice(0, 16))}…</td>
</tr>`;
    })
    .join('\n');
  const home = safeHref(s.homepage);
  const body = `<p class="crumbs"><a href="../apps.html">Apps</a> ›</p>
<h1>${esc(s.name)}</h1>
${s.desc ? `<p class="lede">${esc(s.desc)}</p>` : ''}
<dl class="facts">
  <dt>Homebrew cask</dt><dd><a href="https://formulae.brew.sh/cask/${esc(s.cask)}">${esc(s.cask)}</a></dd>
  ${s.bundleId ? `<dt>Bundle id</dt><dd class="mono">${esc(s.bundleId)}</dd>` : ''}
  ${home ? `<dt>Homepage</dt><dd><a href="${home}">${esc(s.homepage)}</a></dd>` : ''}
  <dt>Last checked</dt><dd>${fmtDate(s.lastCheckedAt)}</dd>
  ${s.lastError ? `<dt>Last error</dt><dd>${esc(s.lastError.version)}: ${esc(s.lastError.message)}</dd>` : ''}
</dl>
<h2>Releases</h2>
<div class="table-wrap"><table>
<thead><tr><th>Version</th><th>Scanned</th><th>Changes</th><th>SHA-256</th></tr></thead>
<tbody>
${history}
</tbody></table></div>`;
  return layout(`${s.name} · updiff ledger`, 1, body, `Every scanned release of ${s.name} and what changed in each.`);
}

const SECTION: Record<Severity, string> = { high: 'High', notable: 'Notable', info: 'Info' };

function releaseBox(label: string, rec: LedgerReport['from']): string {
  const href = safeHref(rec.url);
  return `<div class="release">
  <h3>${esc(label)}: <span class="mono">${esc(rec.version)}</span></h3>
  <dl>
    <dt>Installer</dt><dd class="mono small">${href ? `<a href="${href}">${esc(rec.url)}</a>` : esc(rec.url)}</dd>
    <dt>Size</dt><dd>${fmtMB(rec.bytes)}</dd>
    <dt>SHA-256</dt><dd class="mono small">${esc(rec.sha256)}</dd>
    <dt>Scanned</dt><dd>${fmtDate(rec.scannedAt)}</dd>
  </dl>
</div>`;
}

function reportPage(r: LedgerReport): string {
  const sections = (['high', 'notable', 'info'] as Severity[])
    .map((sev) => {
      const group = r.report.findings.filter((f) => f.severity === sev);
      if (!group.length) return '';
      return `<section class="findings ${sev}">
<h2>${SECTION[sev]} <span class="count">${group.length}</span></h2>
<ul>
${group
  .map(
    (f) => `<li>
  <div class="f-title"><span class="m" title="${esc(f.change)}">${MARK[f.change]}</span>${esc(f.title)}</div>
  ${f.detail ? `<div class="f-detail">${esc(f.detail)}</div>` : ''}
  ${f.where?.length ? `<div class="f-where">${f.where.map((w) => `<code>${esc(w)}</code>`).join(' ')}</div>` : ''}
</li>`,
  )
  .join('\n')}
</ul>
</section>`;
    })
    .join('\n');
  const body = `<p class="crumbs"><a href="../../apps.html">Apps</a> › <a href="../../apps/${esc(r.cask)}.html">${esc(r.name)}</a> ›</p>
<h1>${esc(r.name)} <span class="ver">${esc(r.from.version)} → ${esc(r.to.version)}</span></h1>
<p class="meta">Detected ${fmtDate(r.detectedAt)} · <span class="mono">${esc(r.report.app.bundleId)}</span>${r.deep ? ' · deep scan (framework binaries included)' : ''}</p>
<div class="chips big">${chips(r.report.counts)} <span class="chip info">${r.report.counts.info} info</span></div>
${r.report.findings.length ? sections : '<p class="empty">No differences found.</p>'}
<section class="repro">
<h2>Check it yourself</h2>
<div class="releases">${releaseBox('Before', r.from)}${releaseBox('After', r.to)}</div>
<p>Download both installers, confirm the SHA-256 values, then run <code>updiff diff Old.app New.app${r.deep ? ' --deep' : ''}</code>.</p>
</section>`;
  return layout(`${r.name} ${r.from.version} → ${r.to.version} · updiff ledger`, 2, body, `What changed inside ${r.name} ${r.to.version} compared with ${r.from.version}.`);
}

function aboutPage(opts: SiteOptions): string {
  const repo = opts.repoUrl ? safeHref(opts.repoUrl) : undefined;
  const body = `<h1>About the ledger</h1>
<p class="lede">The ledger runs <a href="${repo ?? '#'}">updiff</a> every day on the newest releases of popular Mac apps, as published in Homebrew casks.</p>
<h2>How a release is checked</h2>
<ol>
  <li>The Homebrew cask API gives the current version, the download URL and usually a SHA-256 checksum.</li>
  <li>The installer is downloaded and its checksum verified, when the cask pins one.</li>
  <li>The app is taken out of the installer without running anything: disk images are mounted read-only, zips extracted, packages expanded with <code>pkgutil</code>.</li>
  <li>updiff records the app's signature, entitlements for every executable, privacy prompts, background items, helpers, Electron packages and hostnames.</li>
  <li>The snapshot is compared with the previous release's, and each change is graded high, notable or info.</li>
</ol>
<h2>What the grades mean</h2>
<ul>
  <li><span class="chip high">high</span> needs a human look: new access to the camera, microphone, contacts or location; a new privacy prompt; something new that starts at login or runs as root; a different signing team; a weaker code signature; a changed update key.</li>
  <li><span class="chip notable">notable</span> worth knowing: new helpers and extensions, new bundled npm packages, an Electron upgrade, new domains in the code, new URL schemes.</li>
  <li><span class="chip info">info</span> housekeeping: removals, version bumps, new hosts under domains the app already used.</li>
</ul>
<h2>Limits</h2>
<ul>
  <li>${esc(HOSTNAME_CAVEAT)}</li>
  <li>Code an app downloads after it starts (plugins, models, remote config) is not in the installer.</li>
  <li>Some casks don't pin a checksum (they always point at "the latest" file), so the ledger records the checksum it saw.</li>
  <li>A finding is a lead, not a verdict. Many changes have ordinary explanations.</li>
</ul>
<h2>Data</h2>
<p>Every report is plain JSON in the repository's <code>ledger/data</code> folder. ${repo ? `Source and data: <a href="${repo}">${esc(opts.repoUrl)}</a>.` : ''}</p>`;
  return layout('About · updiff ledger', 0, body, 'How the updiff ledger checks Mac app releases.');
}

function feed(reports: LedgerReport[], opts: SiteOptions): string {
  const base = (opts.baseUrl ?? 'https://example.invalid/').replace(/\/?$/, '/');
  const updated = reports[0]?.detectedAt ?? (opts.now ?? new Date()).toISOString();
  const entries = reports
    .slice(0, 50)
    .map((r) => {
      const url = `${base}updates/${r.cask}/${reportSlug(r)}.html`;
      const c = r.report.counts;
      const key = keyFindings(r, 5).map((f) => `${f.severity}: ${f.title}`);
      const summary = [`${c.high} high, ${c.notable} notable, ${c.info} info.`, ...key].join('\n');
      return `  <entry>
    <title>${esc(`${r.name} ${r.from.version} → ${r.to.version}: ${c.high} high, ${c.notable} notable`)}</title>
    <id>${esc(url)}</id>
    <link href="${esc(url)}"/>
    <updated>${esc(r.detectedAt)}</updated>
    <summary>${esc(summary)}</summary>
  </entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>updiff ledger</title>
  <subtitle>What changed inside the latest Mac app updates</subtitle>
  <id>${esc(base)}</id>
  <link href="${esc(base)}"/>
  <link rel="self" href="${esc(base)}feed.xml"/>
  <updated>${esc(updated)}</updated>
  <author><name>updiff ledger</name></author>
${entries}
</feed>
`;
}

export const STYLE = `:root {
  --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6b665e; --line: #e4e0d8; --card: #ffffff;
  --accent: #2f5d50; --high: #b3261e; --high-bg: #fbe9e7; --notable: #8a5a00; --notable-bg: #fbf0d9;
  --info: #44607a; --info-bg: #e8eef4; --quiet: #4f6b3a; --quiet-bg: #ecf3e6;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151514; --fg: #ecebe8; --muted: #a29d94; --line: #2c2b29; --card: #1d1c1b;
    --accent: #8cc7b2; --high: #ff8a80; --high-bg: #3a1d1b; --notable: #f2c46d; --notable-bg: #352a14;
    --info: #9cb8d4; --info-bg: #1d2731; --quiet: #a9cf8f; --quiet-bg: #1f2a18;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
a { color: var(--accent); text-underline-offset: 2px; }
header.site, main, footer.site { max-width: 920px; margin: 0 auto; padding: 0 20px; }
header.site { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; justify-content: space-between; padding-top: 22px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; color: var(--fg); text-decoration: none; letter-spacing: -0.01em; }
.brand .mark { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; background: var(--fg); color: var(--bg); margin-right: 6px; font-size: 15px; }
nav { display: flex; gap: 18px; font-size: 15px; }
nav a { color: var(--muted); text-decoration: none; }
nav a:hover { color: var(--fg); }
main { padding-top: 28px; padding-bottom: 48px; }
h1 { font-size: clamp(26px, 4vw, 36px); line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 12px; }
h2 { font-size: 19px; margin: 36px 0 12px; letter-spacing: -0.01em; }
h3 { font-size: 15px; margin: 0 0 8px; }
.lede { color: var(--muted); font-size: 17px; max-width: 70ch; }
.stats { color: var(--muted); font-size: 15px; }
.stats strong { color: var(--fg); }
.meta, .empty { color: var(--muted); font-size: 14px; }
.mono, code { font-family: var(--mono); font-size: 0.92em; }
.small { font-size: 12.5px; }
.ver { font-family: var(--mono); font-weight: 500; font-size: 0.8em; color: var(--muted); white-space: nowrap; }
.crumbs { font-size: 14px; color: var(--muted); margin: 0 0 8px; }
.chip { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.chip.high { color: var(--high); background: var(--high-bg); }
.chip.notable { color: var(--notable); background: var(--notable-bg); }
.chip.info { color: var(--info); background: var(--info-bg); }
.chip.quiet { color: var(--quiet); background: var(--quiet-bg); }
.chips.big .chip { font-size: 13px; padding: 3px 10px; }
ul.updates { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
li.update { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.update-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; align-items: baseline; }
.update-title { font-weight: 650; color: var(--fg); text-decoration: none; }
.update-title:hover { text-decoration: underline; }
.chips { margin: 6px 0 0; display: flex; flex-wrap: wrap; gap: 6px; }
ul.key { list-style: none; padding: 0; margin: 10px 0 0; font-size: 14.5px; display: grid; gap: 3px; }
ul.key li { overflow-wrap: anywhere; }
ul.key .m, .f-title .m { display: inline-block; width: 1.3em; font-family: var(--mono); font-weight: 700; }
ul.key li.high .m { color: var(--high); }
ul.key li.notable .m { color: var(--notable); }
ul.key li.more { padding-left: 1.3em; font-size: 13.5px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
th { font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; }
.num { text-align: right; }
dl.facts, .release dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 14.5px; margin: 16px 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
section.findings ul { list-style: none; padding: 0; margin: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
section.findings li { padding: 12px 16px; border-bottom: 1px solid var(--line); }
section.findings li:last-child { border-bottom: 0; }
section.findings.high h2 { color: var(--high); }
section.findings.notable h2 { color: var(--notable); }
section.findings.info h2 { color: var(--info); }
section.findings.high .m { color: var(--high); }
section.findings.notable .m { color: var(--notable); }
.count { font-size: 14px; color: var(--muted); font-weight: 500; }
.f-title { font-weight: 600; overflow-wrap: anywhere; }
.f-detail { margin: 4px 0 0 1.3em; font-size: 14px; overflow-wrap: anywhere; }
.f-where { margin: 4px 0 0 1.3em; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.f-where code { font-size: 12px; }
.releases { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.release { border: 1px solid var(--line); border-radius: 12px; background: var(--card); padding: 14px 16px; }
.release dl { margin: 0; font-size: 13.5px; }
.hero { padding-bottom: 6px; }
footer.site { padding-top: 18px; padding-bottom: 40px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
@media (max-width: 560px) { header.site { padding-top: 16px; padding-bottom: 16px; } nav { gap: 14px; } }
`;

async function put(out: string, rel: string, content: string): Promise<void> {
  const file = join(out, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Builds the static site. Returns the number of report pages written. */
export async function buildSite(store: LedgerStore, apps: TrackedApp[], opts: SiteOptions): Promise<{ pages: number; reports: number }> {
  const casks = [...new Set([...apps.map((a) => a.cask), ...(await store.listCasks())])];
  const states: AppState[] = [];
  const reports: LedgerReport[] = [];
  const byCask = new Map<string, LedgerReport[]>();
  for (const cask of casks) {
    const state = await store.loadState(cask);
    if (!state) continue;
    states.push(state);
    const list: LedgerReport[] = [];
    for (const h of state.history) if (h.report) list.push(await store.loadReport(cask, h.report));
    list.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    byCask.set(cask, list);
    reports.push(...list);
  }
  states.sort((a, b) => a.name.localeCompare(b.name));
  reports.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt) || a.name.localeCompare(b.name));

  let pages = 0;
  await put(opts.out, 'style.css', STYLE);
  await put(opts.out, 'index.html', indexPage(reports, states, opts));
  await put(opts.out, 'apps.html', appsPage(states, byCask));
  await put(opts.out, 'about.html', aboutPage(opts));
  await put(opts.out, 'feed.xml', feed(reports, opts));
  pages += 4;
  for (const s of states) {
    await put(opts.out, `apps/${s.cask}.html`, appPage(s, byCask.get(s.cask) ?? []));
    pages++;
  }
  for (const r of reports) {
    await put(opts.out, `updates/${r.cask}/${reportSlug(r)}.html`, reportPage(r));
    pages++;
  }
  // GitHub Pages: serve files as-is.
  await put(opts.out, '.nojekyll', '');
  return { pages, reports: reports.length };
}

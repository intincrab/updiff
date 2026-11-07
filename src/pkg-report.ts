import { basename } from 'node:path';
import { CATEGORY_ORDER, SEVERITY_ORDER } from './diff.ts';
import type { PkgComponent, PkgReport, PkgScript } from './pkg.ts';
import type { DiffReport, Finding, Severity } from './types.ts';
import { formatBytes, lineDiff } from './util.ts';

interface Style {
  bold(s: string): string;
  dim(s: string): string;
  warn(s: string): string;
}

const plain: Style = { bold: (s) => s, dim: (s) => s, warn: (s) => s };
const ansi: Style = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  warn: (s) => `\x1b[33m${s}\x1b[39m`,
};

function describeLaunch(i: PkgComponent['launchItems'][number]): string {
  const bits = [i.label ? `label ${i.label}` : undefined, i.program ? `runs ${i.program}` : undefined, i.runAtLoad ? (i.kind === 'daemon' ? 'starts at boot' : 'starts at login') : undefined, i.keepAlive ? 'kept alive' : undefined];
  return bits.filter(Boolean).join(' · ');
}

function scriptHeader(s: PkgScript): string {
  const what = s.binary ? 'binary' : `${s.interpreter ?? 'no interpreter line'}, ${s.lines} line${s.lines === 1 ? '' : 's'}`;
  return `${s.name} (${what}, ${formatBytes(s.bytes)})`;
}

/** What an installer package would do, for reading before running it. */
export function renderPkg(r: PkgReport, options: { color?: boolean; full?: boolean; maxScriptLines?: number } = {}): string {
  const st = options.color ? ansi : plain;
  const maxLines = options.full ? Infinity : (options.maxScriptLines ?? 40);
  const lines: string[] = [];
  const title = r.distribution?.title ?? r.components[0]?.id ?? basename(r.file);
  lines.push(st.bold(`${title}  ${basename(r.file)}`), st.dim(`sha256 ${r.sha256} · ${formatBytes(r.bytes)}`), '');
  const sig = r.signature;
  lines.push(`Signature      ${sig.signer ?? sig.status}${sig.notarized ? ' · notarized' : ''}`);
  lines.push(`Gatekeeper     ${r.gatekeeper.assessment}${r.gatekeeper.source ? ` (${r.gatekeeper.source})` : ''}`);
  const root = r.components.some((c) => c.auth === 'root');
  lines.push(`Runs as        ${root ? st.warn('root: the installer asks for an administrator password') : 'the current user'}`);
  if (r.distribution) {
    const js = r.distribution.scripts.length + r.distribution.checks.length;
    lines.push(`Installer UI   ${js ? st.warn(`${js} JavaScript check${js === 1 ? '' : 's'} run when the installer opens`) : 'no JavaScript'}`);
  }
  for (const c of r.components) {
    lines.push('', st.bold(`Component ${c.id ?? '(unnamed)'}${c.version ? ` ${c.version}` : ''}`) + st.dim(`  → ${c.installLocation} · ${c.files} file${c.files === 1 ? '' : 's'}, ${formatBytes(c.bytes)}`));
    for (const a of c.apps) lines.push(`  App          ${a.path}${a.bundleId ? ` (${a.bundleId}${a.version ? ` ${a.version}` : ''}${a.teamId ? `, team ${a.teamId}` : ''})` : ''}`);
    for (const l of c.launchItems) lines.push(st.warn(`  Launch ${l.kind.padEnd(6)} ${l.path}`) + (describeLaunch(l) ? st.dim(`  ${describeLaunch(l)}`) : ''));
    for (const p of c.systemLevel) lines.push(st.warn(`  System level ${p}`));
    if (c.outsideApplications.length) {
      lines.push(`  Outside /Applications: ${c.outsideApplications.slice(0, 12).join(', ')}${c.outsideApplications.length > 12 ? ` and ${c.outsideApplications.length - 12} more` : ''}`);
    }
    if (!c.scripts.length) lines.push(st.dim('  No install scripts.'));
    for (const s of c.scripts) {
      lines.push('', `  ${s.hook ? st.warn(`Runs ${s.name === 'preinstall' ? 'before' : 'after'} installing${c.auth === 'root' ? ' as root' : ''}:`) : 'Helper file:'} ${scriptHeader(s)}`);
      if (s.content === undefined) {
        lines.push(st.dim(s.binary ? '    (binary: not shown)' : '    (too large to show)'));
        continue;
      }
      const body = s.content.replace(/\n$/, '').split('\n');
      for (const l of body.slice(0, maxLines)) lines.push(st.dim('    │ ') + l);
      if (body.length > maxLines) lines.push(st.dim(`    │ … ${body.length - maxLines} more lines (use --full)`));
    }
  }
  if (r.distribution && (r.distribution.scripts.length || r.distribution.checks.length)) {
    lines.push('', st.bold('Installer JavaScript'));
    for (const check of r.distribution.checks) lines.push(`  ${check}`);
    for (const js of r.distribution.scripts) {
      const body = js.split('\n');
      for (const l of body.slice(0, maxLines)) lines.push(st.dim('    │ ') + l);
      if (body.length > maxLines) lines.push(st.dim(`    │ … ${body.length - maxLines} more lines (use --full)`));
    }
  }
  lines.push('', st.dim('Nothing was installed or run: the package was only unpacked.'));
  return lines.join('\n') + '\n';
}

export function renderPkgMarkdown(r: PkgReport): string {
  const out: string[] = [`# ${r.distribution?.title ?? r.components[0]?.id ?? basename(r.file)}`, '', `\`${basename(r.file)}\` · sha256 \`${r.sha256}\` · ${formatBytes(r.bytes)}`, ''];
  out.push(`- Signature: ${r.signature.signer ?? r.signature.status}${r.signature.notarized ? ' (notarized)' : ''}`);
  out.push(`- Gatekeeper: ${r.gatekeeper.assessment}${r.gatekeeper.source ? ` (${r.gatekeeper.source})` : ''}`);
  out.push(`- Runs as: ${r.components.some((c) => c.auth === 'root') ? 'root' : 'the current user'}`, '');
  for (const c of r.components) {
    out.push(`## ${c.id ?? 'Component'} ${c.version ?? ''}`, '', `Installs to \`${c.installLocation}\` (${c.files} files, ${formatBytes(c.bytes)}).`, '');
    for (const a of c.apps) out.push(`- App \`${a.path}\` ${a.bundleId ?? ''} ${a.version ?? ''}`);
    for (const l of c.launchItems) out.push(`- Launch ${l.kind} \`${l.path}\`: ${describeLaunch(l)}`);
    for (const p of c.systemLevel) out.push(`- System level \`${p}\``);
    if (c.outsideApplications.length) out.push(`- Outside /Applications: ${c.outsideApplications.map((p) => `\`${p}\``).join(', ')}`);
    for (const s of c.scripts) {
      out.push('', `### ${s.hook ? 'Script' : 'Helper'}: ${scriptHeader(s)}`, '');
      if (s.content !== undefined) out.push('```sh', s.content.replace(/\n$/, ''), '```');
    }
    out.push('');
  }
  return out.join('\n') + '\n';
}

function teamOf(signer: string | undefined): string | undefined {
  return /\(([A-Z0-9]{10})\)\s*$/.exec(signer ?? '')?.[1];
}

/** What changed between two versions of an installer package. */
export function diffPkgs(a: PkgReport, b: PkgReport): DiffReport {
  const f: Finding[] = [];
  const at = (where: string): string[] => [where];
  if (a.signature.notarized && !b.signature.notarized) f.push({ severity: 'high', category: 'signing', change: 'removed', title: 'Package is no longer notarized' });
  if (teamOf(a.signature.signer) && teamOf(b.signature.signer) && teamOf(a.signature.signer) !== teamOf(b.signature.signer)) {
    f.push({ severity: 'high', category: 'signing', change: 'changed', title: 'Package is signed by a different developer', detail: `${a.signature.signer} → ${b.signature.signer}` });
  } else if (a.signature.signer && !b.signature.signer) {
    f.push({ severity: 'high', category: 'signing', change: 'removed', title: 'Package is no longer signed', detail: b.signature.status });
  }
  if (a.gatekeeper.assessment === 'accepted' && b.gatekeeper.assessment === 'rejected') {
    f.push({ severity: 'high', category: 'signing', change: 'changed', title: 'Gatekeeper now rejects the package', detail: b.gatekeeper.source });
  }
  const rootA = a.components.some((c) => c.auth === 'root');
  const rootB = b.components.some((c) => c.auth === 'root');
  if (!rootA && rootB) f.push({ severity: 'high', category: 'install', change: 'added', title: 'Now installs as root (asks for an administrator password)' });

  const byId = new Map(a.components.map((c) => [c.id ?? c.installLocation, c]));
  for (const cb of b.components) {
    const key = cb.id ?? cb.installLocation;
    const ca = byId.get(key);
    byId.delete(key);
    const label = cb.id ?? 'component';
    if (!ca) {
      f.push({ severity: 'notable', category: 'install', change: 'added', title: `New component ${label}`, detail: `installs to ${cb.installLocation}` });
    }
    const scriptsA = new Map((ca?.scripts ?? []).map((s) => [s.name, s]));
    for (const s of cb.scripts) {
      const old = scriptsA.get(s.name);
      scriptsA.delete(s.name);
      if (!old) {
        f.push({
          severity: s.hook ? 'high' : 'notable',
          category: 'script',
          change: 'added',
          title: s.hook ? `New ${s.name} script${cb.auth === 'root' ? ' (runs as root)' : ''}` : `New helper file ${s.name}`,
          detail: s.content?.replace(/\n$/, '').split('\n').slice(0, 30).map((l) => `+ ${l}`).join('\n'),
          where: at(label),
        });
      } else if (old.content !== s.content || old.bytes !== s.bytes) {
        const changes = old.content !== undefined && s.content !== undefined ? lineDiff(old.content, s.content) : ['(binary or too large to compare)'];
        const added = changes.filter((l) => l.startsWith('+ ')).length;
        const removed = changes.filter((l) => l.startsWith('- ')).length;
        f.push({
          severity: 'notable',
          category: 'script',
          change: 'changed',
          title: `${s.hook ? 'Script' : 'Helper file'} ${s.name} changed (+${added} −${removed} lines)`,
          detail: changes.slice(0, 40).join('\n') + (changes.length > 40 ? `\n… ${changes.length - 40} more changed lines` : ''),
          where: at(label),
        });
      }
    }
    for (const s of scriptsA.values()) f.push({ severity: 'info', category: 'script', change: 'removed', title: `Removed ${s.name}`, where: at(label) });

    const launchA = new Map((ca?.launchItems ?? []).map((l) => [l.path, l]));
    for (const l of cb.launchItems) {
      const old = launchA.get(l.path);
      if (!old) {
        f.push({ severity: 'high', category: 'background', change: 'added', title: `Installs a new launch ${l.kind}: ${l.path}`, detail: describeLaunch(l), where: at(label) });
      } else if (old.program !== l.program || old.runAtLoad !== l.runAtLoad || old.keepAlive !== l.keepAlive) {
        f.push({ severity: 'notable', category: 'background', change: 'changed', title: `Launch ${l.kind} ${l.path} changed`, detail: `${describeLaunch(old)} → ${describeLaunch(l)}`, where: at(label) });
      }
    }
    const sysA = new Set(ca?.systemLevel ?? []);
    for (const p of cb.systemLevel) if (!sysA.has(p)) f.push({ severity: 'high', category: 'install', change: 'added', title: `Installs a new system-level item: ${p}`, where: at(label) });
    const outA = new Set(ca?.outsideApplications ?? []);
    const newOut = cb.outsideApplications.filter((p) => !outA.has(p));
    if (newOut.length) f.push({ severity: 'notable', category: 'install', change: 'added', title: 'Installs files in new places outside /Applications', detail: newOut.join(', '), where: at(label) });
    const appsA = new Map((ca?.apps ?? []).map((x) => [x.path, x]));
    for (const app of cb.apps) {
      const old = appsA.get(app.path);
      if (!old) f.push({ severity: 'notable', category: 'install', change: 'added', title: `Installs a new app: ${app.path}`, detail: app.bundleId, where: at(label) });
      else if (old.teamId && app.teamId && old.teamId !== app.teamId) {
        f.push({ severity: 'high', category: 'signing', change: 'changed', title: `${app.path} is signed by a different developer team`, detail: `${old.teamId} → ${app.teamId}`, where: at(label) });
      }
    }
  }
  for (const gone of byId.values()) f.push({ severity: 'info', category: 'install', change: 'removed', title: `Removed component ${gone.id ?? gone.installLocation}` });
  const jsA = (a.distribution?.scripts ?? []).join('\n');
  const jsB = (b.distribution?.scripts ?? []).join('\n');
  if (jsA !== jsB) {
    const changes = lineDiff(jsA, jsB);
    f.push({ severity: 'notable', category: 'script', change: 'changed', title: 'Installer JavaScript changed', detail: changes.slice(0, 40).join('\n') });
  }
  if (a.sha256 === b.sha256) f.length = 0;

  f.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || CATEGORY_ORDER.indexOf(x.category) - CATEGORY_ORDER.indexOf(y.category) || x.title.localeCompare(y.title));
  const counts: Record<Severity, number> = { high: 0, notable: 0, info: 0 };
  for (const x of f) counts[x.severity]++;
  const side = (r: PkgReport): DiffReport['from'] => ({ version: r.components[0]?.version ?? '?', build: r.sha256.slice(0, 12), takenAt: '', path: r.file });
  return {
    app: { name: b.distribution?.title ?? basename(b.file), bundleId: b.components[0]?.id ?? '' },
    from: side(a),
    to: side(b),
    findings: f,
    counts,
    identical: a.sha256 === b.sha256,
  };
}

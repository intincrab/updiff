/**
 * Renders scripts/demo/transcript.json (a real, recorded run) as an animated terminal
 * window: docs/demo.svg. Commands are typed, output scrolls in line by line, then the
 * window holds, fades and loops. Animation is SMIL, which GitHub plays in README
 * images; without animation the image shows the finished frame.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Step } from './record.ts';

const COLS = 96;
const CHAR_W = 8.43; // advance of a 14px monospace glyph
const LINE_H = 19;
const FONT_SIZE = 14;
const PAD_X = 22;
const PAD_TOP = 18;
const PAD_BOTTOM = 20;
const TITLE_H = 38;
const MARGIN = 18; // room for the window shadow

const C = {
  window: '#0f1218',
  titlebar: '#171b22',
  border: '#2a303b',
  fg: '#d4d9e1',
  dim: '#7c8594',
  comment: '#7c8594',
  prompt: '#7ee2a8',
  path: '#82aaff',
  high: '#ff7a72',
  notable: '#f0c05a',
  info: '#6cc7f6',
  cursor: '#d4d9e1',
};

interface Seg {
  text: string;
  fill: string;
  bold: boolean;
  italic?: boolean;
}

/** Splits a line with ANSI SGR codes into styled segments. */
function parseAnsi(line: string): Seg[] {
  const segs: Seg[] = [];
  let bold = false;
  let dim = false;
  let color: string | undefined;
  let last = 0;
  const push = (text: string): void => {
    if (!text) return;
    segs.push({ text, fill: color ?? (dim ? C.dim : C.fg), bold });
  };
  for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    push(line.slice(last, m.index));
    last = m.index! + m[0].length;
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) [bold, dim, color] = [false, false, undefined];
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) [bold, dim] = [false, false];
      else if (code === 31) color = C.high;
      else if (code === 33) color = C.notable;
      else if (code === 36) color = C.info;
      else if (code === 39) color = undefined;
    }
  }
  push(line.slice(last));
  return segs;
}

/** Wraps styled segments at the terminal width, breaking between words where possible. */
function wrap(segs: Seg[], cols: number): Seg[][] {
  // Work on single characters that each remember their style.
  const chars = segs.flatMap((seg) => [...seg.text].map((ch) => ({ ch, seg })));
  const lines: (typeof chars)[] = [];
  let rest = chars;
  while (rest.length > cols) {
    let cut = cols;
    for (let i = cols; i > cols * 0.6; i--) {
      if (rest[i]?.ch === ' ') {
        cut = i;
        break;
      }
    }
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    while (rest[0]?.ch === ' ') rest = rest.slice(1);
  }
  lines.push(rest);
  // Merge runs of characters that share a style back into segments.
  return lines.map((line) => {
    const out: Seg[] = [];
    for (const { ch, seg } of line) {
      const last = out[out.length - 1];
      if (last && last.fill === seg.fill && last.bold === seg.bold && last.italic === seg.italic) last.text += ch;
      else out.push({ ...seg, text: ch });
    }
    return out;
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Row {
  segs: Seg[];
  /** Seconds when the row appears. */
  at: number;
  /** For typed rows: column where typing starts, characters typed, and per-character times. */
  typed?: { startCol: number; times: number[]; enterAt: number };
}

/** Deterministic jitter so typing looks human but renders the same every time. */
function jitter(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function layout(steps: Step[]): { rows: Row[]; end: number; finalPromptAt: number } {
  const rows: Row[] = [];
  let t = 0.7;
  let charIndex = 0;
  const promptSegs = (): Seg[] => [
    { text: '~', fill: C.path, bold: true },
    { text: ' ❯ ', fill: C.prompt, bold: true },
  ];
  for (const step of steps) {
    if (step.kind === 'command' || step.kind === 'comment') {
      const isComment = step.kind === 'comment';
      // A blank line before the "time passes" note separates the two halves of the story.
      if (isComment) rows.push({ segs: [], at: t });
      const prefix = promptSegs();
      const startCol = 4;
      const times: number[] = [];
      const speed = isComment ? 0.032 : 0.07;
      let tt = t + 0.35;
      for (let i = 0; i < [...step.text].length; i++) {
        times.push(tt);
        tt += speed * (0.6 + jitter(charIndex++) * 0.9);
      }
      const enterAt = tt + (isComment ? 0.45 : 0.35);
      rows.push({
        segs: [...prefix, { text: step.text, fill: isComment ? C.comment : C.fg, bold: false, italic: isComment }],
        at: t,
        typed: { startCol, times, enterAt },
      });
      t = enterAt;
    } else {
      // Let the command "work" for a moment, then stream its lines.
      t += step.lines.length > 6 ? 0.75 : 0.35;
      for (const line of step.lines) {
        for (const segs of wrap(parseAnsi(line), COLS)) {
          rows.push({ segs, at: t });
          t += step.lines.length > 6 ? 0.045 : 0.12;
        }
      }
      t += 0.5;
    }
  }
  const finalPromptAt = t;
  rows.push({ segs: promptSegs(), at: finalPromptAt });
  return { rows, end: finalPromptAt, finalPromptAt };
}

function tspans(segs: Seg[]): string {
  return segs
    .map((s) => {
      const attrs = [`fill="${s.fill}"`];
      if (s.bold) attrs.push('font-weight="700"');
      if (s.italic) attrs.push('font-style="italic"');
      return `<tspan ${attrs.join(' ')}>${esc(s.text)}</tspan>`;
    })
    .join('');
}

const fmt = (n: number): string => (Math.round(n * 10000) / 10000).toString();

export function renderSvg(steps: Step[]): string {
  const { rows, end, finalPromptAt } = layout(steps);
  const HOLD = 4.5;
  const T = end + HOLD;
  const fadeAt = (T - 0.35) / T;
  const kt = (s: number): string => fmt(Math.min(Math.max(s / T, 0), 1));

  const contentW = COLS * CHAR_W;
  const winW = Math.ceil(contentW + PAD_X * 2);
  const winH = Math.ceil(TITLE_H + PAD_TOP + rows.length * LINE_H + PAD_BOTTOM);
  const W = winW + MARGIN * 2;
  const H = winH + MARGIN * 2;
  const x0 = MARGIN + PAD_X;
  const y0 = MARGIN + TITLE_H + PAD_TOP;

  const appear = (at: number): string =>
    `<animate attributeName="opacity" dur="${fmt(T)}s" repeatCount="indefinite" calcMode="discrete" values="0;1;0" keyTimes="0;${kt(at)};${fmt(fadeAt)}"/>`;

  const body: string[] = [];
  const defs: string[] = [];
  rows.forEach((row, i) => {
    const baseline = y0 + i * LINE_H + 14;
    const text = `<text x="${x0}" y="${baseline}" xml:space="preserve">${tspans(row.segs)}</text>`;
    if (!row.typed) {
      body.push(`<g opacity="1">${appear(row.at)}${text}</g>`);
      return;
    }
    // Typed rows: reveal through a clip rectangle that grows one character at a time.
    const { startCol, times, enterAt } = row.typed;
    const full = contentW + 40;
    const widths = [0, startCol * CHAR_W, ...times.map((_, k) => (startCol + k + 1) * CHAR_W), full, 0];
    const keys = [0, kt(row.at), ...times.map((s) => kt(s)), kt(enterAt), fmt(fadeAt)];
    defs.push(
      `<clipPath id="type${i}"><rect x="${x0 - 2}" y="${baseline - 15}" height="${LINE_H + 2}" width="${full}">` +
        `<animate attributeName="width" dur="${fmt(T)}s" repeatCount="indefinite" calcMode="discrete" values="${widths.map(fmt).join(';')}" keyTimes="${keys.join(';')}"/>` +
        `</rect></clipPath>`,
    );
    body.push(`<g clip-path="url(#type${i})">${text}</g>`);
    // A block cursor that follows the typing until Enter.
    // x before typing, then after each character: one value per key time.
    const startX = x0 + startCol * CHAR_W;
    const xs = [startX, startX, ...times.map((_, k) => x0 + (startCol + k + 1) * CHAR_W)];
    const cursorKeys = [0, kt(row.at), ...times.map((s) => kt(s))];
    body.push(
      `<rect x="${fmt(startX)}" y="${baseline - 13}" width="${fmt(CHAR_W)}" height="17" rx="1.5" fill="${C.cursor}" opacity="0">` +
        `<animate attributeName="opacity" dur="${fmt(T)}s" repeatCount="indefinite" calcMode="discrete" values="0;0.85;0" keyTimes="0;${kt(row.at)};${kt(enterAt)}"/>` +
        `<animate attributeName="x" dur="${fmt(T)}s" repeatCount="indefinite" calcMode="discrete" values="${xs.map(fmt).join(';')}" keyTimes="${cursorKeys.join(';')}"/>` +
        `</rect>`,
    );
  });
  // Blinking cursor at the final prompt.
  const lastBaseline = y0 + (rows.length - 1) * LINE_H + 14;
  body.push(
    `<g opacity="1">${appear(finalPromptAt)}<rect x="${fmt(x0 + 4 * CHAR_W)}" y="${lastBaseline - 13}" width="${fmt(CHAR_W)}" height="17" rx="1.5" fill="${C.cursor}">` +
      `<animate attributeName="opacity" dur="1.1s" repeatCount="indefinite" calcMode="discrete" values="0.85;0" keyTimes="0;0.5"/></rect></g>`,
  );

  const dots = [C.high, C.notable, C.prompt]
    .map((c, k) => `<circle cx="${MARGIN + 20 + k * 20}" cy="${MARGIN + TITLE_H / 2}" r="6" fill="${c}" opacity="0.9"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
<title id="title">updiff demo</title>
<desc id="desc">A terminal runs "updiff snapshot", the app Lumen updates to 4.3.0, then "updiff check" reports 4 high findings: a new camera prompt, the camera entitlement, a background agent that starts at login and a login item; and 3 notable ones: an Electron upgrade, a new analytics package and a new domain.</desc>
<defs>
<filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#000" flood-opacity="0.35"/></filter>
<linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c212a"/><stop offset="1" stop-color="${C.titlebar}"/></linearGradient>
${defs.join('\n')}
</defs>
<g filter="url(#shadow)">
<rect x="${MARGIN}" y="${MARGIN}" width="${winW}" height="${winH}" rx="12" fill="${C.window}" stroke="${C.border}"/>
</g>
<path d="M${MARGIN + 12},${MARGIN} h${winW - 24} a12,12 0 0 1 12,12 v${TITLE_H - 12} h-${winW} v-${TITLE_H - 12} a12,12 0 0 1 12,-12 z" fill="url(#bar)"/>
<line x1="${MARGIN}" y1="${MARGIN + TITLE_H}" x2="${MARGIN + winW}" y2="${MARGIN + TITLE_H}" stroke="${C.border}"/>
${dots}
<text x="${MARGIN + winW / 2}" y="${MARGIN + TITLE_H / 2 + 4.5}" text-anchor="middle" fill="${C.dim}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="12.5" font-weight="600">updiff — zsh</text>
<g font-family="'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'DejaVu Sans Mono', Consolas, 'Liberation Mono', monospace" font-size="${FONT_SIZE}">
${body.join('\n')}
</g>
</svg>
`;
}

const transcript = JSON.parse(readFileSync(join(import.meta.dirname, 'transcript.json'), 'utf8')) as { steps: Step[] };
const out = join(import.meta.dirname, '..', '..', 'docs', 'demo.svg');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderSvg(transcript.steps));
process.stdout.write(`Wrote ${out} (${(readFileSync(out).length / 1024).toFixed(1)} KB)\n`);

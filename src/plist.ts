import { run } from './exec.ts';

export type PlistValue =
  | string
  | number
  | boolean
  | PlistValue[]
  | { [key: string]: PlistValue };

export type PlistDict = { [key: string]: PlistValue };

interface Token {
  kind: 'open' | 'close' | 'empty' | 'text';
  name: string;
  text: string;
}

const TOKEN_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z][\w.-]*)[^>]*?(\/?)>|([^<]+)/g;

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  for (const m of xml.matchAll(TOKEN_RE)) {
    if (m[2]) {
      const kind = m[1] ? 'close' : m[3] ? 'empty' : 'open';
      tokens.push({ kind, name: m[2], text: '' });
    } else if (m[4] !== undefined) {
      tokens.push({ kind: 'text', name: '', text: m[4] });
    }
  }
  return tokens;
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    switch (e) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
  });
}

class Parser {
  private i = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private next(): Token | undefined {
    // Whitespace between elements carries no meaning in a plist.
    while (this.i < this.tokens.length) {
      const t = this.tokens[this.i++]!;
      if (t.kind === 'text' && t.text.trim() === '') continue;
      return t;
    }
    return undefined;
  }

  private readText(name: string): string {
    let text = '';
    while (this.i < this.tokens.length) {
      const t = this.tokens[this.i++]!;
      if (t.kind === 'text') text += t.text;
      else if (t.kind === 'close' && t.name === name) return decodeEntities(text);
      else throw new Error(`Unexpected <${t.name}> inside <${name}>`);
    }
    throw new Error(`Unterminated <${name}>`);
  }

  parseDocument(): PlistValue | undefined {
    const first = this.next();
    if (!first) return undefined;
    if (first.kind === 'open' && first.name === 'plist') {
      const inner = this.next();
      if (!inner || (inner.kind === 'close' && inner.name === 'plist')) return undefined;
      return this.parseValue(inner);
    }
    if (first.kind === 'empty' && first.name === 'plist') return undefined;
    return this.parseValue(first);
  }

  parseValue(t: Token): PlistValue {
    if (t.kind === 'empty') {
      switch (t.name) {
        case 'true':
          return true;
        case 'false':
          return false;
        case 'dict':
          return {};
        case 'array':
          return [];
        case 'string':
        case 'data':
        case 'date':
          return '';
        default:
          throw new Error(`Unsupported empty element <${t.name}/>`);
      }
    }
    if (t.kind !== 'open') throw new Error(`Expected a value, got ${t.kind} ${t.name || t.text.trim()}`);
    switch (t.name) {
      case 'string':
      case 'date':
        return this.readText(t.name);
      case 'data':
        return `data:${this.readText('data').replace(/\s+/g, '')}`;
      case 'integer':
      case 'real':
        return Number(this.readText(t.name).trim());
      case 'dict': {
        const out: PlistDict = {};
        for (;;) {
          const k = this.next();
          if (!k) throw new Error('Unterminated <dict>');
          if (k.kind === 'close' && k.name === 'dict') return out;
          let key = '';
          if (k.kind === 'open' && k.name === 'key') key = this.readText('key');
          else if (!(k.kind === 'empty' && k.name === 'key')) throw new Error(`Expected <key>, got <${k.name}>`);
          const v = this.next();
          if (!v) throw new Error(`Missing value for key ${key}`);
          out[key] = this.parseValue(v);
        }
      }
      case 'array': {
        const out: PlistValue[] = [];
        for (;;) {
          const v = this.next();
          if (!v) throw new Error('Unterminated <array>');
          if (v.kind === 'close' && v.name === 'array') return out;
          out.push(this.parseValue(v));
        }
      }
      default:
        throw new Error(`Unsupported element <${t.name}>`);
    }
  }
}

/** Parses an XML property list. Returns undefined for an empty document. */
export function parsePlistXml(xml: string): PlistValue | undefined {
  return new Parser(tokenize(xml)).parseDocument();
}

/** Reads a plist in any format (XML, binary or JSON) through `plutil`. */
export async function readPlistFile(path: string): Promise<PlistDict | undefined> {
  const res = await run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', path]);
  if (res.code !== 0) return undefined;
  const value = parsePlistXml(res.stdout);
  return isDict(value) ? value : undefined;
}

export function isDict(v: PlistValue | undefined): v is PlistDict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: PlistValue | undefined): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function serialize(v: PlistValue, indent: string): string {
  if (typeof v === 'string') return `${indent}<string>${escapeXml(v)}</string>`;
  if (typeof v === 'boolean') return `${indent}<${v}/>`;
  if (typeof v === 'number') return Number.isInteger(v) ? `${indent}<integer>${v}</integer>` : `${indent}<real>${v}</real>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `${indent}<array/>`;
    return [`${indent}<array>`, ...v.map((x) => serialize(x, indent + '\t')), `${indent}</array>`].join('\n');
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return `${indent}<dict/>`;
  const lines = [`${indent}<dict>`];
  for (const k of keys) {
    lines.push(`${indent}\t<key>${escapeXml(k)}</key>`);
    lines.push(serialize(v[k]!, indent + '\t'));
  }
  lines.push(`${indent}</dict>`);
  return lines.join('\n');
}

/** Serialises a value as an XML property list. */
export function toPlistXml(v: PlistValue): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    serialize(v, ''),
    '</plist>',
    '',
  ].join('\n');
}

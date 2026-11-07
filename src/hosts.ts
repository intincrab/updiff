import type { HostRecord } from './types.ts';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = `(?:${LABEL}\\.)+[a-z][a-z0-9-]{0,22}[a-z0-9]`;

/** A host after a URL scheme, optionally with user info. */
const URL_RE = new RegExp(
  `\\b(?:https?|wss?|ftp)://(?:[^\\s"'<>/@\\\\]{1,64}@)?(${HOSTNAME})(?![a-z0-9-])`,
  'gi',
);

/** A hostname alone inside a string literal: "events.vendor.io". */
const LITERAL_RE = new RegExp(`["'\`](${HOSTNAME})["'\`]`, 'gi');

/**
 * Top-level domains accepted for bare string literals. Kept short on purpose: bare
 * strings like "Foo.app", "README.md" and "build.sh" would otherwise read as hosts.
 * Hosts that follow a URL scheme accept any alphabetic top-level domain.
 */
const LITERAL_TLDS = new Set(
  (
    'com net org io ai dev co me us uk de fr nl se no fi dk es it pt pl ch at be ie jp cn kr tw hk sg in au nz ca br mx ' +
    'ru ua cz hu ro gr tr il za eu info biz tv cloud xyz gg ly so to fm gl im ac cc edu gov mil int'
  ).split(' '),
);

/** Exact hosts and suffixes that are namespaces, documentation placeholders or reserved names. */
const IGNORED_HOSTS = new Set([
  'www.w3.org',
  'w3.org',
  'schemas.xmlsoap.org',
  'schemas.microsoft.com',
  'schemas.openxmlformats.org',
  'ns.adobe.com',
  'purl.org',
  'xmlns.com',
  'json-schema.org',
  'example.com',
  'example.net',
  'example.org',
  'www.example.com',
  'www.example.net',
  'www.example.org',
]);
const IGNORED_SUFFIXES = ['.localhost', '.local', '.test', '.invalid', '.example', '.internal', '.lan', '.home.arpa'];

export function isIgnoredHost(host: string): boolean {
  if (host === 'localhost' || IGNORED_HOSTS.has(host)) return true;
  return IGNORED_SUFFIXES.some((s) => host.endsWith(s));
}

function tldOf(host: string): string {
  return host.slice(host.lastIndexOf('.') + 1);
}

/**
 * Suffixes under which each subdomain belongs to a different owner. A short,
 * hand-picked part of the Public Suffix List that covers the common cases.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'co.kr', 'or.kr', 'go.kr',
  'co.nz', 'org.nz', 'govt.nz',
  'com.mx', 'com.tr', 'com.tw', 'com.hk', 'com.sg', 'com.my', 'com.ar', 'com.co', 'com.vn', 'com.ph', 'com.pk',
  'co.za', 'co.il', 'co.id', 'co.th',
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'herokuapp.com',
  'appspot.com', 'web.app', 'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net', 'blob.core.windows.net',
  's3.amazonaws.com', 'fly.dev', 'onrender.com', 'ngrok.io', 'ngrok-free.app', 'r2.dev', 'supabase.co',
]);

/** The domain a host belongs to: `api.eu.vendor.co.uk` → `vendor.co.uk`. */
export function registrableDomain(host: string): string {
  const labels = host.split('.');
  for (let take = Math.min(4, labels.length - 1); take >= 2; take--) {
    const suffix = labels.slice(-take).join('.');
    if (MULTI_PART_SUFFIXES.has(suffix)) return labels.slice(-(take + 1)).join('.');
  }
  return labels.slice(-2).join('.');
}

export type HostMap = Map<string, HostRecord>;

function add(map: HostMap, host: string, where: string, viaUrl: boolean): void {
  const rec = map.get(host);
  if (rec) {
    rec.count++;
    rec.viaUrl ||= viaUrl;
    if (rec.where.length < 3 && !rec.where.includes(where)) rec.where.push(where);
  } else {
    map.set(host, { count: 1, viaUrl, where: [where] });
  }
}

function cleanHost(raw: string): string {
  return raw.toLowerCase().replace(/\.$/, '');
}

/** Finds hostnames in text (source code, JSON, HTML, or a binary read as latin1). */
export function extractHosts(text: string, where: string, into: HostMap = new Map(), literals = true): HostMap {
  for (const m of text.matchAll(URL_RE)) {
    const host = cleanHost(m[1]!);
    if (!/[a-z]/.test(tldOf(host)) || isIgnoredHost(host)) continue;
    add(into, host, where, true);
  }
  if (literals) {
    for (const m of text.matchAll(LITERAL_RE)) {
      const host = cleanHost(m[1]!);
      if (!LITERAL_TLDS.has(tldOf(host)) || isIgnoredHost(host)) continue;
      // "this.is" / "e.g" style tokens: a one-letter first label is rarely a real host.
      if (/^[a-z]\./.test(host) && host.split('.').length === 2) continue;
      add(into, host, where, false);
    }
  }
  return into;
}

export function mergeHosts(into: HostMap, from: HostMap): HostMap {
  for (const [host, rec] of from) {
    const cur = into.get(host);
    if (!cur) into.set(host, { count: rec.count, viaUrl: rec.viaUrl, where: [...rec.where] });
    else {
      cur.count += rec.count;
      cur.viaUrl ||= rec.viaUrl;
      for (const w of rec.where) if (cur.where.length < 3 && !cur.where.includes(w)) cur.where.push(w);
    }
  }
  return into;
}

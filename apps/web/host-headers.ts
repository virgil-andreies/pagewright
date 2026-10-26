// Reads public/_headers, the response headers the host (Cloudflare) adds, so the local preview server and the
// live-site check apply and expect exactly the same ones. Only the parts of the format the file uses: a path pattern
// on its own line, then indented `Name: value` lines; `*` matches anything, `:name` one path segment; `#` comments.
// As on Cloudflare, every matching rule applies, and a header set by two rules gets both values, comma-separated.
import { readFileSync } from 'node:fs';

export interface HeaderRule {
  pattern: string;
  matches: RegExp;
  headers: [name: string, value: string][];
}

export function readHeaderRules(file: string | URL): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const source = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:[A-Za-z]\w*/g, '[^/]+');
      rules.push({ pattern: line.trim(), matches: new RegExp(`^${source}$`), headers: [] });
    } else {
      const at = line.indexOf(':');
      const rule = rules.at(-1);
      if (!rule || at < 0) throw new Error(`_headers: cannot read the line "${line.trim()}"`);
      rule.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  return rules;
}

/** The headers the host adds to a response for this path. */
export function headersFor(rules: HeaderRule[], path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rules) {
    if (!rule.matches.test(path)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      out.set(key, out.has(key) ? `${out.get(key)}, ${value}` : value);
    }
  }
  return out;
}

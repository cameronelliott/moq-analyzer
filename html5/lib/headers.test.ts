// _headers is for Cloudflare Pages, and nothing here can ask Pages. This
// checks what can be checked: the rules cover the names Bun gives the hashed
// files, and no rule reaches a file that has no hash.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IMMUTABLE = 'Cache-Control: public, max-age=31536000, immutable';

/** The path rules of a _headers file, each with its header lines. */
function rules(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let headers: string[] | undefined;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (line.startsWith('/')) {
      headers = [];
      out.set(line.trim(), headers);
    } else {
      if (!headers) throw new Error(`a header before any path: ${line}`);
      headers.push(line.trim());
    }
  }
  return out;
}

const RULES = rules(readFileSync(join(import.meta.dir, '..', '_headers'), 'utf8'));

/** Whether a rule's path takes a URL path: one `*` at the end takes the rest. */
const matches = (rule: string, path: string) =>
  rule.endsWith('*') ? path.startsWith(rule.slice(0, -1)) : rule === path;
const rulesFor = (path: string) => [...RULES.keys()].filter((rule) => matches(rule, path));

test('every hashed file Bun writes is kept for good', () => {
  for (const path of [
    '/duckdb-eh.wasm-76y4pd11.gz',
    '/duckdb-browser-eh.worker-9a4pqcrs.js',
    '/index-g7r9v3g3.js',
    '/index-a9j37hb7.css',
  ]) {
    const hit = rulesFor(path);
    expect([path, hit.length]).toEqual([path, 1]);
    expect(RULES.get(hit[0] ?? '')).toEqual([IMMUTABLE]);
  }
});

test('files with no hash in the name keep the default', () => {
  for (const path of [
    '/', '/index.html', '/_headers',
    '/showcase/vanilla/8dac41349bb96aebec844f3445be943e_server.mlog.gz',
  ]) {
    expect([path, rulesFor(path)]).toEqual([path, []]);
  }
});

test('each rule is one path with one splat at the end, inside the limits of Pages', () => {
  expect(RULES.size).toBeLessThanOrEqual(100);
  for (const rule of RULES.keys()) {
    expect(rule).toMatch(/^\/[^*\s]+\*$/);
    expect(rule.length).toBeLessThan(2000);
  }
});

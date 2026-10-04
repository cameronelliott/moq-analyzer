import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHOWCASES, showcaseById, showcaseFiles, type Showcase } from './showcase';
import { tracesFromFiles } from './trace-files';

const DIR = join(import.meta.dir, '..', 'showcase');
const GZIP = Bun.gzipSync('\x1e{"a":1}\n');

test('the list and the files on disk are the same, and every file is gzip', () => {
  for (const s of SHOWCASES) {
    expect([...s.files].sort()).toEqual(readdirSync(join(DIR, s.id)).sort());
    for (const f of s.files) {
      const bytes = readFileSync(join(DIR, s.id, f));
      expect([f, bytes[0], bytes[1]]).toEqual([f, 0x1f, 0x8b]);
    }
  }
});

test('every showcase file has a name the loader takes', async () => {
  for (const s of SHOWCASES) {
    const { traces, rejected } = tracesFromFiles(s.files.map((f) => new File([GZIP], f)));
    expect(rejected).toEqual([]);
    expect(traces.length).toBe(s.files.length);
    // Each trace holds an open gunzip pipe; read it to its end.
    for (const t of traces) await new Response(t.stream).text();
  }
});

test('ids are unique, and showcaseById finds one or nothing', () => {
  expect(new Set(SHOWCASES.map((s) => s.id)).size).toBe(SHOWCASES.length);
  expect(showcaseById('vanilla')?.id).toBe('vanilla');
  expect(showcaseById('nope')).toBeUndefined();
  expect(showcaseById(null)).toBeUndefined();
});

const one: Showcase = { id: 'x', title: 'X', about: '', files: ['a_client.mlog.gz', 'a_server.mlog.gz'] };

test('files are fetched from showcase/<id>/, in order, and progress counts them', async () => {
  const asked: string[] = [];
  const seen: [number, number][] = [];
  const files = await showcaseFiles(one, async (url) => {
    asked.push(url);
    return new Response(GZIP);
  }, (done, of) => seen.push([done, of]));
  expect(asked).toEqual(['./showcase/x/a_client.mlog.gz', './showcase/x/a_server.mlog.gz']);
  expect(files.map((f) => f.name)).toEqual([...one.files]);
  expect(seen).toEqual([[1, 2], [2, 2]]);
  expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(GZIP);
});

test('a server that already removed the gzip gives a file named without .gz', async () => {
  // Some hosts send a .gz with Content-Encoding: gzip, and the browser then
  // hands over plain bytes. The loader picks gzip by name, so the name must
  // say what the bytes are.
  const files = await showcaseFiles(one, async () => new Response('\x1e{"a":1}\n'));
  expect(files.map((f) => f.name)).toEqual(['a_client.mlog', 'a_server.mlog']);
});

test('a file that cannot be fetched fails by name', async () => {
  const failure = await showcaseFiles(one, async () => new Response('', { status: 404 }))
    .then(() => 'no error', (e: unknown) => (e instanceof Error ? e.message : String(e)));
  expect(failure).toBe('a_client.mlog.gz: HTTP 404');
});

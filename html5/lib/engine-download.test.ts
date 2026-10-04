import { expect, test } from 'bun:test';
import { engineStatus, fetchWasm } from './engine-download';

// Not a real module: the magic number, then bytes that gzip well.
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, ...new Array<number>(5000).fill(7)]);
const GZ = Bun.gzipSync(WASM);

/** A response whose body arrives in pieces, with or without a Content-Length. */
function inPieces(bytes: Uint8Array<ArrayBuffer>, piece: number, withLength = true): Response {
  let at = 0;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(ctl) {
      if (at >= bytes.length) return ctl.close();
      ctl.enqueue(bytes.slice(at, at + piece));
      at += piece;
    },
  });
  return new Response(body, withLength ? { headers: { 'content-length': String(bytes.length) } } : {});
}

test('a gzipped module comes back as the wasm bytes, typed as wasm, with progress', async () => {
  const seen: [number, number | null][] = [];
  const asked: string[] = [];
  const blob = await fetchWasm('./duckdb.wasm.gz', async (url) => {
    asked.push(url);
    return inPieces(GZ, 10);
  }, (loaded, total) => seen.push([loaded, total]));

  expect(asked).toEqual(['./duckdb.wasm.gz']);
  expect(blob.type).toBe('application/wasm');
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(WASM);
  // Progress counts the bytes on the wire, in order, and ends at the whole.
  expect(seen.length).toBeGreaterThan(1);
  expect(seen.map(([loaded]) => loaded)).toEqual([...seen.map(([loaded]) => loaded)].sort((a, b) => a - b));
  expect(seen.at(-1)).toEqual([GZ.length, GZ.length]);
});

test('a host that already removed the gzip: the bytes pass through', async () => {
  // Content-Length is then the compressed size, and more bytes arrive than it
  // says. The total grows with them, so progress never passes 100%.
  const seen: [number, number | null][] = [];
  const response = inPieces(WASM, 1000, false);
  response.headers.set('content-length', String(GZ.length));
  const blob = await fetchWasm('./duckdb.wasm.gz', async () => response, (l, t) => seen.push([l, t]));
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(WASM);
  expect(blob.type).toBe('application/wasm');
  for (const [loaded, total] of seen) expect(loaded).toBeLessThanOrEqual(total ?? 0);
});

test('no Content-Length: progress has no total', async () => {
  const seen: [number, number | null][] = [];
  await fetchWasm('./x', async () => inPieces(GZ, 20, false), (l, t) => seen.push([l, t]));
  expect(seen.at(-1)).toEqual([GZ.length, null]);
});

test('a failed download says so', async () => {
  const failure = await fetchWasm('./x', async () => new Response('', { status: 404 }), () => {})
    .then(() => 'no error', (e: unknown) => (e instanceof Error ? e.message : String(e)));
  expect(failure).toBe('HTTP 404 for ./x');
});

test('status line: percent while downloading, then starting, then ready', () => {
  expect(engineStatus({ stage: 'download', loaded: 0, total: 8_057_786 }))
    .toEqual({ text: 'Analyzer engine: downloading, 0% of 8.1 MB', fraction: 0 });
  expect(engineStatus({ stage: 'download', loaded: 3_500_000, total: 8_057_786 }))
    .toEqual({ text: 'Analyzer engine: downloading, 43% of 8.1 MB', fraction: 3_500_000 / 8_057_786 });
  expect(engineStatus({ stage: 'download', loaded: 3_500_000, total: null }))
    .toEqual({ text: 'Analyzer engine: downloading, 3.5 MB', fraction: null });
  expect(engineStatus({ stage: 'start' })).toEqual({ text: 'Analyzer engine: starting…', fraction: null });
  expect(engineStatus({ stage: 'ready' })).toEqual({ text: 'Analyzer engine ready.', fraction: 1 });
  expect(engineStatus({ stage: 'failed', message: 'HTTP 404 for ./x' }).text)
    .toBe('Analyzer engine did not start (HTTP 404 for ./x). It starts again when you load files.');
});

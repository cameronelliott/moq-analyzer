import { expect, test } from 'bun:test';
import { plainSize, tracesFromFiles } from './trace-files';

const file = (name: string, body: string | Uint8Array<ArrayBuffer> = '') => new File([body], name);

test('cid and trace name come from the file name', () => {
  const { traces, rejected } = tracesFromFiles([
    file('abc-1_server.mlog'),
    file('abc-1_client.mlog.gz', Bun.gzipSync('x')),
  ]);
  expect(rejected).toEqual([]);
  expect(traces.map((t) => [t.name, t.cid])).toEqual([
    ['abc-1_client.mlog', 'abc-1'],
    ['abc-1_server.mlog', 'abc-1'],
  ]);
});

test('a cid may hold underscores; the last one splits off the role', () => {
  const { traces } = tracesFromFiles([file('a_b_client.mlog')]);
  expect(traces[0]?.cid).toBe('a_b');
});

test('names that do not fit are rejected with a reason', () => {
  const { traces, rejected } = tracesFromFiles([
    file('notes.txt'),
    file('abc_relay.mlog'),
    file('a b_client.mlog'),
  ]);
  expect(traces).toEqual([]);
  expect(rejected.map((r) => r.file)).toEqual(['a b_client.mlog', 'abc_relay.mlog', 'notes.txt']);
});

test('two files with one trace name: the second is rejected', () => {
  const { traces, rejected } = tracesFromFiles([
    file('abc_client.mlog'),
    file('abc_client.mlog.gz', Bun.gzipSync('x')),
  ]);
  expect(traces.map((t) => t.name)).toEqual(['abc_client.mlog']);
  expect(rejected.map((r) => r.file)).toEqual(['abc_client.mlog.gz']);
});

test('plainSize: a plain file is its size, a .gz is what it unpacks to', async () => {
  expect(await plainSize(file('p_client.mlog', 'x'.repeat(300)))).toBe(300);
  expect(await plainSize(file('q_client.mlog.gz', Bun.gzipSync('x'.repeat(100_000))))).toBe(100_000);
  expect(await plainSize(file('empty_client.mlog.gz', Bun.gzipSync('')))).toBe(0);
  // Too short to be gzip at all: its own size, and the load reports the real fault.
  expect(await plainSize(file('bad_client.mlog.gz', 'abc'))).toBe(3);
});

test('accepted is the file behind each trace, in order, rejected files left out', () => {
  const { traces, accepted } = tracesFromFiles([
    file('q_client.mlog.gz', Bun.gzipSync('x')),
    file('notes.txt'),
    file('p_client.mlog'),
  ]);
  expect(accepted.map((f) => f.name)).toEqual(['p_client.mlog', 'q_client.mlog.gz']);
  expect(traces.map((t) => t.name)).toEqual(['p_client.mlog', 'q_client.mlog']);
});

test('onBytes hears the plain bytes of each trace as it is read, and nothing before', async () => {
  const body = '\x1e{"a":1}\n'.repeat(20_000);
  let heard = 0;
  const { traces, accepted } = tracesFromFiles(
    [file('p_client.mlog', body), file('q_client.mlog.gz', Bun.gzipSync(body))],
    (n) => { heard += n; },
  );
  const [plain, gz] = traces;
  if (!plain || !gz) throw new Error('two traces expected');

  // No trace is opened until it is read, so the second waits for the first.
  await new Promise((r) => setTimeout(r, 20));
  expect(heard).toBe(0);
  expect(await new Response(plain.stream).text()).toBe(body);
  expect(heard).toBe(body.length);
  expect(await new Response(gz.stream).text()).toBe(body);
  // A .gz counts what it unpacks to, so the whole is what plainSize() adds up to.
  expect(heard).toBe(2 * body.length);
  expect((await Promise.all(accepted.map(plainSize))).reduce((a, b) => a + b, 0)).toBe(heard);
});

test('a gzipped trace is not read ahead of its reader', async () => {
  // The bug this guards: gunzip pulled a whole file in at once, and the bar
  // read 66% in the first tenth of a second of a ten-second load.
  const body = '\x1e{"a":1}\n'.repeat(200_000);   // 1.8 MB plain
  let heard = 0;
  const { traces } = tracesFromFiles([file('q_client.mlog.gz', Bun.gzipSync(body))], (n) => { heard += n; });
  const reader = traces[0]?.stream.getReader();
  if (!reader) throw new Error('one trace expected');
  const first = await reader.read();
  await new Promise((r) => setTimeout(r, 50));
  expect(heard).toBe(first.value?.length ?? -1);
  expect(heard).toBeLessThan(body.length);
  await reader.cancel();
});

test('the stream is plain mlog bytes, gzip removed', async () => {
  const body = '\x1e{"a":1}\n';
  const { traces } = tracesFromFiles([
    file('p_client.mlog', body),
    file('q_client.mlog.gz', Bun.gzipSync(body)),
  ]);
  for (const t of traces) expect(await new Response(t.stream).text()).toBe(body);
});

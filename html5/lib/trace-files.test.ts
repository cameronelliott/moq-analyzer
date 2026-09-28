import { expect, test } from 'bun:test';
import { tracesFromFiles } from './trace-files';

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

test('the stream is plain mlog bytes, gzip removed', async () => {
  const body = '\x1e{"a":1}\n';
  const { traces } = tracesFromFiles([
    file('p_client.mlog', body),
    file('q_client.mlog.gz', Bun.gzipSync(body)),
  ]);
  for (const t of traces) expect(await new Response(t.stream).text()).toBe(body);
});

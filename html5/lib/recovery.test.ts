import { expect, test } from 'bun:test';
import { RECOVERED_DWELL, type RecoveryRow } from 'mlog-sql';
import { recoveryNotice, recoveryTable } from './recovery';

const logged: RecoveryRow = {
  cid: 'c45a526b08ad99ea276b9813b0f66ac5', trace: 'c45a526b_server.mlog', vantage_point: 'server',
  stream_ids: 'logged', stream_ids_uncertain: null, stream_ids_unresolved: null,
  reference_time: 'logged', clock_matched: null, clock_near_floor: null,
};

// A stock moq-rs relay: the inbound trace keeps no time base, the outbound one is lined up.
const inbound: RecoveryRow = {
  ...logged, stream_ids: 'recovered', stream_ids_uncertain: 3, stream_ids_unresolved: 0,
  reference_time: 'none',
};
const outbound: RecoveryRow = {
  ...inbound, cid: '8dac41349bb96aebec844f3445be943e', trace: '8dac4134_server.mlog',
  stream_ids_uncertain: 0, reference_time: 'recovered', clock_matched: 1545, clock_near_floor: 12,
};

test('a capture with everything logged has no notice', () => {
  expect(recoveryNotice([logged, logged]).text).toBe('');
  expect(recoveryNotice([]).text).toBe('');
});

test('a stock capture says what was recovered, with the note from mlog-sql', () => {
  const text = recoveryNotice([inbound, outbound]).text;
  expect(text).toContain('<wa-callout variant="neutral">');
  expect(text).toContain('Stream ids were recovered on 2 traces.');
  expect(text).toContain('3 objects had a second likely stream.');
  expect(text).not.toContain('could not be placed');
  // The note is mlog-sql's, escaped, not retyped here.
  expect(text).toContain(RECOVERED_DWELL.note.slice(0, 40));
  expect(text).toContain('never too high');
  expect(text).toContain('no latency for the network legs');
  expect(text).not.toContain('variant="warning"');
});

test('objects that could not be placed are counted', () => {
  const text = recoveryNotice([{ ...inbound, stream_ids_uncertain: 0, stream_ids_unresolved: 7 }]).text;
  expect(text).toContain('Stream ids were recovered on 1 trace.');
  expect(text).toContain('7 objects could not be placed and are in no measure.');
  expect(text).not.toContain('second likely stream');
});

test('a time base that rests on one or two objects gets a warning, by connection', () => {
  const text = recoveryNotice([inbound, { ...outbound, clock_near_floor: 2 }]).text;
  expect(text).toContain('<wa-callout variant="warning">');
  expect(text).toContain('8dac4134');
  expect(text).toContain('2 of 1,545 objects');
});

test('the table has one row per trace, with a dash where nothing was measured', () => {
  const text = recoveryTable([inbound, outbound]).text;
  expect(text).toContain('<td>c45a526b</td><td>server</td><td>recovered</td><td>none</td>'
    + '<td class="num">—</td><td class="num">—</td>');
  expect(text).toContain('<td>8dac4134</td><td>server</td><td>recovered</td><td>recovered</td>'
    + '<td class="num">1,545</td><td class="num">12</td>');
  expect(recoveryTable([]).text).toContain('No traces.');
});

test('text from a log is escaped', () => {
  const text = recoveryTable([{ ...logged, vantage_point: '<b>x</b>' }]).text;
  expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
});

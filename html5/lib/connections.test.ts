import { expect, test } from 'bun:test';
import type { TrustRow } from 'mlog-sql';
import { connections } from './connections';

const row: TrustRow = {
  cid: 'a5163379d342db3bb2e10e6b3db6b598', sender_is: 'server', sent: 62125, received: 61370,
  joined: 61370, lost: 0, outside_window: 755, negative_hops: 0,
};

test('the page is the markdown, with the trust table in its block', () => {
  const { html } = connections([row]);
  expect(html.text).toContain('<h1>Connections</h1>');
  expect(html.text).toContain('<div data-block="trust-table"><div class="table-scroll"><table>');
  expect(html.text).toContain('<td>a5163379</td>');
  expect(html.text).toContain('data-chart="not-joined"');
});

test('not-joined chart: lost and outside the window stacked per connection, in status colors', () => {
  const other: TrustRow = { ...row, cid: 'c45a526b08ad99ea276b9813b0f66ac5', lost: 2, outside_window: 4 };
  const option = connections([row, other]).charts['not-joined'];
  expect(option?.yAxis).toEqual(expect.objectContaining({ inverse: true, data: ['a5163379', 'c45a526b'] }));
  expect(option?.series).toEqual([
    expect.objectContaining({ name: 'lost', stack: 'not joined', color: '#dc3146', data: [0, 2] }),
    expect.objectContaining({ name: 'outside the window', stack: 'not joined', color: '#717584', data: [755, 4] }),
  ]);
});

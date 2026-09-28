import { expect, test } from 'bun:test';
import type { TrustRow } from 'mlog-sql';
import { connections } from './connections';

const row: TrustRow = {
  cid: 'a5163379d342db3bb2e10e6b3db6b598', sender_is: 'server', sent: 62125, received: 61370,
  joined: 61370, lost: 0, outside_window: 755, negative_hops: 0,
};

test('the page is the markdown, with the trust table in its block', () => {
  const { html, charts } = connections([row]);
  expect(html.text).toContain('<h1>Connections</h1>');
  expect(html.text).toContain('<div data-block="trust-table"><div class="table-scroll"><table>');
  expect(html.text).toContain('<td>a5163379</td>');
  expect(charts).toEqual({});
});

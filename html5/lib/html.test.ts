import { expect, test } from 'bun:test';
import { html } from './html';

test('values are escaped', () => {
  const v = `<img src=x onerror="alert('1')">&`;
  expect(html`<td>${v}</td>`.text)
    .toBe('<td>&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;</td>');
});

test('nested html is not escaped twice', () => {
  const inner = html`<b>${'<'}</b>`;
  expect(html`<p>${inner}</p>`.text).toBe('<p><b>&lt;</b></p>');
});

test('arrays join with nothing between; null prints nothing', () => {
  expect(html`<ul>${['<a>', html`<li>b</li>`]}</ul>${null}`.text)
    .toBe('<ul>&lt;a&gt;<li>b</li></ul>');
});

test('numbers print as String() does', () => {
  expect(html`${1.5}`.text).toBe('1.5');
});

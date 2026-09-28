import { expect, test } from 'bun:test';
import { html } from './html';
import { fillBlocks, markdown } from './markdown';

test('markdown: GFM tables, emphasis, and raw HTML placeholders pass through', () => {
  const { text } = markdown('# T\n\nSome **bold**.\n\n<div data-block="x"></div>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
  expect(text).toContain('<h1>T</h1>');
  expect(text).toContain('<strong>bold</strong>');
  expect(text).toContain('<div data-block="x"></div>');
  expect(text).toContain('<td>1</td>');
});

test('fillBlocks: each placeholder gets its block, escaped as its own html', () => {
  const page = markdown('<div data-block="a"></div>\n\ntext\n\n<div data-block="b"></div>\n');
  const { text } = fillBlocks(page, { a: html`<p>${'<A>'}</p>`, b: html`<p>B</p>` });
  expect(text).toContain('<div data-block="a"><p>&lt;A&gt;</p></div>');
  expect(text).toContain('<div data-block="b"><p>B</p></div>');
});

test('fillBlocks: a placeholder with no block throws, naming it', () => {
  const page = markdown('<div data-block="a"></div>\n');
  expect(() => fillBlocks(page, {})).toThrow('a');
});

test('fillBlocks: a block with no placeholder throws, naming it', () => {
  const page = markdown('text\n');
  expect(() => fillBlocks(page, { stray: html`x` })).toThrow('stray');
});

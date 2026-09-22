import { expect, test, describe } from 'bun:test';

import { buildDoc, navHtml } from './build.js';
import { CHART_TAG } from './chart-option.js';
import { createMarkdownRenderer } from './markdown.js';

const DOC = `# A Title

Some prose.

## First section

\`\`\`echarts
{ series: [{ type: 'line', data: [1, 2] }] }
\`\`\`

## Second section

\`\`\`echarts
{ series: [{ type: 'bar' }, { type: 'line' }] }
\`\`\`

\`\`\`js
not a chart
\`\`\`
`;

describe('buildDoc', () => {
  test('the title is the first h1', () => {
    expect(buildDoc(DOC).title).toBe('A Title');
  });

  test('no h1 means no title, not a crash', () => {
    expect(buildDoc('## Only an h2\n').title).toBe('');
  });

  test('headings come back in document order', () => {
    expect(buildDoc(DOC).headings.map((h) => h.id))
      .toEqual(['a-title', 'first-section', 'second-section']);
  });

  test('every echarts fence is found, and only those', () => {
    expect(buildDoc(DOC).charts).toHaveLength(2);
  });

  test('the series census covers the whole document', () => {
    expect(buildDoc(DOC).seriesTypes).toEqual(['bar', 'line']);
  });

  test('a fence inside a list is still found', () => {
    const md = "- a list item\n\n  ```echarts\n  { series: [{ type: 'pie' }] }\n  ```\n";
    expect(buildDoc(md).seriesTypes).toEqual(['pie']);
  });

  test('a broken fence is reported, not thrown', () => {
    const md = '```echarts\n{ nope ]]\n```\n';
    const { errors, charts } = buildDoc(md);
    expect(errors).toHaveLength(1);
    expect(charts[0].error).toBeTruthy();
    expect(charts[0].source).toBe('{ nope ]]');
  });

  test('every broken fence is reported, not just the first', () => {
    const md = '```echarts\n{ nope ]]\n```\n\n```echarts\n{ also ]]\n```\n';
    expect(buildDoc(md).errors).toHaveLength(2);
  });

  test('a good document has no errors', () => {
    expect(buildDoc(DOC).errors).toEqual([]);
  });

  test('the body carries chart elements, not fences', () => {
    const { html } = buildDoc(DOC);
    expect(html).toContain(`<${CHART_TAG} config="`);
    expect(html).toContain('<h2 id="first-section">');
  });

  // The invariant behind having one renderer: a document pre-rendered by the
  // build and the same document rendered live by <app-markdown> must produce
  // identical HTML. This fails the moment buildDoc starts post-processing.
  test('build-time HTML matches what the runtime renderer produces', () => {
    expect(buildDoc(DOC).html).toBe(createMarkdownRenderer().render(DOC).body);
  });

  test('successive calls do not leak state', () => {
    buildDoc(DOC);
    const second = buildDoc('# Just This\n');
    expect(second.headings).toHaveLength(1);
    expect(second.charts).toEqual([]);
    expect(second.seriesTypes).toEqual([]);
  });
});

describe('navHtml', () => {
  test('h2 by default, with the drawer hook bindNav also sets', () => {
    expect(navHtml(buildDoc(DOC).headings)).toBe(
      '<a href="#first-section" data-drawer="close">First section</a>\n'
      + '<a href="#second-section" data-drawer="close">Second section</a>');
  });

  test('the depth is selectable', () => {
    expect(navHtml(buildDoc(DOC).headings, { depth: 1 }))
      .toBe('<a href="#a-title" data-drawer="close">A Title</a>');
  });

  test('no headings at that depth is empty, not broken', () => {
    expect(navHtml(buildDoc(DOC).headings, { depth: 6 })).toBe('');
  });

  test('heading text is escaped', () => {
    // bindNav sets textContent and the DOM escapes for it; this has to match.
    const html = navHtml([{ depth: 2, id: 'x', text: 'Tom & <b>Jerry</b>' }]);
    expect(html).toContain('Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });
});

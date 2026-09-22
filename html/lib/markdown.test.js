import { expect, test, describe } from 'bun:test';

import { CHART_TAG } from './chart-option.js';
import { createMarkdownRenderer } from './markdown.js';

describe('createMarkdownRenderer', () => {
  test('gives headings ids and reports them', () => {
    const { body, headings } = createMarkdownRenderer().render('# One\n\n## Two Words\n');
    expect(body).toContain('<h1 id="one">One</h1>');
    expect(body).toContain('<h2 id="two-words">Two Words</h2>');
    expect(headings).toEqual([
      { depth: 1, id: 'one', text: 'One' },
      { depth: 2, id: 'two-words', text: 'Two Words' },
    ]);
  });

  test('a slug drops inline markup but the heading keeps it', () => {
    const { body, headings } = createMarkdownRenderer().render('## What `code` costs\n');
    expect(headings[0].id).toBe('what-code-costs');
    expect(headings[0].text).toBe('What code costs');
    expect(body).toContain('<code>code</code>');
  });

  test('an echarts fence becomes an element carrying its source', () => {
    const { body } = createMarkdownRenderer().render("```echarts\n{ series: [] }\n```\n");
    expect(body).toContain(`<${CHART_TAG} config="`);
    const config = body.match(/config="([^"]*)"/)[1];
    expect(decodeURIComponent(config)).toBe('{ series: [] }');
  });

  test('any other fence is left alone', () => {
    const { body } = createMarkdownRenderer().render('```js\nlet x = 1;\n```\n');
    expect(body).toContain('<pre>');
    expect(body).not.toContain(CHART_TAG);
  });

  test('headings do not accumulate across renders', () => {
    const r = createMarkdownRenderer();
    r.render('# One\n');
    expect(r.render('# Two\n').headings).toEqual([{ depth: 1, id: 'two', text: 'Two' }]);
  });
});

import { expect, test, describe } from 'bun:test';

import { REGISTERED_SERIES } from './registered-series.js';

// charts.js keeps two lists that have to agree: the chart types it imports and
// passes to use(), and REGISTERED_SERIES, which the build checks fences against
// and the element checks options against. Nothing links them -- ECharts offers
// no runtime way to ask which series types are installed -- so they drift
// silently, and the symptom is either a chart that renders blank or a build
// that rejects a document it should accept.
//
// Reading the source is the only way to compare them. Brittle if the import
// style changes; the assertion below fails loudly if it stops finding anything,
// so a rewrite of charts.js cannot quietly disable this test.

const source = await Bun.file(new URL('charts.js', import.meta.url)).text();

/** `LineChart` -> `line`, `PictorialBarChart` -> `pictorialBar`. */
const seriesTypeOf = (name) => {
  const base = name.replace(/Chart$/, '');
  return base[0].toLowerCase() + base.slice(1);
};

function importedChartTypes(src) {
  const block = src.match(/import\s*\{([^}]*)\}\s*from\s*'echarts\/charts'/);
  if (!block) return [];
  return block[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.endsWith('Chart'))
    .map(seriesTypeOf);
}

describe('charts.js and REGISTERED_SERIES agree', () => {
  const imported = importedChartTypes(source);

  test('the source scan still finds chart imports', () => {
    // Guards the two tests below: if charts.js is rewritten so the regex misses,
    // this fails rather than letting the comparison pass vacuously.
    expect(imported.length).toBeGreaterThan(0);
  });

  test('every imported chart type is declared', () => {
    expect(imported.filter((t) => !REGISTERED_SERIES.has(t))).toEqual([]);
  });

  test('every declared series type is imported', () => {
    expect([...REGISTERED_SERIES].filter((t) => !imported.includes(t))).toEqual([]);
  });

  test('passed to use(), not merely imported', () => {
    const use = source.match(/use\(\[([^\]]*)\]\)/);
    expect(use).not.toBeNull();
    const used = use[1].split(',').map((s) => s.trim());
    for (const t of imported) {
      expect(used).toContain(`${t[0].toUpperCase() + t.slice(1)}Chart`);
    }
  });
});

describe('seriesTypeOf', () => {
  test('lowercases only the first word', () => {
    expect(seriesTypeOf('LineChart')).toBe('line');
    expect(seriesTypeOf('PictorialBarChart')).toBe('pictorialBar');
    expect(seriesTypeOf('EffectScatterChart')).toBe('effectScatter');
  });
});

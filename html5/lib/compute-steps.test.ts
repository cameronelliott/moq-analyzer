import { expect, test } from 'bun:test';
import { COMPUTE_STEPS, computeProgress } from './compute-steps';

test('the bar starts at 0, only goes up, and is not full while a step is still running', () => {
  const fractions = COMPUTE_STEPS.map((s) => computeProgress(s.id).fraction);
  expect(fractions[0]).toBe(0);
  expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
  expect(new Set(fractions).size).toBe(fractions.length);
  for (const f of fractions) expect(f).toBeLessThan(1);
});

test('a step moves the bar by its share of the time, so the long step is the long stretch', () => {
  // On the six-POP sample the distributions take 5.7 s of 11.4 s: half the bar.
  const at = (id: Parameters<typeof computeProgress>[0]) => computeProgress(id).fraction;
  expect(at('bitrate') - at('distributions')).toBeCloseTo(0.5, 1);
  expect(at('distributions')).toBeCloseTo(1.3 / 11.4, 2);
});

test('the text names the step and counts it', () => {
  expect(computeProgress('counts').text).toBe('Counting objects… (1 of 6)');
  expect(computeProgress('distributions').text).toBe('Computing distributions… (2 of 6)');
  expect(computeProgress('relay').text).toBe('Computing relay… (6 of 6)');
});

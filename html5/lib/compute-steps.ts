// The second half of a load: the queries that fill the pages, as steps of a
// progress bar.
//
// A query gives no progress while it runs, so the bar moves when a step ends
// and not in between. Each step moves it by its share of the time, so a long
// step is a long stretch of bar and not a long wait at an even tick. The
// seconds are the six-POP sample's, measured in Chromium. Another capture has
// other seconds, in about the same proportions.

// The text is shown in the status line. Cameron rewrites it; keep it all here.
export const COMPUTE_STEPS = [
  { id: 'counts', text: 'Counting objects…', seconds: 1.3 },
  // mlog-sql's two distribution queries, apart, so the longest step has a midpoint.
  { id: 'quantiles', text: 'Computing distributions: quantiles…', seconds: 1.9 },
  { id: 'bins', text: 'Computing distributions: histograms…', seconds: 3.8 },
  { id: 'bitrate', text: 'Computing object bitrate…', seconds: 0.5 },
  { id: 'interarrival', text: 'Computing interarrival…', seconds: 0.1 },
  { id: 'jitter', text: 'Computing object jitter…', seconds: 2.2 },
  { id: 'relay', text: 'Computing relay…', seconds: 1.6 },
] as const;

export type ComputeStep = (typeof COMPUTE_STEPS)[number]['id'];

const TOTAL = COMPUTE_STEPS.reduce((sum, s) => sum + s.seconds, 0);

/** The status text for a step that is starting, and how full the bar is before it. */
export function computeProgress(step: ComputeStep): { text: string; fraction: number } {
  const index = COMPUTE_STEPS.findIndex((s) => s.id === step);
  const before = COMPUTE_STEPS.slice(0, index).reduce((sum, s) => sum + s.seconds, 0);
  return {
    text: `${COMPUTE_STEPS[index]?.text ?? ''} (${index + 1} of ${COMPUTE_STEPS.length})`,
    fraction: before / TOTAL,
  };
}

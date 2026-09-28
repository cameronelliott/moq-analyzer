// The Overview view: a stats row and one card per measure. Ported from
// ../html3's index.liquid and distribution-card.liquid, with the numbers now
// from mlog-sql.
//
// A pure function of the capture's numbers. It returns the HTML and, apart
// from it, each chart's option: an option is set as a property on the
// element, never written into the markup. mountCharts() joins the two.

import type { EChartsOption } from 'echarts';
import type { Distribution, Measure, TrustRow } from 'mlog-sql';
import { count, percent, quantity, sig } from './format';
import { html, type SafeHtml } from './html';

export interface OverviewData {
  readonly traces: number;
  readonly trust: readonly TrustRow[];
  /** A measure left out is still being computed: its card shows a spinner
   *  until distributionCard() replaces it. null means no samples. */
  readonly distributions: Readonly<Partial<Record<Measure, Distribution | null>>>;
}

export interface View {
  readonly html: SafeHtml;
  /** Chart options by the `data-chart` id of the element that shows them. */
  readonly charts: Readonly<Record<string, EChartsOption>>;
}

type Quantile = 'min' | 'p1' | 'p5' | 'p50' | 'p95' | 'p99' | 'max';

interface CardSpec {
  readonly measure: Measure;
  readonly title: string;
  /** The view the title links to. None yet: the title is plain text. */
  readonly href?: string;
  readonly about: string;
  /** The quantile that leads: p99 where high is bad, p5 where low is bad. */
  readonly tail: Quantile;
  readonly shown: readonly Quantile[];
  /** What one sample is, plural. */
  readonly samples: string;
}

// The card text. Cameron rewrites it; keep it all here.
const CARDS: readonly CardSpec[] = [
  {
    measure: 'end to end',
    title: 'End to end',
    href: '#latency',
    about: 'Time from the publisher creating an object to a subscriber parsing it, across all three legs. '
      + 'One delivery is one object reaching one subscriber. Held objects are left out.',
    tail: 'p99',
    shown: ['p50', 'p95', 'max'],
    samples: 'deliveries',
  },
  {
    measure: 'relay dwell',
    title: 'Relay dwell',
    href: '#latency',
    about: 'Time an object spends inside the relay, from arriving to being sent on to one subscriber. '
      + 'Held objects are left out.',
    tail: 'p99',
    shown: ['p50', 'p95', 'max'],
    samples: 'sends',
  },
  {
    measure: 'bitrate',
    title: 'Bitrate',
    about: 'Payload bits per second at a subscriber: no QUIC or MoQ framing, no retransmissions. '
      + 'One sample is one second at one subscriber. The first and last second of each log are partial and left out.',
    tail: 'p5',
    shown: ['p50', 'p95', 'min'],
    samples: 'seconds',
  },
  {
    measure: 'interarrival',
    title: 'Interarrival',
    about: 'Gap between an object arriving at a subscriber and the one before it on the same track. '
      + "It includes the publisher's pacing. rtcstats calls this latency; webrtc-internals calls it jitter.",
    tail: 'p99',
    shown: ['p50', 'p95', 'max'],
    samples: 'gaps',
  },
];

const DELIVERY_ABOUT = 'An object is lost only if both ends were still logging when it was sent. '
  + "One sent after a subscriber's log stopped is outside the window, not lost.";
const CLOCKS_ABOUT = 'A negative hop is an object logged as arriving before it was sent. '
  + 'Only clock error makes one.';

/** The id a measure's card and chart share. */
export const cardId = (measure: Measure): string => measure.replaceAll(' ', '-');

/** A distribution's bins as a card histogram. */
export function histogramOption(d: Distribution, samples: string): EChartsOption {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'category',
      // The card grid starts at left 0, so a centred first label would hang
      // off the canvas edge and be clipped.
      axisLabel: { formatter: (v: string) => v.split('–')[0] ?? v, alignMinLabel: 'left' },
      data: d.bins.map((b) => `${sig(b.lo)}–${sig(b.hi)}`),
    },
    yAxis: { type: 'value', axisLabel: { show: false } },
    series: [{ name: samples, type: 'bar', barCategoryGap: '8%', data: d.bins.map((b) => b.count) }],
  };
}

function cardHead(id: string, title: string, about: string, href?: string): SafeHtml {
  return html`<div class="wa-cluster wa-gap-xs">
    <h2 class="wa-heading-m">${href ? html`<a href="${href}">${title}</a>` : title}</h2>
    <wa-icon id="about-${id}" name="circle-info" label="About ${title.toLowerCase()}" tabindex="0"></wa-icon>
    <wa-tooltip for="about-${id}">${about}</wa-tooltip>
  </div>`;
}

function card(spec: CardSpec, d: Distribution | null | undefined): SafeHtml {
  const id = cardId(spec.measure);
  const body = d === undefined
    ? html`<div class="pending"><wa-spinner label="Computing ${spec.title.toLowerCase()}"></wa-spinner></div>`
    : d
    ? html`<div class="wa-stack wa-gap-3xs">
      <span class="wa-heading-xl">${quantity(d[spec.tail], d.unit)}</span>
      <span class="wa-caption-m">${spec.tail} of ${count(d.n)} ${spec.samples}, every subscriber and track.</span>
    </div>
    <app-echart variant="card" height="150px" data-chart="${id}"></app-echart>
    <dl class="quantiles">${spec.shown.map((q) =>
      html`<div><dt>${q}</dt><dd>${quantity(d[q], d.unit)}</dd></div>`)}</dl>`
    : html`<p class="wa-body-s">No samples in this capture.</p>`;
  return html`<section class="card wa-stack" data-card="${id}">${cardHead(id, spec.title, spec.about, spec.href)}${body}</section>`;
}

/** The measures with a card, in page order. */
export const OVERVIEW_MEASURES: readonly Measure[] = CARDS.map((s) => s.measure);

const specFor = (measure: Measure): CardSpec => {
  const spec = CARDS.find((s) => s.measure === measure);
  if (!spec) throw new Error(`no overview card for ${measure}`);
  return spec;
};

/** One distribution card, to replace the `[data-card]` of the same id. */
export function distributionCard(measure: Measure, d: Distribution | null): View {
  const spec = specFor(measure);
  return {
    html: card(spec, d),
    charts: d ? { [cardId(measure)]: histogramOption(d, spec.samples) } : {},
  };
}

const sum = (rows: readonly TrustRow[], key: 'sent' | 'joined' | 'lost' | 'outside_window' | 'negative_hops') =>
  rows.reduce((total, r) => total + r[key], 0);

function deliveryCard(trust: readonly TrustRow[]): SafeHtml {
  const joined = sum(trust, 'joined');
  const outside = sum(trust, 'outside_window');
  const lost = sum(trust, 'lost');
  const whole = joined + outside + lost;
  const label = `${percent(joined, whole)} joined, ${percent(outside, whole)} outside the window, `
    + (lost ? `${percent(lost, whole)} lost` : 'none lost');
  return html`<section class="card wa-stack">
    ${cardHead('delivery', 'Delivery', DELIVERY_ABOUT, '#connections')}
    <div class="wa-stack wa-gap-3xs">
      <span class="wa-heading-xl">${count(lost)} lost</span>
      <span class="wa-caption-m">of ${count(sum(trust, 'sent'))} objects sent on ${count(trust.length)} connections.</span>
    </div>
    <div class="bar" role="img" aria-label="${label}">
      <span class="success" style="flex-grow: ${joined}">${percent(joined, whole)}</span>
      <span class="neutral" style="flex-grow: ${outside}"></span>
      <span class="danger" style="flex-grow: ${lost}"></span>
    </div>
    <ul class="rows">
      <li><span class="dot success"></span>Joined<span>${count(joined)}</span></li>
      <li><span class="dot neutral"></span>Outside the window<span>${count(outside)}</span></li>
      <li><span class="dot danger"></span>Lost<span>${count(lost)}</span></li>
    </ul>
  </section>`;
}

function clocksCard(trust: readonly TrustRow[]): SafeHtml {
  const negative = sum(trust, 'negative_hops');
  return html`<section class="card wa-stack">
    ${cardHead('clocks', 'Clocks', CLOCKS_ABOUT, '#connections')}
    <div class="wa-stack wa-gap-3xs">
      <span class="wa-heading-xl">${count(negative)}</span>
      <span class="wa-caption-m">negative hops in ${count(sum(trust, 'joined'))} joined.</span>
    </div>
    ${negative === 0
      ? html`<p class="wa-body-s">That rules out clock error larger than the transit time, and nothing finer.</p>`
      : null}
  </section>`;
}

function stat(term: string, value: string): SafeHtml {
  return html`<div class="wa-stack wa-gap-3xs"><dt class="wa-caption-m">${term}</dt><dd class="wa-heading-xl">${value}</dd></div>`;
}

export function overview(data: OverviewData): View {
  const charts: Record<string, EChartsOption> = {};
  for (const spec of CARDS) {
    const d = data.distributions[spec.measure];
    if (d) charts[cardId(spec.measure)] = histogramOption(d, spec.samples);
  }
  return {
    html: html`<div class="dashboard wa-stack wa-gap-xl">
  <h1>Overview</h1>
  <dl class="stats wa-grid wa-gap-l">
    ${stat('Traces', count(data.traces))}
    ${stat('Connections', count(data.trust.length))}
    ${stat('Hops joined', count(sum(data.trust, 'joined')))}
  </dl>
  <div class="tray wa-grid wa-gap-xs">
    ${CARDS.slice(0, 2).map((spec) => card(spec, data.distributions[spec.measure]))}
    ${deliveryCard(data.trust)}
    ${CARDS.slice(2).map((spec) => card(spec, data.distributions[spec.measure]))}
    ${clocksCard(data.trust)}
  </div>
</div>`,
    charts,
  };
}

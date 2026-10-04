// The Overview view: a stats row and one card per measure. Ported from
// ../html3's index.liquid and distribution-card.liquid, with the numbers now
// from mlog-sql.
//
// A pure function of the capture's numbers. It returns the HTML and, apart
// from it, each chart's option: an option is set as a property on the
// element, never written into the markup. mountCharts() joins the two.

import type { EChartsOption } from 'echarts';
import type { Distribution, Measure, RecoveryRow, TrustRow } from 'mlog-sql';
import { count, percent, quantity, sig } from './format';
import { html, type SafeHtml } from './html';
import { recoveryNotice } from './recovery';
import type { View } from './view';

export interface OverviewData {
  readonly traces: number;
  readonly trust: readonly TrustRow[];
  /** What mlog-sql recovered. Left out, or all logged, shows no notice. */
  readonly recovery?: readonly RecoveryRow[];
  /** A measure left out is still being computed: its card shows a spinner
   *  until distributionCard() replaces it. null means no samples. */
  readonly distributions: Readonly<Partial<Record<Measure, Distribution | null>>>;
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
  /** What the number is when no subscriber's log is loaded and mlog-sql
   *  measured at the relay instead. Only bitrate and interarrival fall back. */
  readonly atRelay?: string;
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
    title: 'Object bitrate',
    href: '#throughput',
    about: 'Payload bits per second at a subscriber: no QUIC or MoQ framing, no retransmissions. '
      + 'One sample is one second at one subscriber. The first and last second of each log are partial and left out.',
    tail: 'p5',
    shown: ['p50', 'p95', 'min'],
    samples: 'seconds',
    atRelay: 'No subscriber log is loaded. This is what the relay sent to each subscriber.',
  },
  {
    measure: 'interarrival',
    title: 'Interarrival',
    href: '#interarrival',
    about: 'Gap between an object arriving at a subscriber and the one before it on the same track. '
      + "It includes the publisher's pacing. rtcstats calls this latency; webrtc-internals calls it jitter.",
    tail: 'p99',
    shown: ['p50', 'p95', 'max'],
    samples: 'gaps',
    atRelay: 'No subscriber log is loaded. These are gaps at the relay, between objects arriving from the publisher.',
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
      ${d.measured_at === 'relay' && spec.atRelay ? html`<span class="wa-caption-m">${spec.atRelay}</span>` : null}
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

type Count = 'sent' | 'joined' | 'lost' | 'outside_window' | 'negative_hops';

// A NULL count is one the loaded logs cannot back, as when only the relay's
// side of a connection is loaded. It is left out of a sum, never read as 0.
const sum = (rows: readonly TrustRow[], key: Count) =>
  rows.reduce((total, r) => total + (r[key] ?? 0), 0);

/** The connections where `key` was measured. */
const measured = (rows: readonly TrustRow[], key: Count) => rows.filter((r) => r[key] !== null);

const connections = (n: number) => `${count(n)} connection${n === 1 ? '' : 's'}`;

function deliveryCard(trust: readonly TrustRow[]): SafeHtml {
  // lost and outside_window are NULL together, and joined is set wherever they are
  const rows = measured(trust, 'lost');
  const head = cardHead('delivery', 'Delivery', DELIVERY_ABOUT, '#connections');
  if (rows.length === 0) {
    return html`<section class="card wa-stack">
    ${head}
    <div class="wa-stack wa-gap-3xs">
      <span class="wa-heading-xl">Not measured</span>
      <span class="wa-caption-m">Object loss needs both ends of a connection, with objects seen at both. No connection in this capture has that.</span>
    </div>
  </section>`;
  }
  const joined = sum(rows, 'joined');
  const outside = sum(rows, 'outside_window');
  const lost = sum(rows, 'lost');
  const whole = joined + outside + lost;
  const label = `${percent(joined, whole)} joined, ${percent(outside, whole)} outside the window, `
    + (lost ? `${percent(lost, whole)} lost` : 'none lost');
  const rest = trust.length - rows.length;
  return html`<section class="card wa-stack">
    ${head}
    <div class="wa-stack wa-gap-3xs">
      <span class="wa-heading-xl">${count(lost)} lost</span>
      <span class="wa-caption-m">of ${count(sum(rows, 'sent'))} objects sent on ${connections(rows.length)}.${rest > 0
        ? ` ${count(rest)} more connection${rest === 1 ? '' : 's'} could not be measured.`
        : ''}</span>
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
  const rows = measured(trust, 'negative_hops');
  const head = cardHead('clocks', 'Clocks', CLOCKS_ABOUT, '#connections');
  if (rows.length === 0) {
    return html`<section class="card wa-stack">
    ${head}
    <div class="wa-stack wa-gap-3xs">
      <span class="wa-heading-xl">—</span>
      <span class="wa-caption-m">Clock checks need both ends of a connection. No connection in this capture has both.</span>
    </div>
  </section>`;
  }
  const negative = sum(rows, 'negative_hops');
  return html`<section class="card wa-stack">
    ${head}
    <div class="wa-stack wa-gap-3xs">
      <span class="wa-heading-xl">${count(negative)}</span>
      <span class="wa-caption-m">negative hops in ${count(sum(rows, 'joined'))} joined.</span>
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
    ${stat('Hops joined', measured(data.trust, 'joined').length === 0 ? '—' : count(sum(data.trust, 'joined')))}
  </dl>
  ${recoveryNotice(data.recovery ?? [])}
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

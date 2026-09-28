// The analyzer's bundle entry. index.html loads it with one script tag.

import { CaptureError, openCapture } from 'mlog-sql';
import { mountCharts } from './lib/chart-element';
import { installSchemeSwitch } from './lib/dark-light-scheme';
import { browserEngine, type BrowserEngine } from './lib/duckdb-engine';
import { html } from './lib/html';
import { OVERVIEW_MEASURES, cardId, distributionCard, overview } from './lib/overview';
import { connections } from './lib/connections';
import { latency } from './lib/latency';
import { tracesFromFiles } from './lib/trace-files';

// Web Awesome's loader finds components by scanning the document at runtime,
// which cannot be bundled. Listing them here is what replaces it: these are the
// wa-* elements the page may use.
import '@awesome.me/webawesome/dist/components/page/page.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';

// wa-page draws its mobile menu button with <wa-icon name="bars">, and the
// stock 'default' library resolves that to a Font Awesome CDN URL at runtime --
// one more origin, for one glyph. Overriding the library keeps every asset
// local; an icon it does not know renders as nothing. Overview cards add
// circle-info, and the header's scheme switch adds sun, moon and
// circle-half-stroke.
const ICONS: Record<string, string> = {
  bars: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  'circle-info': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  sun: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<circle cx="12" cy="12" r="4"/>'
    + '<path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4'
    + 'M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linejoin="round">'
    + '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  'circle-half-stroke': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
    + 'fill="none" stroke="currentColor" stroke-width="2">'
    + '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',
};

registerIconLibrary('default', {
  resolver: (name) => {
    const svg = ICONS[name];
    return svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : '';
  },
});

/** An element index.html must have. A missing one is a bug in the page. */
function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing or is not a ${type.name}`);
  return el;
}

// The header's light / dark / auto switch. The <head> script has already set
// the scheme; this checks the matching radio and handles changes.
installSchemeSwitch(element('scheme-switch', HTMLFieldSetElement));

// --- load a capture ---------------------------------------------------------
// Everything lives in this tab: the files, the duckdb worker, the results. A
// page load loses them. Each load gets a new engine, because mlog-sql takes one
// capture per engine and a failed load leaves a partial one.
//
// The next engine starts in the background -- at page load, and again after
// each load -- so the wasm download and compile happen while the reader picks
// files, not after.

const dropZone = element('drop-zone', HTMLLabelElement);
const fileInput = element('file-input', HTMLInputElement);
const statusLine = element('status', HTMLParagraphElement);
const rejectedList = element('rejected', HTMLUListElement);
const captureNav = element('capture-nav', HTMLDivElement);
const overviewView = element('overview', HTMLElement);
const connectionsView = element('connections', HTMLElement);
const latencyView = element('latency', HTMLElement);

// --- views ------------------------------------------------------------------
// One HTML page; the URL hash picks which <section data-view> shows. The
// capture views need a loaded capture, so without one every hash shows load.

const CAPTURE_VIEWS = new Set(['overview', 'latency', 'connections']);
let loaded = false;

function route(): void {
  const hash = location.hash.slice(1);
  const view = loaded && CAPTURE_VIEWS.has(hash) ? hash : 'load';
  for (const section of document.querySelectorAll<HTMLElement>('[data-view]')) {
    section.hidden = section.dataset.view !== view;
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[slot=navigation] a')) {
    if (link.hash === `#${view}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function show(view: string): void {
  // Setting the same hash fires no hashchange, so route directly as well.
  location.hash = view;
  route();
}

addEventListener('hashchange', route);
route();

/** Starts an engine. A failure is not reported here: load() awaits it and shows it. */
function warm(): Promise<BrowserEngine> {
  const engine = browserEngine();
  engine.catch(() => {});   // no unhandled rejection before a load awaits it
  return engine;
}

let current: BrowserEngine | undefined;
let next = warm();
let busy = false;

async function load(files: readonly File[]): Promise<void> {
  if (busy) return;
  busy = true;
  fileInput.disabled = true;
  loaded = false;
  captureNav.hidden = true;
  show('load');

  const { traces, rejected } = tracesFromFiles(files);
  rejectedList.innerHTML = html`${rejected.map((r) => html`<li>${r.file}: ${r.reason}</li>`)}`.text;

  try {
    if (traces.length === 0) {
      statusLine.textContent = 'No trace files to load.';
      return;
    }
    statusLine.textContent = `Loading ${traces.length} traces…`;
    await current?.terminate();
    current = undefined;

    const t0 = performance.now();
    // A warm-up that failed (a network blip, say) gets one retry here.
    current = await next.catch(() => browserEngine());
    const capture = await openCapture(current.engine, traces);
    // One connection, so one query at a time.
    const trust = await capture.trust();
    const legs = await capture.legSummary();

    // Show the Overview now, with a spinner in each distribution card, and
    // fill the cards in as their queries return.
    overviewView.innerHTML = overview({ traces: traces.length, trust, distributions: {} }).html.text;
    connectionsView.innerHTML = connections(trust).html.text;
    const latencyPage = latency(legs);
    latencyView.innerHTML = latencyPage.html.text;
    mountCharts(latencyView, latencyPage.charts);
    loaded = true;
    captureNav.hidden = false;
    show('overview');
    statusLine.textContent = 'Computing distributions…';

    for (const measure of OVERVIEW_MEASURES) {
      const card = distributionCard(measure, await capture.distribution(measure));
      const slot = overviewView.querySelector(`[data-card="${cardId(measure)}"]`);
      if (!slot) continue;
      slot.outerHTML = card.html.text;
      mountCharts(overviewView, card.charts);
    }
    const seconds = ((performance.now() - t0) / 1000).toFixed(1);
    statusLine.textContent = `${traces.length} traces loaded in ${seconds} s.`;
  } catch (e) {
    statusLine.textContent = e instanceof CaptureError
      ? `mlog-sql failed (${e.failure.kind}): ${e.message}`
      : `Load failed: ${e instanceof Error ? e.message : String(e)}`;
    await current?.terminate();
    current = undefined;
  } finally {
    // Only after the load: two engines loading at once would double the memory.
    if (traces.length > 0) next = warm();
    busy = false;
    fileInput.disabled = false;
    fileInput.value = '';
  }
}

fileInput.addEventListener('change', () => {
  void load([...(fileInput.files ?? [])]);
});

// Drop anywhere on the page. Without preventDefault on dragover the browser
// opens the dropped file instead.
document.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
});
document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) dropZone.classList.remove('dragging');
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  void load([...(event.dataTransfer?.files ?? [])]);
});

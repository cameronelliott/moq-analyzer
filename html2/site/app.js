// Bundle entry for the static pages.
//
// Note what is missing: the markdown element, and so `marked`. These pages
// arrive already rendered, so nothing here parses markdown and the parser stays
// out of the bundle. app-live.js is the entry that pays for it -- comparing the
// two bundle sizes is one of the numbers this spike is for.

// FIRST, above every component import. This patches LitElement so a component
// that finds server-rendered shadow DOM adopts it rather than discarding it and
// re-rendering. Imported after a component, the patch lands too late.
import '@lit-labs/ssr-client/lit-element-hydrate-support.js';

// Must match componentModules in eleventy.config.js, or a component is
// server-rendered and never hydrated, or hydrated and never server-rendered.
import '@awesome.me/webawesome/dist/components/button/button.js';

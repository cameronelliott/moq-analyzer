// The series types this site's ECharts build can draw.
//
// Its own file, holding nothing but data, so the build can read it without
// importing ECharts. charts.js re-exports it for the browser.
//
// Keep it in step with the use([...]) call in charts.js. They are separate
// because ECharts offers no runtime way to ask which series types are
// installed -- and the build checks every chart against this, so a type left
// out here fails the build rather than a visitor's page.

export const REGISTERED_SERIES = new Set(['bar', 'line']);

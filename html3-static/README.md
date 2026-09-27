# html3-static

chartdown: markdown pages with charts, and capture dashboards, built by
Eleventy on Web Awesome. A chart is drawn to SVG at build time and redrawn as
an interactive ECharts canvas in the browser.

    bun install
    bun run dev     Eleventy on :8081, rebuilding app.js on every change
    bun run build   writes _site/
    bun test        lib/*.test.js

The Caddyfile serves the last build of `_site` on :8080, as a deploy would.

The plan is in AGENTS.md. Settled decisions and known traps are in BRIEF.md.

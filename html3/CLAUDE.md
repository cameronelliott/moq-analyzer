# html3

The plan is in AGENTS.md. Settled decisions and known traps are in BRIEF.md:
read it before changing the build, the layouts or the charts.

Bun is the only runtime installed; `node` is bun's shim. Run from html3/,
since Eleventy finds its config by cwd.

    bun run dev     Eleventy on :8081, rebuilding app.js on every change
    bun run build   writes _site/
    bun test        lib/*.test.js

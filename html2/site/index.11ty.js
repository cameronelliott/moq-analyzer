// The showcase index, from the `docs` collection -- one of the capabilities
// BRIEF.md says this spike exists to demonstrate. Adding a markdown file adds
// two rows here with no edit to this file.

export default class Index {
  data() {
    return { permalink: 'index.html' };
  }

  render({ docs }) {
    const rows = docs.map((d) => `    <tr>
      <td>${d.title}</td>
      <td><a href="/${d.slug}.html">static</a></td>
      <td><a href="/live/${d.slug}.html">live</a></td>
      <td><a href="/src/${d.file}">source</a></td>
    </tr>`).join('\n');

    return `<!doctype html>
<html lang="en" class="wa-theme-default wa-palette-default wa-light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>html2 — Eleventy + SSR spike</title>
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
</head>
<body>

<main class="wa-prose">
  <h1>html2 — Eleventy + SSR spike</h1>
  <p>Each document is built twice from one source, by one renderer.
     <strong>static</strong> is rendered by Eleventy at build time and is
     readable with JavaScript off. <strong>live</strong> fetches the markdown
     and renders it in the browser with <code>&lt;app-markdown&gt;</code>.
     Their prose is byte-identical.</p>
  <table>
    <thead><tr><th>document</th><th colspan="2">rendered</th><th>markdown</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</main>

</body>
</html>
`;
  }
}

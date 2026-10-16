// Renders the analysed report as Markdown and/or a self-contained HTML page.
import { SEVERITIES } from './analyze.mjs';

const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const HEALTH_LABEL = { good: 'Good', fair: 'Fair', poor: 'Poor' };

// Screenshot paths in data are relative to the report directory.
function pageRows(data) {
  return data.pages.map((p) => ({
    url: p.url,
    status: p.navigationError ? 'failed' : String(p.status ?? '—'),
    lcp: p.timing?.largestContentfulPaintMs ?? null,
    load: p.timing?.loadEventMs ?? null,
    jsErrors: p.jsErrors.length,
    a11y: p.accessibility?.violations?.length ?? null,
    desktop: p.screenshots?.desktop ?? null,
    mobile: p.screenshots?.mobile ?? null,
  }));
}

const ms = (n) => (n == null ? '—' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

function generatedBy(meta) {
  return meta.provider ? `${meta.model} (${meta.provider})` : 'basic rules (no AI)';
}

export function renderMarkdown(report, data, meta) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, report.issues.filter((i) => i.severity === s).length]));
  const out = [];
  out.push(`# QA report: ${data.origin}`, '');
  out.push(`- **Start URL:** ${data.startUrl}`);
  out.push(`- **Run:** ${data.startedAt} → ${data.finishedAt}`);
  out.push(`- **Pages visited:** ${data.pages.length} (depth ${data.settings.depth}, max ${data.settings.maxPages}); ${data.linkChecks.length} more links checked`);
  out.push(`- **Written by:** ${generatedBy(meta)}`);
  if (meta.warning) out.push(`- **Note:** ${meta.warning}`);
  out.push('', `## Overall: ${HEALTH_LABEL[report.overallHealth] ?? report.overallHealth}`, '', report.summary, '');
  out.push('| Critical | High | Medium | Low |', '|---|---|---|---|');
  out.push(`| ${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} |`, '');

  for (const severity of SEVERITIES) {
    const issues = report.issues.filter((i) => i.severity === severity);
    if (!issues.length) continue;
    out.push(`## ${SEVERITY_LABEL[severity]}`, '');
    for (const issue of issues) {
      out.push(`### ${issue.title}`, '');
      out.push(`*${issue.category}* · ${issue.affectedPages.length} page(s)`, '');
      out.push(issue.explanation, '');
      out.push(`**Fix:** ${issue.recommendation}`, '');
      out.push('<details><summary>Evidence</summary>', '', '```', issue.evidence, '```', '');
      if (issue.affectedPages.length) out.push('Affected pages:', '', ...issue.affectedPages.map((p) => `- ${p}`), '');
      out.push('</details>', '');
    }
  }

  if (report.positives.length) {
    out.push('## What worked well', '', ...report.positives.map((p) => `- ${p}`), '');
  }

  out.push('## Pages', '', '| Page | Status | LCP | Load | JS errors | A11y rules failed | Screenshots |', '|---|---|---|---|---|---|---|');
  for (const r of pageRows(data)) {
    const shots = [r.desktop && `[desktop](${encodeURI(r.desktop)})`, r.mobile && `[mobile](${encodeURI(r.mobile)})`].filter(Boolean).join(' · ') || '—';
    out.push(`| ${r.url} | ${r.status} | ${ms(r.lcp)} | ${ms(r.load)} | ${r.jsErrors} | ${r.a11y ?? '—'} | ${shots} |`);
  }
  out.push('', 'Raw data: [`raw/findings.json`](raw/findings.json)', '');
  return out.join('\n');
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderHtml(report, data, meta) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, report.issues.filter((i) => i.severity === s).length]));
  const issueHtml = (i) => `
    <article class="issue">
      <h3><span class="sev ${esc(i.severity)}">${esc(SEVERITY_LABEL[i.severity])}</span> ${esc(i.title)}</h3>
      <p class="meta">${esc(i.category)} · ${i.affectedPages.length} page(s)</p>
      <p>${esc(i.explanation)}</p>
      <p><strong>Fix:</strong> ${esc(i.recommendation)}</p>
      <details><summary>Evidence and affected pages</summary>
        <pre>${esc(i.evidence)}</pre>
        <ul>${i.affectedPages.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      </details>
    </article>`;

  const rows = pageRows(data)
    .map(
      (r) => `<tr>
        <td class="url">${esc(r.url)}</td><td>${esc(r.status)}</td><td>${ms(r.lcp)}</td><td>${ms(r.load)}</td>
        <td>${r.jsErrors}</td><td>${r.a11y ?? '—'}</td>
        <td class="shots">${[r.desktop, r.mobile]
          .filter(Boolean)
          .map((s) => `<a href="${esc(encodeURI(s))}"><img src="${esc(encodeURI(s))}" alt="" loading="lazy"></a>`)
          .join('')}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA report: ${esc(data.origin)}</title>
<style>
  :root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --card:#f7f7f9;
          --critical:#b3261e; --high:#d9480f; --medium:#b8860b; --low:#4a6fa5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151517; --fg:#f2f2f4; --muted:#a1a1a6; --line:#2c2c30; --card:#1e1e21;
            --critical:#ff6b61; --high:#ff922b; --medium:#e0b84c; --low:#7aa2e3; }
  }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width:960px; margin:0 auto; padding:32px 16px 64px; }
  h1 { margin:0 0 8px; font-size:1.6rem; overflow-wrap:anywhere; }
  .facts { color:var(--muted); font-size:.9rem; margin:0 0 24px; padding:0; list-style:none; }
  .counts { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:16px 0 32px; }
  .counts div { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; text-align:center; }
  .counts b { display:block; font-size:1.5rem; }
  .issue { border:1px solid var(--line); border-radius:8px; padding:16px; margin:12px 0; background:var(--card); }
  .issue h3 { margin:0 0 4px; font-size:1.05rem; }
  .meta { color:var(--muted); font-size:.85rem; margin:0 0 8px; }
  .sev { font-size:.75rem; font-weight:600; text-transform:uppercase; padding:2px 6px; border-radius:4px; color:#fff; margin-right:6px; }
  .sev.critical { background:var(--critical); } .sev.high { background:var(--high); }
  .sev.medium { background:var(--medium); } .sev.low { background:var(--low); }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:.85rem; background:var(--bg); padding:8px; border-radius:6px; }
  .table-wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.9rem; }
  th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
  td.url { overflow-wrap:anywhere; min-width:180px; }
  .shots img { height:64px; border:1px solid var(--line); border-radius:4px; margin-right:4px; object-fit:cover; object-position:top; max-width:120px; }
  a { color:inherit; }
</style>
</head>
<body>
<main>
  <h1>QA report: ${esc(data.origin)}</h1>
  <ul class="facts">
    <li>Start URL: ${esc(data.startUrl)}</li>
    <li>Run: ${esc(data.startedAt)} → ${esc(data.finishedAt)}</li>
    <li>${data.pages.length} page(s) visited (depth ${data.settings.depth}, max ${data.settings.maxPages}); ${data.linkChecks.length} more links checked</li>
    <li>Written by: ${esc(generatedBy(meta))}</li>
    ${meta.warning ? `<li>Note: ${esc(meta.warning)}</li>` : ''}
  </ul>
  <h2>Overall: ${esc(HEALTH_LABEL[report.overallHealth] ?? report.overallHealth)}</h2>
  ${report.summary.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('')}
  <div class="counts">${SEVERITIES.map((s) => `<div><b>${counts[s]}</b>${SEVERITY_LABEL[s]}</div>`).join('')}</div>
  ${SEVERITIES.map((s) => {
    const issues = report.issues.filter((i) => i.severity === s);
    return issues.length ? `<h2>${SEVERITY_LABEL[s]}</h2>${issues.map(issueHtml).join('')}` : '';
  }).join('')}
  ${report.positives.length ? `<h2>What worked well</h2><ul>${report.positives.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
  <h2>Pages</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Page</th><th>Status</th><th>LCP</th><th>Load</th><th>JS errors</th><th>A11y rules failed</th><th>Screenshots</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p>Raw data: <a href="raw/findings.json">raw/findings.json</a></p>
</main>
</body>
</html>
`;
}

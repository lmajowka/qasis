// Builds reports/index.html: one self-contained page that lists every site under
// the output root, its QA runs (health and issue counts per run) and its flows.
// It only reads what earlier runs wrote, so it can be rebuilt at any time.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEVERITIES, writeBasicReport } from './analyze.mjs';
import { flowFile } from './flows/render.mjs';
import { esc } from './report.mjs';

const RUN_DIR = /^\d{4}-\d{2}-\d{2}(-\d+)?$/;
const MAX_RUNS_SHOWN = 20;
const MAX_FLOWS_SHOWN = 12;
const MAX_FLOW_RUNS_SHOWN = 5;

const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const HEALTH_LABEL = { good: 'Good', fair: 'Fair', poor: 'Poor' };
const FLOW_STATUS = { new: 'New', changed: 'Changed', active: 'Active', missing: 'Not seen' };

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const href = (...parts) => esc(parts.map(encodeURIComponent).join('/'));
const when = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—');
// "2026-10-16-2" sorts after "2026-10-16" and before "2026-10-17".
const runOrder = (name) => name.replace(/^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/, (_, d, n) => `${d}-${String(n ?? 1).padStart(4, '0')}`);

/** One QA run. raw/report.json is written by current runs; older ones fall back to what they left. */
function loadRun(siteDir, name) {
  const raw = join(siteDir, name, 'raw');
  const saved = readJson(join(raw, 'report.json')) ?? readJson(join(raw, 'llm-report.json'));
  let report = saved?.report;
  const condensed = report && saved.run ? null : readJson(join(raw, 'condensed.json'));
  if (!report && condensed) report = writeBasicReport(condensed);
  if (!report) return null;

  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, report.issues.filter((i) => i.severity === s).length]));
  const meta = saved?.meta ?? {};
  return {
    name,
    health: report.overallHealth,
    counts,
    finishedAt: saved?.run?.finishedAt ?? null,
    pages: saved?.run?.pagesVisited ?? condensed?.pagesVisited ?? null,
    writtenBy: meta.provider ? meta.model : 'basic rules',
    warning: meta.warning ?? null,
    html: existsSync(join(siteDir, name, 'report.html')),
    md: existsSync(join(siteDir, name, 'report.md')),
  };
}

function loadSite(outRoot, site) {
  const siteDir = join(outRoot, site);
  const runs = readdirSync(siteDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && RUN_DIR.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => runOrder(b).localeCompare(runOrder(a)))
    .map((name) => loadRun(siteDir, name))
    .filter(Boolean);
  const flows = readJson(join(siteDir, 'flows', 'state.json'));
  if (!runs.length && !flows) return null;
  return { site, origin: flows?.origin ?? `https://${site}`, runs, flows };
}

export function loadSites(outRoot) {
  if (!existsSync(outRoot)) return [];
  return readdirSync(outRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => loadSite(outRoot, e.name))
    .filter(Boolean)
    .sort((a, b) => a.site.localeCompare(b.site));
}

const healthBadge = (health) =>
  health ? `<span class="health ${esc(health)}">${esc(HEALTH_LABEL[health] ?? health)}</span>` : '<span class="health none">No QA run</span>';

const countCells = (counts) =>
  SEVERITIES.map((s) => `<td class="num${counts[s] ? ` ${s}` : ''}">${counts[s]}</td>`).join('');

function runsTable(site, runs) {
  if (!runs.length) return '<p class="empty">No QA runs yet. Run <code>npm run qa -- ' + esc(site) + '</code>.</p>';
  const rows = runs.slice(0, MAX_RUNS_SHOWN).map((r) => {
    const links = [r.html && `<a href="${href(site, r.name, 'report.html')}">HTML</a>`, r.md && `<a href="${href(site, r.name, 'report.md')}">Markdown</a>`]
      .filter(Boolean)
      .join(' · ');
    return `<tr>
      <td>${esc(r.finishedAt ? when(r.finishedAt) : r.name)}</td><td>${healthBadge(r.health)}</td>${countCells(r.counts)}
      <td class="num">${r.pages ?? '—'}</td><td>${esc(r.writtenBy)}${r.warning ? ' <span class="warn" title="' + esc(r.warning) + '">⚠</span>' : ''}</td><td>${links || '—'}</td>
    </tr>`;
  });
  const more = runs.length > MAX_RUNS_SHOWN ? `<p class="muted">…and ${runs.length - MAX_RUNS_SHOWN} older run(s).</p>` : '';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Run</th><th>Health</th>${SEVERITIES.map((s) => `<th class="num">${SEVERITY_LABEL[s]}</th>`).join('')}<th class="num">Pages</th><th>Written by</th><th>Report</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>${more}`;
}

function flowsSection(site, state) {
  if (!state) return '<p class="empty">No flow discovery yet. Run <code>npm run flows -- ' + esc(site) + ' --once</code>.</p>';
  const flows = Object.values(state.flows);
  const byStatus = Object.fromEntries(Object.keys(FLOW_STATUS).map((s) => [s, flows.filter((f) => f.status === s).length]));
  const chips = Object.entries(byStatus)
    .filter(([, n]) => n)
    .map(([s, n]) => `<span class="chip ${s}">${n} ${FLOW_STATUS[s]}</span>`)
    .join('');
  const listed = flows
    .sort((a, b) => (a.status === 'missing') - (b.status === 'missing') || b.firstSeenAt.localeCompare(a.firstSeenAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_FLOWS_SHOWN)
    .map((f) => `<li><a href="${href(site, 'flows', flowFile(f))}">${esc(f.doc?.name ?? f.id)}</a> <span class="muted">${esc(f.kind)}</span>${f.status !== 'active' ? ` <span class="chip ${esc(f.status)}">${esc(FLOW_STATUS[f.status] ?? f.status)}</span>` : ''}</li>`)
    .join('');
  const runs = state.runs
    .slice(-MAX_FLOW_RUNS_SHOWN)
    .reverse()
    .map((r) => `<li><a href="${href(site, 'flows', 'runs', r.file)}">${esc(when(r.finishedAt))}</a>: ${r.added} new, ${r.changed} changed, ${r.missing} not seen, ${r.pagesVisited} page(s)</li>`)
    .join('');
  return `<p>${flows.length} flow(s) known · last pass ${esc(when(state.lastRunAt))} · <a href="${href(site, 'flows', 'index.md')}">All flows</a></p>
    ${chips ? `<p class="chips">${chips}</p>` : ''}
    ${listed ? `<ul class="flows">${listed}</ul>` : ''}
    ${flows.length > MAX_FLOWS_SHOWN ? `<p class="muted">…and ${flows.length - MAX_FLOWS_SHOWN} more in the index.</p>` : ''}
    ${runs ? `<h4>Recent passes</h4><ul class="flow-runs">${runs}</ul>` : ''}`;
}

function siteCard(s) {
  const latest = s.runs[0];
  return `<section class="site" id="${esc(s.site)}">
    <header>
      <h2>${esc(s.site)}</h2>
      ${healthBadge(latest?.health)}
      ${latest ? `<span class="muted">latest: ${SEVERITIES.map((sev) => `${latest.counts[sev]} ${sev}`).join(', ')}</span>` : ''}
    </header>
    <h3>QA runs</h3>
    ${runsTable(s.site, s.runs)}
    <h3>User flows</h3>
    ${flowsSection(s.site, s.flows)}
  </section>`;
}

export function renderDashboard(sites, generatedAt = new Date().toISOString()) {
  const totals = Object.fromEntries(SEVERITIES.map((s) => [s, sites.reduce((n, site) => n + (site.runs[0]?.counts[s] ?? 0), 0)]));
  const overview = sites.length
    ? `<div class="table-wrap"><table class="overview">
        <thead><tr><th>Site</th><th>Health</th>${SEVERITIES.map((s) => `<th class="num">${SEVERITY_LABEL[s]}</th>`).join('')}<th>Last QA run</th><th class="num">Flows</th><th>Last flow pass</th></tr></thead>
        <tbody>${sites
          .map((s) => {
            const r = s.runs[0];
            return `<tr><td><a href="#${esc(s.site)}">${esc(s.site)}</a></td><td>${healthBadge(r?.health)}</td>
              ${r ? countCells(r.counts) : SEVERITIES.map(() => '<td class="num">—</td>').join('')}
              <td>${esc(r ? (r.finishedAt ? when(r.finishedAt) : r.name) : '—')}</td>
              <td class="num">${s.flows ? Object.keys(s.flows.flows).length : '—'}</td><td>${esc(when(s.flows?.lastRunAt))}</td></tr>`;
          })
          .join('')}</tbody>
      </table></div>`
    : '<p class="empty">No reports yet. Run <code>npm run qa -- example.com</code> or <code>npm run flows -- example.com --once</code>.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qasis dashboard</title>
<style>
  :root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --card:#f7f7f9;
          --critical:#b3261e; --high:#d9480f; --medium:#9a6f00; --low:#4a6fa5;
          --good:#2e7d32; --fair:#9a6f00; --poor:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151517; --fg:#f2f2f4; --muted:#a1a1a6; --line:#2c2c30; --card:#1e1e21;
            --critical:#ff6b61; --high:#ff922b; --medium:#e0b84c; --low:#7aa2e3;
            --good:#66bb6a; --fair:#e0b84c; --poor:#ff6b61; }
  }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:32px 16px 64px; }
  h1 { margin:0 0 4px; font-size:1.6rem; }
  h2 { margin:0; font-size:1.25rem; overflow-wrap:anywhere; }
  h3 { margin:20px 0 8px; font-size:1rem; }
  h4 { margin:12px 0 4px; font-size:.9rem; }
  .muted, .empty { color:var(--muted); font-size:.9rem; }
  .totals { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:20px 0; }
  .totals div { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; text-align:center; }
  .totals b { display:block; font-size:1.5rem; }
  .site { border:1px solid var(--line); border-radius:10px; background:var(--card); padding:16px; margin:24px 0; }
  .site header { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; }
  .health, .chip { font-size:.75rem; font-weight:600; padding:2px 8px; border-radius:999px; border:1px solid currentColor; white-space:nowrap; }
  .health.good { color:var(--good); } .health.fair { color:var(--fair); } .health.poor { color:var(--poor); }
  .health.none { color:var(--muted); }
  .chip.new { color:var(--good); } .chip.changed { color:var(--medium); } .chip.missing { color:var(--muted); } .chip.active { color:var(--low); }
  .chips { display:flex; flex-wrap:wrap; gap:6px; }
  .table-wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.9rem; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:600; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  td.critical { color:var(--critical); font-weight:700; } td.high { color:var(--high); font-weight:700; }
  td.medium { color:var(--medium); font-weight:600; } td.low { color:var(--low); }
  .totals .critical b { color:var(--critical); } .totals .high b { color:var(--high); }
  .totals .medium b { color:var(--medium); } .totals .low b { color:var(--low); }
  .warn { color:var(--high); cursor:help; }
  ul.flows, ul.flow-runs { margin:4px 0; padding-left:20px; font-size:.9rem; }
  code { font-size:.85em; }
  a { color:inherit; }
</style>
</head>
<body>
<main>
  <h1>Qasis dashboard</h1>
  <p class="muted">${sites.length} site(s) · generated ${esc(when(generatedAt))} · rebuilt after every QA run and flow pass, or with <code>npm run dashboard</code></p>
  ${sites.some((s) => s.runs.length) ? `<div class="totals">${SEVERITIES.map((s) => `<div class="${s}"><b>${totals[s]}</b>${SEVERITY_LABEL[s]}</div>`).join('')}</div><p class="muted">Open issues across the latest QA run of each site.</p>` : ''}
  ${overview}
  ${sites.map(siteCard).join('')}
</main>
</body>
</html>
`;
}

/** Rebuild <outRoot>/index.html. Returns its path. */
export function buildDashboard(outRoot) {
  const path = join(outRoot, 'index.html');
  writeFileSync(path, renderDashboard(loadSites(outRoot)));
  return path;
}

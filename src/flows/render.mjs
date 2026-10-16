// Renders flow documentation as Markdown: one file per flow, an index of all
// flows, and a "what's new" note per run.
const STATUS_LABEL = { new: '🆕 New', changed: '✏️ Changed', active: 'Active', missing: '⚠️ Not seen in last run' };
const MAX_PAGES_LISTED = 20;

const day = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
export const flowFile = (flow) => `${flow.id}.md`;

export function renderFlow(flow) {
  const { doc } = flow;
  const out = [`# ${doc.name}`, ''];
  out.push(`- **Status:** ${STATUS_LABEL[flow.status] ?? flow.status}`);
  out.push(`- **Kind:** ${flow.kind} (${flow.source === 'form' ? 'form' : 'call to action'})`);
  out.push(`- **First seen:** ${day(flow.firstSeenAt)} · **Last seen:** ${day(flow.lastSeenAt)}${flow.changedAt ? ` · **Changed:** ${day(flow.changedAt)}` : ''}`);
  out.push(`- **Documented by:** ${doc.generatedBy}`);
  out.push(`- **ID:** \`${flow.id}\``, '');

  if (doc.changeNote) out.push('## What changed', '', doc.changeNote, '');
  out.push('## Purpose', '', doc.purpose, '');
  if (doc.preconditions) out.push('## Preconditions', '', doc.preconditions, '');
  out.push('## Steps', '', ...doc.steps.map((s, i) => `${i + 1}. ${s}`), '');
  out.push('## Expected outcome', '', doc.expectedOutcome, '');
  out.push('> Qasis finds flows without submitting forms or clicking buttons, so the outcome has not been verified.', '');

  if (flow.form) {
    const f = flow.form;
    out.push('## Form', '');
    out.push(`- **Method:** ${f.method.toUpperCase()} · **Action:** ${f.action ?? '(handled by the page\'s scripts)'}`);
    if (f.heading) out.push(`- **Heading:** ${f.heading}`);
    out.push(`- **Submit button:** ${f.submit ?? '—'}${f.visible ? '' : ' · hidden until revealed'}`, '');
    out.push('| Field | Name | Type | Required | Autocomplete |', '|---|---|---|---|---|');
    for (const field of f.fields) {
      out.push(`| ${cell(field.label || '—')} | ${cell(field.name ?? '—')} | ${field.type} | ${field.required ? 'yes' : ''} | ${cell(field.autocomplete ?? '')} |`);
    }
    out.push('');
  } else {
    out.push('## Call to action', '', `- **Text:** ${flow.cta.text}`, `- **Target:** ${flow.cta.href ?? '(a button handled by the page\'s scripts)'}`, '');
  }

  out.push('## Test ideas', '', ...doc.testIdeas.map((t) => `- [ ] ${t}`), '');
  out.push(`## Found on ${flow.pages.length} page(s)`, '', ...flow.pages.slice(0, MAX_PAGES_LISTED).map((p) => `- ${p}`));
  if (flow.pages.length > MAX_PAGES_LISTED) out.push(`- …and ${flow.pages.length - MAX_PAGES_LISTED} more`);
  out.push('');
  return out.join('\n');
}

export function renderIndex(state) {
  const flows = Object.values(state.flows).sort(
    (a, b) => (a.status === 'missing') - (b.status === 'missing') || b.firstSeenAt.localeCompare(a.firstSeenAt) || a.id.localeCompare(b.id),
  );
  const out = [`# User flows: ${state.origin}`, ''];
  out.push(`${flows.length} flow(s) known. Last run: ${day(state.lastRunAt)}.`, '');
  out.push('| Flow | Kind | Status | First seen | Last seen | Pages |', '|---|---|---|---|---|---|');
  for (const f of flows) {
    out.push(`| [${cell(f.doc?.name ?? f.id)}](${flowFile(f)}) | ${f.kind} | ${STATUS_LABEL[f.status] ?? f.status} | ${day(f.firstSeenAt)} | ${day(f.lastSeenAt)} | ${f.pages.length} |`);
  }
  if (state.runs.length) {
    out.push('', '## Recent runs', '');
    for (const r of state.runs.slice(-10).reverse()) {
      out.push(`- [${day(r.finishedAt)}](runs/${r.file}): ${r.added} new, ${r.changed} changed, ${r.missing} not seen, ${r.pagesVisited} page(s) crawled`);
    }
  }
  out.push('');
  return out.join('\n');
}

export function renderRun(run, merged, state, warnings) {
  const link = (f) => `[${f.doc?.name ?? f.id}](../${flowFile(f)})`;
  const out = [`# Flow discovery: ${state.origin}`, ''];
  out.push(`- **Run:** ${run.startedAt} → ${run.finishedAt}`);
  out.push(`- **Pages crawled:** ${run.pagesVisited} (depth ${run.settings.depth}, max ${run.settings.maxPages})`);
  out.push(`- **Flows found this run:** ${run.found} · **Known in total:** ${Object.keys(state.flows).length}`);
  for (const w of warnings) out.push(`- **Note:** ${w}`);
  out.push('');
  const section = (title, list, extra = () => '') => {
    if (!list.length) return;
    out.push(`## ${title} (${list.length})`, '', ...list.map((f) => `- ${link(f)} · ${f.kind}${extra(f)}`), '');
  };
  section('New flows', merged.added, (f) => (f.doc?.purpose ? ` — ${f.doc.purpose}` : ''));
  section('Changed flows', merged.changed, (f) => (f.doc?.changeNote ? ` — ${f.doc.changeNote}` : ''));
  section('No longer seen', merged.missing, () => ' (removed, or beyond this run\'s page limit)');
  if (!merged.added.length && !merged.changed.length && !merged.missing.length) out.push('No new or changed flows.', '');
  return out.join('\n');
}

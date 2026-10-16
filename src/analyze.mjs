// Turns raw crawl data into a report: findings grouped by severity, duplicates
// merged, written in plain language. The LLM does the judgement; the code
// first condenses the raw data so the prompt stays small, and afterwards
// enforces the severity order.
import Anthropic from '@anthropic-ai/sdk';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const CATEGORIES = ['javascript', 'network', 'broken-link', 'accessibility', 'performance', 'mobile', 'other'];

const DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-5' };

const MAX_GROUPS = 60; // per category, to keep the prompt bounded
const MAX_PAGES_PER_GROUP = 15;

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overallHealth', 'summary', 'issues', 'positives'],
  properties: {
    overallHealth: { type: 'string', enum: ['good', 'fair', 'poor'] },
    summary: { type: 'string', description: 'Two or three short paragraphs for the site owner.' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'title', 'explanation', 'affectedPages', 'evidence', 'recommendation'],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          category: { type: 'string', enum: CATEGORIES },
          title: { type: 'string' },
          explanation: { type: 'string', description: 'What is wrong and why it matters to visitors, in plain language.' },
          affectedPages: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string', description: 'Exact URLs, status codes, error messages or rule ids from the data.' },
          recommendation: { type: 'string' },
        },
      },
    },
    positives: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM_PROMPT = `You are a senior QA analyst. You receive the raw results of an automated QA pass over one website (headless Chromium, axe-core, link checks, load timings) and turn them into a report for the site owner, who may not be technical.

How to work:
- Merge duplicates. The same root cause often shows up several times: on many pages, or as both a console error and a failed request for the same URL. Report it once and list every affected page.
- Assign a severity:
  - critical: the site or a key page is unusable, e.g. the start page fails to load, pages return 5xx, an uncaught JavaScript error that likely breaks core functionality, or a critical accessibility violation that blocks a whole group of users.
  - high: clearly broken for many visitors, e.g. broken internal links to pages, failed scripts or stylesheets, serious accessibility violations, largest contentful paint over 4 seconds.
  - medium: degrades the experience, e.g. moderate accessibility violations, missing images or other non-essential 4xx resources, load times of 2.5 to 4 seconds, horizontal scrolling on mobile, no viewport meta tag (phones show a zoomed-out desktop layout).
  - low: minor or cosmetic, e.g. minor accessibility or best-practice rules, console noise with no visible effect.
- Report only what the data supports. Do not guess at causes you cannot see; say what was observed and the most likely fix.
- Write titles, explanations and recommendations in plain language. Put technical detail (URLs, status codes, error text, axe rule ids) in the evidence field.
- List issues from most to least severe.
- Under positives, note briefly what worked well (e.g. no JavaScript errors, fast loads), only where the data shows it.
- If there are no issues, return an empty issues list and say so in the summary.`;

function group(items, keyOf, pageOf, pick) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, { ...pick(item), pages: new Set(), occurrences: 0 });
    const g = groups.get(key);
    g.pages.add(pageOf(item));
    g.occurrences++;
  }
  const list = [...groups.values()].sort((a, b) => b.occurrences - a.occurrences);
  return {
    total: list.length,
    shown: list.slice(0, MAX_GROUPS).map(({ pages, ...g }) => ({
      ...g,
      pageCount: pages.size,
      pages: [...pages].slice(0, MAX_PAGES_PER_GROUP),
    })),
  };
}

/** Condense raw crawl data into grouped findings, small enough to send to the LLM. */
export function condenseFindings(data) {
  const perPage = (field) => data.pages.flatMap((p) => (p[field] ?? []).map((x) => ({ ...x, page: p.url })));
  const violations = data.pages.flatMap((p) => (p.accessibility?.violations ?? []).map((v) => ({ ...v, page: p.url })));

  return {
    site: data.origin,
    startUrl: data.startUrl,
    settings: { depth: data.settings.depth, maxPages: data.settings.maxPages },
    pagesVisited: data.pages.length,
    extraLinksChecked: data.linkChecks.length,
    pages: data.pages.map((p) => ({
      url: p.url,
      finalUrl: p.finalUrl !== p.url ? p.finalUrl : undefined,
      status: p.status,
      navigationError: p.navigationError ?? undefined,
      title: p.title,
      timing: p.timing,
      mobileViewportMeta: p.mobile?.hasViewportMeta,
      mobileHorizontalOverflow: p.mobile?.horizontalOverflow,
      mobileError: p.mobile?.error,
      accessibilityError: p.accessibility?.error,
    })),
    jsErrors: group(perPage('jsErrors'), (e) => e.message, (e) => e.page, (e) => ({ message: e.message, stack: e.stack })),
    consoleErrors: group(perPage('consoleErrors'), (e) => e.text, (e) => e.page, (e) => ({ text: e.text, source: e.location })),
    httpErrors: group(
      perPage('httpErrors'),
      (e) => `${e.status} ${e.url}`,
      (e) => e.page,
      (e) => ({ url: e.url, status: e.status, resourceType: e.resourceType }),
    ),
    failedRequests: group(
      perPage('failedRequests'),
      (e) => `${e.error} ${e.url}`,
      (e) => e.page,
      (e) => ({ url: e.url, error: e.error, resourceType: e.resourceType }),
    ),
    brokenLinks: data.brokenLinks.slice(0, MAX_GROUPS).map((b) => ({ ...b, linkedFrom: b.linkedFrom.slice(0, MAX_PAGES_PER_GROUP) })),
    accessibility: group(
      violations,
      (v) => v.id,
      (v) => v.page,
      (v) => ({ rule: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, tags: v.tags, sampleNodes: v.nodes.slice(0, 3) }),
    ),
  };
}

function sortIssues(report) {
  const rank = (s) => SEVERITIES.indexOf(s);
  report.issues.sort((a, b) => rank(a.severity) - rank(b.severity));
  return report;
}

async function callAnthropic({ apiKey, model, input }) {
  const client = new Anthropic({ apiKey });
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: REPORT_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `QA findings (JSON):\n\n${input}` }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new Error(`The model declined to write the report (${message.stop_details?.category ?? 'no category'}).`);
  }
  if (message.stop_reason === 'max_tokens') throw new Error('The model ran out of output tokens.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, model: message.model, usage: message.usage };
}

async function callOpenAI({ apiKey, model, input }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `QA findings (JSON):\n\n${input}` },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'qa_report', strict: true, schema: REPORT_SCHEMA } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI returned HTTP ${res.status}: ${body.error?.message ?? 'unknown error'}`);
  const choice = body.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`The model declined to write the report: ${choice.message.refusal}`);
  if (choice?.finish_reason === 'length') throw new Error('The model ran out of output tokens.');
  return { text: choice?.message?.content ?? '', model: body.model, usage: body.usage };
}

/**
 * Ask the configured LLM to write the report.
 * @returns {Promise<{ report: object, meta: object }>}
 */
export async function writeReportWithLlm(condensed, { provider, apiKey, model }) {
  const call = { anthropic: callAnthropic, openai: callOpenAI }[provider];
  if (!call) throw new Error(`Unsupported LLM provider: ${provider}`);
  const chosenModel = model || DEFAULT_MODELS[provider];
  const { text, model: usedModel, usage } = await call({ apiKey, model: chosenModel, input: JSON.stringify(condensed) });

  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error('The model returned a report that is not valid JSON.');
  }
  return { report: sortIssues(report), meta: { provider, model: usedModel ?? chosenModel, usage } };
}

/**
 * A report built without an LLM: one issue per finding group, with severity
 * from simple rules. Used with --no-ai or when the LLM call fails.
 */
export function writeBasicReport(condensed) {
  const issues = [];
  const add = (severity, category, title, explanation, affectedPages, evidence, recommendation) =>
    issues.push({ severity, category, title, explanation, affectedPages, evidence, recommendation });

  for (const p of condensed.pages) {
    if (p.navigationError || p.status >= 500) {
      add('critical', 'network', `Page failed to load: ${p.url}`, 'Visitors cannot open this page.', [p.url], p.navigationError ?? `HTTP ${p.status}`, 'Check the server logs for this URL.');
    }
    if (p.mobileViewportMeta === false) {
      add('medium', 'mobile', `Not set up for phones: ${p.url}`, 'The page has no viewport meta tag, so phones show a zoomed-out desktop layout.', [p.url], 'missing <meta name="viewport">', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
    }
    if (p.timing?.largestContentfulPaintMs > 4000) {
      add('high', 'performance', `Slow page: ${p.url}`, 'The main content takes more than 4 seconds to appear.', [p.url], `LCP ${p.timing.largestContentfulPaintMs} ms`, 'Reduce page weight and render-blocking resources.');
    }
    if (p.mobileHorizontalOverflow) {
      add('medium', 'mobile', `Page scrolls sideways on mobile: ${p.url}`, 'Content is wider than a phone screen.', [p.url], 'documentWidth > viewportWidth', 'Find the element that overflows and constrain its width.');
    }
  }
  for (const b of condensed.brokenLinks) {
    const failedPage = condensed.pages.find((p) => p.url === b.url && (p.navigationError || p.status >= 500));
    if (failedPage) continue; // reported above as a page that failed to load
    add('high', 'broken-link', `Broken link: ${b.url}`, 'A link on the site leads to an error.', b.linkedFrom, b.error ?? `HTTP ${b.status}`, 'Fix or remove the link.');
  }
  for (const e of condensed.jsErrors.shown) {
    add('high', 'javascript', `JavaScript error: ${e.message.slice(0, 80)}`, 'A script crashed while the page was running.', e.pages, e.message, 'Fix the script error.');
  }
  for (const e of condensed.httpErrors.shown) {
    add(e.status >= 500 ? 'high' : 'medium', 'network', `${e.resourceType} returned HTTP ${e.status}`, 'A file the page needs could not be loaded.', e.pages, `${e.status} ${e.url}`, 'Fix or remove the reference to this file.');
  }
  for (const e of condensed.failedRequests.shown) {
    add('medium', 'network', `Request failed: ${e.resourceType}`, 'A file the page needs could not be loaded.', e.pages, `${e.error} ${e.url}`, 'Check that the URL is reachable.');
  }
  const impactToSeverity = { critical: 'critical', serious: 'high', moderate: 'medium', minor: 'low' };
  for (const v of condensed.accessibility.shown) {
    add(impactToSeverity[v.impact] ?? 'low', 'accessibility', v.help, `Accessibility rule "${v.rule}" failed.`, v.pages, `${v.rule}: ${v.sampleNodes.map((n) => n.target).join(', ')}`, `See ${v.helpUrl}`);
  }

  const worst = issues.reduce((min, i) => Math.min(min, SEVERITIES.indexOf(i.severity)), SEVERITIES.length);
  return sortIssues({
    overallHealth: worst <= 0 ? 'poor' : worst <= 1 ? 'fair' : 'good',
    summary: `Automated checks found ${issues.length} issue(s) across ${condensed.pagesVisited} page(s). This report was generated without AI, so duplicates are not merged and severities follow fixed rules.`,
    issues,
    positives: [],
  });
}

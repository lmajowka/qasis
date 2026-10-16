// Finds the user flows a site offers: forms (sign up, log in, search, contact,
// newsletter, checkout…) and key calls to action that hand off to another step
// (an "Add to cart" button, a "Book a demo" link to a scheduling site).
//
// Discovery is read-only: forms are never filled or submitted and buttons are
// never clicked, so a run cannot create accounts, orders or messages.
//
// Every flow gets a stable key derived from its structure, not from any LLM
// output, so later runs can tell new and changed flows from known ones.
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { NON_PAGE_EXT, normalizeUrl, VIEWPORTS } from '../crawl.mjs';

const NAV_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 5_000;

// Calls to action, matched against link and button text. Order matters: the first match wins.
const CTA_PATTERNS = [
  ['checkout', /\b(add to (cart|bag|basket)|buy( it)? now|check ?out|order now|purchase)\b/i],
  ['signup', /\b(sign ?up|register|create (an |your )?account|get started|start (a |your )?(free )?trial|join (now|free|us))\b/i],
  ['login', /\b(log ?in|sign ?in)\b/i],
  ['booking', /\b((book|schedule|request) (a |an )?(demo|call|meeting|appointment|consultation)|book now)\b/i],
  ['contact', /\b(contact (us|sales|support)|get in touch)\b/i],
  ['newsletter', /\bsubscribe\b/i],
  ['download', /\b(download|install)\b/i],
];

export const FLOW_KINDS = ['signup', 'login', 'password-reset', 'search', 'contact', 'newsletter', 'checkout', 'booking', 'download', 'form'];

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'home';

/** "/products/123/reviews" -> "/products/:id/reviews", so one form on many item pages is one flow. */
export function pathTemplate(url) {
  const { pathname } = new URL(url);
  return pathname
    .split('/')
    .map((seg) => (/^\d+$|^[0-9a-f]{8,}$|^[0-9a-f-]{32,36}$/i.test(seg) ? ':id' : seg))
    .join('/') || '/';
}

// Runs in the page. Returns links, forms (with field structure, never values)
// and button texts outside forms.
function extractPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => clean(el?.innerText || el?.textContent || el?.value || el?.getAttribute?.('aria-label')).slice(0, 120);
  const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const HEADING = 'legend, h1, h2, h3, h4';

  const headingFor = (el) => {
    const own = el.querySelector(HEADING);
    if (own) return textOf(own);
    // Otherwise the closest heading before the form, at most three levels up.
    let node = el;
    for (let level = 0; node && node !== document.body && level < 3; level++, node = node.parentElement) {
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) {
        const h = s.matches(HEADING) ? s : s.querySelector(HEADING);
        if (h) return textOf(h);
      }
    }
    return clean(el.getAttribute('aria-label'));
  };

  const labelFor = (el) =>
    clean(
      el.labels?.[0]?.innerText ||
        el.getAttribute('aria-label') ||
        (el.getAttribute('aria-labelledby') || '')
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || '')
          .join(' ') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title'),
    ).slice(0, 80);

  const NON_FIELD = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
  const forms = [...document.forms].map((f) => {
    const submit = [...f.elements].find((e) => e.type === 'submit' || (e.tagName === 'BUTTON' && !e.getAttribute('type')));
    const action = f.getAttribute('action');
    return {
      formId: f.id || f.getAttribute('name') || null,
      // Only an explicit action identifies the endpoint; "" and "#" post back to the page itself.
      action: action && !/^#?$/.test(action.trim()) ? f.action : null,
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      heading: headingFor(f),
      submit: submit ? textOf(submit) : null,
      visible: isVisible(f),
      isSearch: f.getAttribute('role') === 'search' || !!f.closest('[role=search]'),
      fields: [...f.elements]
        .filter((e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && !NON_FIELD.has(e.type))
        .map((e) => ({
          name: e.name || e.id || null,
          type: e.tagName === 'INPUT' ? e.type : e.tagName.toLowerCase(),
          label: labelFor(e),
          required: e.required || e.getAttribute('aria-required') === 'true',
          autocomplete: e.getAttribute('autocomplete') || null,
        })),
    };
  });

  const links = [...document.querySelectorAll('a[href]')].map((a) => ({
    href: a.href,
    text: textOf(a) || clean(a.getAttribute('title')),
  }));
  const buttons = [...document.querySelectorAll('button, [role=button]')]
    .filter((b) => !b.closest('form') && isVisible(b))
    .map((b) => textOf(b))
    .filter(Boolean);

  return { title: document.title, links, forms, buttons: [...new Set(buttons)].slice(0, 200) };
}

function classifyForm(form, pageUrl) {
  const own = [form.heading, form.submit, form.formId, form.action && new URL(form.action).pathname].join(' ').toLowerCase();
  const types = form.fields.map((f) => f.type);
  const autocomplete = form.fields.map((f) => f.autocomplete ?? '').join(' ');
  const passwords = types.filter((t) => t === 'password').length;

  if (/\bcc-/.test(autocomplete) || /checkout|payment|billing/.test(own)) return 'checkout';
  if (passwords >= 2 || (passwords && /sign ?up|register|create|join/.test(own)) || (/new-password/.test(autocomplete) && !/current-password/.test(autocomplete))) {
    return 'signup';
  }
  if (passwords === 1) return 'login';
  if (/forgot|reset|recover/.test(own)) return 'password-reset';
  if (form.isSearch || types.includes('search') || form.fields.some((f) => /^(q|query|s|search|keywords?)$/i.test(f.name ?? ''))) return 'search';
  if (/subscribe|newsletter/.test(own) || (form.fields.length === 1 && types[0] === 'email')) return 'newsletter';
  if (types.includes('textarea') || /contact|message|enquir|inquir/.test(own)) return 'contact';
  if (/log ?in|sign ?in/.test(own)) return 'login';
  // Last resort: what the hosting page is about.
  const page = new URL(pageUrl).pathname.toLowerCase();
  if (/cart|basket|checkout/.test(page)) return 'checkout';
  if (/contact/.test(page)) return 'contact';
  return 'form';
}

const ctaKind = (text) => CTA_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null;

/** The fields that make up a form's shape; a change here means the flow changed. */
const formShape = (form) =>
  hash(JSON.stringify([form.method, form.submit ?? '', form.fields.map((f) => [f.name, f.type, f.required])]));

function formCandidate(form, page) {
  const kind = classifyForm(form, page.url);
  // A form with an explicit action is identified by its endpoint, so field
  // changes show up as "changed". An inline (JS) form has no endpoint, so its
  // field names identify it, wherever it appears (e.g. a footer newsletter).
  const target = form.action
    ? `${new URL(form.action).origin}${pathTemplate(form.action)}`
    : `inline:${form.fields.map((f) => f.name ?? f.type).sort().join(',')}`;
  const key = ['form', kind, form.method, target, form.formId ?? ''].join('|');
  // The id must depend only on the key; for an inline form, not on the page it was first seen on.
  const label = form.action ? pathTemplate(form.action) : target.slice('inline:'.length);
  return {
    id: `${kind}-${slug(label)}-${hash(key).slice(0, 6)}`,
    key,
    kind,
    source: 'form',
    shape: formShape(form),
    pages: [page.url],
    form,
  };
}

function ctaCandidate({ kind, text, href, external, page }) {
  const target = href ? (external ? new URL(href).origin + pathTemplate(href) : pathTemplate(href)) : 'button';
  const key = ['cta', kind, text.toLowerCase(), target].join('|');
  return {
    id: `${kind}-${slug(text)}-${hash(key).slice(0, 6)}`,
    key,
    kind,
    source: 'cta',
    shape: hash(target),
    pages: [page.url],
    cta: { text, href: href ?? null, external },
  };
}

/** Click path from the start page: [{ page, click }] using the link text that first led to each page. */
function entryPath(url, via) {
  const steps = [];
  for (let u = url; via.get(u); u = via.get(u).from) steps.unshift({ page: via.get(u).from, click: via.get(u).text || via.get(u).href });
  return steps;
}

/**
 * Crawl the site (same origin, breadth-first, call-to-action links first) and
 * return every flow found, merged across pages.
 * @param {string} startUrl
 * @param {{ depth: number, maxPages: number, log?: (msg: string) => void }} opts
 */
export async function discoverFlows(startUrl, { depth, maxPages, log = () => {} }) {
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error(`Not an http(s) URL: ${startUrl}`);
  const { origin } = new URL(start);

  const startedAt = new Date().toISOString();
  const browser = await chromium.launch();
  const context = await browser.newContext(VIEWPORTS.desktop);

  const queue = [{ url: start, depth: 0, priority: 1 }];
  const queued = new Set([start]);
  const via = new Map(); // url -> { from, text, href } of the first link that led there
  const flows = new Map(); // key -> candidate
  const visited = [];

  const addFlow = (candidate, url) => {
    const existing = flows.get(candidate.key);
    if (existing) {
      if (!existing.pages.includes(url)) existing.pages.push(url);
      return;
    }
    candidate.entry = entryPath(url, via);
    flows.set(candidate.key, candidate);
  };

  try {
    while (queue.length && visited.length < maxPages) {
      // Shallowest first; within a depth, links that look like a call to action first.
      queue.sort((a, b) => a.depth - b.depth || b.priority - a.priority);
      const { url, depth: level } = queue.shift();
      log(`[${visited.length + 1}/${maxPages}] ${url}`);

      const page = await context.newPage();
      let data;
      try {
        const res = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
        await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
        if (!res || res.status() >= 400 || !/html/i.test(res.headers()['content-type'] ?? '')) {
          visited.push({ url, status: res?.status() ?? null });
          continue;
        }
        data = await page.evaluate(extractPage);
        visited.push({ url, status: res.status(), title: data.title });
      } catch (err) {
        visited.push({ url, error: String(err.message).split('\n')[0] });
        continue;
      } finally {
        await page.close();
      }

      const current = { url };
      for (const form of data.forms) {
        if (form.fields.length) addFlow(formCandidate(form, current), url);
      }
      for (const text of data.buttons) {
        const kind = ctaKind(text);
        if (kind) addFlow(ctaCandidate({ kind, text, href: null, external: false, page: current }), url);
      }
      for (const link of data.links) {
        const href = normalizeUrl(link.href);
        if (!href) continue;
        const external = new URL(href).origin !== origin;
        const kind = link.text ? ctaKind(link.text) : null;
        // An off-site call to action is a handoff (checkout, booking) worth documenting.
        // A same-site one just leads to a page whose forms are found when it is visited.
        if (external) {
          if (kind) addFlow(ctaCandidate({ kind, text: link.text, href, external, page: current }), url);
          continue;
        }
        if (queued.has(href) || NON_PAGE_EXT.test(new URL(href).pathname)) continue;
        queued.add(href);
        via.set(href, { from: url, text: link.text, href });
        if (level < depth) queue.push({ url: href, depth: level + 1, priority: kind ? 1 : 0 });
      }
    }
  } finally {
    await browser.close();
  }

  return {
    startUrl: start,
    origin,
    startedAt,
    finishedAt: new Date().toISOString(),
    settings: { depth, maxPages },
    pagesVisited: visited,
    flows: [...flows.values()],
  };
}

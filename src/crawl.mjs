// Drives headless Chromium over one site and collects raw QA data:
// JS errors, failed and 4xx/5xx requests, broken links, axe-core accessibility
// violations, desktop and mobile screenshots, and load timings.
//
// Pages are visited breadth-first, one at a time, staying on the start URL's
// origin. Same-site links that are found but not visited (beyond the depth or
// page limit, or not HTML) still get an HTTP status check.
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, devices } from 'playwright';

const NAV_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 5_000;
const LINK_TIMEOUT_MS = 15_000;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
// Links to these are checked for status but not opened as pages.
const NON_PAGE_EXT = /\.(pdf|zip|gz|dmg|exe|png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3|wav|docx?|xlsx?|pptx?|csv|xml|json|txt)$/i;

const { defaultBrowserType: _, ...IPHONE } = devices['iPhone 13'];
export const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: IPHONE,
};

/** URL without its #fragment, or null for anything that is not http(s). */
export function normalizeUrl(href, base) {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function slugFor(url, index) {
  const { pathname, search } = new URL(url);
  const slug = (pathname + search)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${String(index + 1).padStart(2, '0')}-${slug || 'home'}`;
}

const firstLine = (msg) => String(msg).split('\n')[0];

/**
 * @param {string} startUrl
 * @param {{ depth: number, maxPages: number, screenshotDir: string, log?: (msg: string) => void }} opts
 */
export async function crawlSite(startUrl, { depth, maxPages, screenshotDir, log = () => {} }) {
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error(`Not an http(s) URL: ${startUrl}`);
  const { origin } = new URL(start);

  const startedAt = new Date().toISOString();
  const browser = await chromium.launch();
  const desktop = await browser.newContext(VIEWPORTS.desktop);
  const mobile = await browser.newContext(VIEWPORTS.mobile);

  const pages = [];
  const referrers = new Map(); // same-site url -> Set of pages linking to it
  const queue = [{ url: start, depth: 0 }];
  const queued = new Set([start]);
  const toCheck = new Set(); // same-site links not opened as pages

  try {
    while (queue.length && pages.length < maxPages) {
      const { url, depth: level } = queue.shift();
      if (NON_PAGE_EXT.test(new URL(url).pathname)) {
        toCheck.add(url);
        continue;
      }

      log(`[${pages.length + 1}/${maxPages}] ${url}`);
      const result = await auditPage({ desktop, mobile, url, level, screenshotDir, slug: slugFor(url, pages.length) });
      pages.push(result);

      for (const link of result.links) {
        if (new URL(link).origin !== origin) continue;
        if (!referrers.has(link)) referrers.set(link, new Set());
        referrers.get(link).add(url);
        if (queued.has(link)) continue;
        queued.add(link);
        if (level < depth) queue.push({ url: link, depth: level + 1 });
        else toCheck.add(link);
      }
    }
    for (const { url } of queue) toCheck.add(url); // left over once maxPages was reached

    if (toCheck.size) log(`Checking ${toCheck.size} more same-site link(s)…`);
    const linkChecks = [];
    for (const url of toCheck) {
      linkChecks.push({ url, ...(await checkLink(desktop.request, url)) });
    }

    return {
      startUrl: start,
      origin,
      startedAt,
      finishedAt: new Date().toISOString(),
      settings: { depth, maxPages, viewports: { desktop: VIEWPORTS.desktop.viewport, mobile: VIEWPORTS.mobile.viewport }, axeTags: AXE_TAGS },
      pages,
      linkChecks,
      brokenLinks: findBrokenLinks(pages, linkChecks, referrers),
    };
  } finally {
    await browser.close();
  }
}

async function auditPage({ desktop, mobile, url, level, screenshotDir, slug }) {
  const page = await desktop.newPage();
  const consoleErrors = [];
  const jsErrors = [];
  const failedRequests = [];
  const httpErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push({ text: msg.text().slice(0, 1000), location: msg.location().url || null });
  });
  page.on('pageerror', (err) => {
    jsErrors.push({ message: err.message.slice(0, 1000), stack: err.stack?.split('\n').slice(0, 6).join('\n') ?? null });
  });
  // The page's own status and load errors are recorded separately (and as broken links).
  const isOwnDocument = (req) => req.isNavigationRequest() && req.frame() === page.mainFrame();

  page.on('requestfailed', (req) => {
    const error = req.failure()?.errorText ?? 'unknown';
    // ERR_ABORTED is the browser cancelling a request (navigation, media preload), not a site fault.
    if (error.includes('ERR_ABORTED') || isOwnDocument(req)) return;
    failedRequests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType(), error });
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !isOwnDocument(res.request())) {
      httpErrors.push({ url: res.url(), status: res.status(), method: res.request().method(), resourceType: res.request().resourceType() });
    }
  });

  const result = { url, depth: level, finalUrl: null, status: null, navigationError: null, contentType: null };
  try {
    const t0 = Date.now();
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      result.navigationError = firstLine(err.message);
    }
    result.loadWallClockMs = Date.now() - t0;
    // Give late scripts and XHRs a moment so their errors are captured too.
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});

    result.finalUrl = page.url();
    result.status = response?.status() ?? null;
    result.contentType = response?.headers()['content-type'] ?? null;
    // Error pages are reported as broken links; auditing their content adds noise.
    const isHtml = !result.navigationError && result.status < 400 && /html/i.test(result.contentType ?? '');

    if (isHtml) {
      result.title = await page.title();
      result.timing = await collectTiming(page);
      result.links = await collectLinks(page);
      result.accessibility = await runAxe(page);
      result.screenshots = { desktop: join(screenshotDir, `${slug}-desktop.png`) };
      await page.screenshot({ path: result.screenshots.desktop, fullPage: true });
      Object.assign(result, await auditMobile(mobile, url, join(screenshotDir, `${slug}-mobile.png`)));
      result.screenshots.mobile = result.mobile.screenshot;
    } else {
      result.links = [];
    }
  } finally {
    await page.close();
  }

  return { ...result, jsErrors, consoleErrors, failedRequests, httpErrors };
}

async function collectTiming(page) {
  return page.evaluate(async () => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, p.startTime]));
    const lcp = await new Promise((resolve) => {
      new PerformanceObserver((list) => resolve(list.getEntries().at(-1)?.startTime ?? null)).observe({
        type: 'largest-contentful-paint',
        buffered: true,
      });
      setTimeout(() => resolve(null), 500);
    });
    const round = (n) => (n == null ? null : Math.round(n));
    return {
      ttfbMs: round(nav?.responseStart),
      firstContentfulPaintMs: round(paints['first-contentful-paint']),
      largestContentfulPaintMs: round(lcp),
      domContentLoadedMs: round(nav?.domContentLoadedEventEnd),
      loadEventMs: round(nav?.loadEventEnd),
      transferBytes: nav?.transferSize ?? null,
      resourceCount: performance.getEntriesByType('resource').length,
    };
  });
}

async function collectLinks(page) {
  const hrefs = await page.$$eval('a[href]', (anchors) => anchors.map((a) => a.href));
  return [...new Set(hrefs.map((h) => normalizeUrl(h)).filter(Boolean))];
}

async function runAxe(page) {
  try {
    const { violations, incomplete, passes } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    return {
      violations: violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        tags: v.tags.filter((t) => t.startsWith('wcag') || t === 'best-practice'),
        nodeCount: v.nodes.length,
        nodes: v.nodes.slice(0, 10).map((n) => ({
          target: n.target.join(' '),
          html: n.html.slice(0, 300),
          failureSummary: n.failureSummary?.slice(0, 500) ?? null,
        })),
      })),
      incompleteCount: incomplete.length,
      passCount: passes.length,
    };
  } catch (err) {
    return { error: firstLine(err.message) };
  }
}

async function auditMobile(context, url, screenshotPath) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    const layout = await page.evaluate(() => ({
      hasViewportMeta: !!document.querySelector('meta[name="viewport" i]'),
      // Mobile Chromium widens the layout viewport to fit overflowing content,
      // so compare against the device's screen width, not innerWidth.
      viewportWidth: window.screen.width,
      documentWidth: document.documentElement.scrollWidth,
    }));
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return {
      mobile: {
        screenshot: screenshotPath,
        ...layout,
        // Without a viewport meta tag the phone lays the page out at desktop
        // width and zooms out, so sideways overflow only means something with one.
        horizontalOverflow: layout.hasViewportMeta && layout.documentWidth > layout.viewportWidth + 1,
      },
    };
  } catch (err) {
    return { mobile: { screenshot: null, error: firstLine(err.message) } };
  } finally {
    await page.close();
  }
}

async function checkLink(request, url) {
  const opts = { timeout: LINK_TIMEOUT_MS, maxRedirects: 10, failOnStatusCode: false };
  try {
    let res = await request.head(url, opts);
    // Some servers reject or mishandle HEAD; confirm any failure with GET.
    if (res.status() >= 400) res = await request.get(url, opts);
    return { status: res.status() };
  } catch (err) {
    return { status: null, error: firstLine(err.message) };
  }
}

function findBrokenLinks(pages, linkChecks, referrers) {
  const broken = [];
  for (const p of pages) {
    if (p.navigationError || (p.status ?? 0) >= 400) {
      broken.push({ url: p.url, status: p.status, error: p.navigationError });
    }
  }
  for (const c of linkChecks) {
    if (c.error || c.status >= 400) broken.push({ url: c.url, status: c.status, error: c.error ?? null });
  }
  return broken.map((b) => ({ ...b, linkedFrom: [...(referrers.get(b.url) ?? [])] }));
}

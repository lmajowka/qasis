#!/usr/bin/env node
// Qasis: one QA pass over one website.
//
//   node src/cli.mjs <url> [--depth 2] [--max-pages 20] [--format both|md|html] [--no-ai] [--out reports]
//
// Writes reports/<site>/<date>/ with report.md / report.html, screenshots/,
// and raw/ (everything collected, plus what was sent to and returned by the LLM).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { condenseFindings, SEVERITIES, writeBasicReport, writeReportWithLlm } from './analyze.mjs';
import { loadLlmSettings } from './config.mjs';
import { crawlSite } from './crawl.mjs';
import { renderHtml, renderMarkdown } from './report.mjs';

const USAGE = `Usage: npm run qa -- <url> [options]

Options:
  --depth <n>       How many clicks away from the start URL to follow same-site links (default 2)
  --max-pages <n>   Maximum number of pages to open (default 20)
  --format <f>      Report format: both, md or html (default both)
  --no-ai           Skip the LLM; write a rule-based report instead
  --out <dir>       Output root directory (default reports)
  -h, --help        Show this help`;

function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      depth: { type: 'string', default: '2' },
      'max-pages': { type: 'string', default: '20' },
      format: { type: 'string', default: 'both' },
      'no-ai': { type: 'boolean', default: false },
      out: { type: 'string', default: 'reports' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const int = (name, min) => {
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer ≥ ${min}`);
    return n;
  };
  if (!['both', 'md', 'html'].includes(values.format)) throw new Error('--format must be both, md or html');

  const raw = positionals[0];
  return {
    url: /^https?:\/\//i.test(raw) ? raw : `https://${raw}`,
    depth: int('depth', 0),
    maxPages: int('max-pages', 1),
    format: values.format,
    useAi: !values['no-ai'],
    outRoot: resolve(values.out),
  };
}

/** reports/<host>/<YYYY-MM-DD>, with -2, -3… if that run directory already exists. */
function makeRunDir(outRoot, url) {
  const site = new URL(url).host.replace(/[^a-z0-9.-]/gi, '_');
  const date = new Date().toISOString().slice(0, 10);
  let dir = join(outRoot, site, date);
  for (let n = 2; existsSync(dir); n++) dir = join(outRoot, site, `${date}-${n}`);
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  mkdirSync(join(dir, 'raw'), { recursive: true });
  return dir;
}

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const log = (msg) => console.error(msg);

async function main() {
  const opts = parseOptions(process.argv.slice(2));

  // Load the key before crawling so a missing setup fails in seconds, not minutes.
  const llm = opts.useAi ? loadLlmSettings() : null;

  const runDir = makeRunDir(opts.outRoot, opts.url);
  log(`Qasis QA pass: ${opts.url} (depth ${opts.depth}, max ${opts.maxPages} pages)`);

  const data = await crawlSite(opts.url, {
    depth: opts.depth,
    maxPages: opts.maxPages,
    screenshotDir: join(runDir, 'screenshots'),
    log,
  });
  // Store screenshot paths relative to the run directory so it can be moved or shared.
  for (const page of data.pages) {
    for (const [size, path] of Object.entries(page.screenshots ?? {})) {
      if (path) page.screenshots[size] = relative(runDir, path);
    }
    if (page.mobile?.screenshot) page.mobile.screenshot = relative(runDir, page.mobile.screenshot);
  }
  writeJson(join(runDir, 'raw', 'findings.json'), data);

  const condensed = condenseFindings(data);
  writeJson(join(runDir, 'raw', 'condensed.json'), condensed);

  let report;
  let meta = {};
  if (llm) {
    log(`Writing the report with ${llm.provider}…`);
    try {
      ({ report, meta } = await writeReportWithLlm(condensed, llm));
      writeJson(join(runDir, 'raw', 'llm-report.json'), { meta, report });
    } catch (err) {
      log(`⚠ LLM step failed: ${err.message}\n  Falling back to a rule-based report.`);
      meta = { warning: `The AI step failed (${err.message}); this report uses basic rules instead.` };
    }
  }
  report ??= writeBasicReport(condensed);

  const written = [];
  if (opts.format !== 'html') {
    writeFileSync(join(runDir, 'report.md'), renderMarkdown(report, data, meta));
    written.push('report.md');
  }
  if (opts.format !== 'md') {
    writeFileSync(join(runDir, 'report.html'), renderHtml(report, data, meta));
    written.push('report.html');
  }

  const counts = SEVERITIES.map((s) => `${report.issues.filter((i) => i.severity === s).length} ${s}`).join(', ');
  console.log(`\n✓ ${data.pages.length} page(s) checked: ${counts}`);
  const shown = relative(process.cwd(), runDir);
  const dir = shown.startsWith('..') ? runDir : shown;
  console.log(`✓ Report: ${join(dir, written[0])}${written[1] ? ` (also ${written[1]})` : ''}`);
}

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}

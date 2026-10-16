#!/usr/bin/env node
// Qasis flow discovery: finds the user flows a site offers (sign up, log in,
// search, contact, checkout…) and documents new and changed ones.
//
//   node src/flows-cli.mjs <url> [--once] [--every <hours>] [--depth 3] [--max-pages 40] [--no-ai] [--out reports]
//
// By default it keeps running and repeats every 4 hours (`flowDiscovery.intervalHours`
// in ~/.config/qasis/config.json, or --every). --once does a single pass.
// Writes reports/<site>/flows/ (see src/flows/run.mjs).
import { relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { flowIntervalHours, loadLlmSettings } from './config.mjs';
import { runFlowDiscovery } from './flows/run.mjs';
import { acquireLock, flowsDir, loadState } from './flows/store.mjs';

const USAGE = `Usage: npm run flows -- <url> [options]

Finds the user flows on a site and documents new and changed ones.
Keeps running and repeats on a schedule unless --once is given.

Options:
  --once            Run one pass and exit
  --every <hours>   Hours between passes (default: flowDiscovery.intervalHours in config.json, else 4)
  --depth <n>       How many clicks away from the start URL to follow same-site links (default 3)
  --max-pages <n>   Maximum number of pages to open per pass (default 40)
  --no-ai           Skip the LLM; document flows with basic rules instead
  --out <dir>       Output root directory (default reports)
  -h, --help        Show this help`;

// The schedule is checked this often, so a laptop waking from sleep catches up promptly.
const TICK_MS = 60_000;

function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      once: { type: 'boolean', default: false },
      every: { type: 'string' },
      depth: { type: 'string', default: '3' },
      'max-pages': { type: 'string', default: '40' },
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
  let everyHours = flowIntervalHours();
  if (values.every !== undefined) {
    everyHours = Number(values.every);
    if (!(everyHours >= 0.1)) throw new Error('--every must be a number of hours ≥ 0.1');
  }

  const raw = positionals[0];
  return {
    url: /^https?:\/\//i.test(raw) ? raw : `https://${raw}`,
    once: values.once,
    everyHours,
    depth: int('depth', 0),
    maxPages: int('max-pages', 1),
    useAi: !values['no-ai'],
    outRoot: resolve(values.out),
  };
}

const log = (msg) => console.error(msg);
const shown = (path) => {
  const rel = relative(process.cwd(), path);
  return rel.startsWith('..') ? path : rel;
};
const clock = (ms) => new Date(ms).toLocaleString();

async function pass(opts, dir, llm) {
  log(`\nQasis flow discovery: ${opts.url} (depth ${opts.depth}, max ${opts.maxPages} pages) — ${clock(Date.now())}`);
  const { run, merged } = await runFlowDiscovery({ url: opts.url, dir, depth: opts.depth, maxPages: opts.maxPages, llm, log });
  console.log(`✓ ${run.found} flow(s) found: ${run.added} new, ${run.changed} changed, ${run.missing} no longer seen`);
  for (const f of [...merged.added, ...merged.changed]) console.log(`  ${f.status === 'new' ? '+' : '~'} ${f.doc.name}`);
  console.log(`✓ Docs: ${shown(dir)}/index.md (this run: ${shown(dir)}/runs/${run.file})`);
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));

  // Load the key before crawling so a missing setup fails in seconds, not minutes.
  const llm = opts.useAi ? loadLlmSettings() : null;
  const dir = flowsDir(opts.outRoot, opts.url);
  acquireLock(dir);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(130));

  if (opts.once) return pass(opts, dir, llm);

  const intervalMs = opts.everyHours * 3_600_000;
  // Pick up the schedule where the last run left it, so restarting does not run early.
  const lastRunAt = loadState(dir, null).lastRunAt;
  let nextRunAt = lastRunAt ? Date.parse(lastRunAt) + intervalMs : Date.now();
  log(`Watching ${opts.url}: a pass every ${opts.everyHours} hour(s). Press Ctrl+C to stop.`);

  for (;;) {
    if (Date.now() < nextRunAt) {
      log(`Next pass at ${clock(nextRunAt)}.`);
      while (Date.now() < nextRunAt) await sleep(Math.min(TICK_MS, nextRunAt - Date.now()));
    }
    try {
      await pass(opts, dir, llm);
    } catch (err) {
      // One failed pass (site down, network blip) should not end the schedule.
      log(`✗ Pass failed: ${err.message}`);
    }
    nextRunAt = Date.now() + intervalMs;
  }
}

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}

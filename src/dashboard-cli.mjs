#!/usr/bin/env node
// Rebuilds the dashboard: <out>/index.html, an overview of every site's QA runs and flows.
//
//   node src/dashboard-cli.mjs [--out reports]
import { mkdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildDashboard } from './dashboard.mjs';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'reports' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log('Usage: npm run dashboard -- [--out <dir>]\n\nWrites <dir>/index.html (default reports/index.html).');
  process.exit(0);
}

const outRoot = resolve(values.out);
mkdirSync(outRoot, { recursive: true });
const path = buildDashboard(outRoot);
const rel = relative(process.cwd(), path);
console.log(`✓ Dashboard: ${rel.startsWith('..') ? path : rel}`);

// Per-site flow state: every flow ever found, when it was first and last seen,
// and its documentation. Lives at reports/<site>/flows/state.json so each run
// can tell new and changed flows from known ones.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { siteSlug } from '../crawl.mjs';

const STATE_VERSION = 1;
const MAX_RUN_HISTORY = 100;

export const flowsDir = (outRoot, url) => join(outRoot, siteSlug(url), 'flows');

export function loadState(dir, origin) {
  try {
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    if (state.version === STATE_VERSION) return state;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${join(dir, 'state.json')}: ${err.message}`);
  }
  return { version: STATE_VERSION, origin, lastRunAt: null, flows: {}, runs: [] };
}

/** Written to a temp file first, so a crash mid-write cannot corrupt the state. */
export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'state.json');
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

/**
 * Merge this run's discovered flows into the state.
 * @returns {{ added: object[], changed: object[], unchanged: object[], missing: object[] }} state entries;
 *   `missing` holds only flows that disappeared in this run
 */
export function mergeFlows(state, discovered, now) {
  const result = { added: [], changed: [], unchanged: [], missing: [] };
  const seen = new Set();

  for (const flow of discovered) {
    seen.add(flow.id);
    const known = state.flows[flow.id];
    if (!known) {
      state.flows[flow.id] = { ...flow, status: 'new', firstSeenAt: now, lastSeenAt: now, changedAt: null, previous: null, doc: null };
      result.added.push(state.flows[flow.id]);
    } else if (known.shape !== flow.shape) {
      const previous = { form: known.form, cta: known.cta, shape: known.shape };
      state.flows[flow.id] = { ...known, ...flow, status: 'changed', lastSeenAt: now, changedAt: now, previous, doc: known.doc };
      result.changed.push(state.flows[flow.id]);
    } else {
      // Keep the first entry path, so docs do not churn when crawl order shifts.
      Object.assign(known, { pages: flow.pages, status: 'active', lastSeenAt: now });
      result.unchanged.push(known);
    }
  }
  // Not seen this run: maybe removed, maybe just past this run's page limit.
  // Only flows that went missing this run are reported.
  for (const flow of Object.values(state.flows)) {
    if (!seen.has(flow.id) && flow.status !== 'missing') {
      flow.status = 'missing';
      result.missing.push(flow);
    }
  }
  return result;
}

export function recordRun(state, run) {
  state.lastRunAt = run.finishedAt;
  state.runs = [...state.runs, run].slice(-MAX_RUN_HISTORY);
}

/**
 * One discovery process per site at a time, or two would overwrite each
 * other's state. A lock left by a process that died is taken over.
 * @returns {() => void} release
 */
export function acquireLock(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '.lock');
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid !== process.pid;
    } catch (err) {
      alive = err.code === 'EPERM';
    }
    if (alive) throw new Error(`Flow discovery is already running for this site (pid ${pid}). Lock: ${path}`);
  }
  writeFileSync(path, String(process.pid));
  const release = () => rmSync(path, { force: true });
  process.once('exit', release);
  return release;
}

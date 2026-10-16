// One flow-discovery pass over one site: crawl, merge into the stored state,
// document new and changed flows, and write the Markdown docs.
//
// reports/<site>/flows/
//   index.md            every known flow with its status
//   <flow-id>.md        documentation for one flow
//   runs/<time>.md      what was new, changed or no longer seen in that run
//   state.json          what later runs compare against
//   raw/discovery.json  everything the last crawl found
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverFlows } from './discover.mjs';
import { BASIC_GENERATOR, documentFlows } from './document.mjs';
import { flowFile, renderFlow, renderIndex, renderRun } from './render.mjs';
import { loadState, mergeFlows, recordRun, saveState } from './store.mjs';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

/**
 * @param {{ url: string, dir: string, depth: number, maxPages: number, llm: object | null, log?: (msg: string) => void }} opts
 */
export async function runFlowDiscovery({ url, dir, depth, maxPages, llm, log = () => {} }) {
  const discovery = await discoverFlows(url, { depth, maxPages, log });
  const state = loadState(dir, discovery.origin);
  const merged = mergeFlows(state, discovery.flows, discovery.finishedAt);

  // New and changed flows, plus any still-present flow that only has a rule-based
  // doc (from --no-ai or a failed AI step) once an LLM is available again.
  const toDocument = [...merged.added, ...merged.changed];
  if (llm) toDocument.push(...merged.unchanged.filter((f) => f.doc?.generatedBy === BASIC_GENERATOR));
  const { meta, warnings } = toDocument.length
    ? await documentFlows(toDocument, { llm, startUrl: discovery.startUrl, log })
    : { meta: [], warnings: [] };

  const file = `${discovery.finishedAt.replace(/[:.]/g, '-')}.md`;
  const run = {
    file,
    startedAt: discovery.startedAt,
    finishedAt: discovery.finishedAt,
    settings: discovery.settings,
    pagesVisited: discovery.pagesVisited.length,
    found: discovery.flows.length,
    added: merged.added.length,
    changed: merged.changed.length,
    missing: merged.missing.length,
    llm: meta,
    warnings,
  };
  recordRun(state, run);

  mkdirSync(join(dir, 'runs'), { recursive: true });
  mkdirSync(join(dir, 'raw'), { recursive: true });
  for (const flow of Object.values(state.flows)) writeFileSync(join(dir, flowFile(flow)), renderFlow(flow));
  writeFileSync(join(dir, 'runs', file), renderRun(run, merged, state, warnings));
  writeFileSync(join(dir, 'index.md'), renderIndex(state));
  writeJson(join(dir, 'raw', 'discovery.json'), discovery);
  saveState(dir, state); // last, so a failed write above is retried by the next run

  return { run, merged };
}

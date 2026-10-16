# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Qasis runs a QA pass over a single website (headless Chromium + axe-core). An LLM then turns the findings into a severity-ranked report. It is plain Node.js ESM (`.mjs`, Node 22+). There is no build step, no TypeScript, no test suite and no linter.

## Commands

```bash
bash qasis.sh                 # interactive installer: pick provider, enter API key (needs a real TTY)
bash qasis.sh --status        # same as: npm run status
bash qasis.sh --uninstall     # same as: npm run uninstall

npm install && npx playwright install chromium   # needed only for the QA runner
npm run qa -- example.com --depth 1 --max-pages 5 --no-ai   # quick run without an API key
npm run qa -- https://example.com --format html
npm run flows -- example.com --once --no-ai --depth 1 --max-pages 5   # one flow-discovery pass
npm run flows -- example.com                                         # watch: a pass every 4 h
npm run dashboard                      # rebuild reports/index.html (also rebuilt after every qa run and flow pass)
npm run watch -- example.com --no-ai   # same watch, as a launchd/systemd user service; npm run unwatch -- example.com
cd dashboard && bin/rails server       # live Rails dashboard at http://localhost:3000
```

Output goes to `reports/<host>/<YYYY-MM-DD>[-N]/`, which is gitignored. To check a change, run a small `--no-ai` pass and inspect `report.md` and the `raw/*.json` files.

## Architecture

There are two halves, and they deliberately have different dependency rules.

**`setup/` is the installer. It uses Node built-ins only, with no npm dependencies.** This is a security property stated in the README. Do not import third-party packages here.
- `index.mjs` handles the install/status/uninstall flow. `prompt.mjs` reads the hidden key in raw TTY mode. `providers.mjs` checks the key format and verifies it with a read-only `GET /v1/models`.
- `credentials.mjs` has three backends: macOS Keychain (`security -i`, with the key passed on stdin), Linux Secret Service (`secret-tool`), and a `0600` file fallback at `~/.config/qasis/credentials.json`. Keys never go in argv or env vars. Shell quoting in the Keychain backend is only safe because `KEY_PATTERN` in `providers.mjs` restricts the charset, so keep that validation if you touch either file.
- `service.mjs` installs one background service per watched site: a launchd LaunchAgent on macOS, a systemd user unit on Linux. It runs `src/flows-cli.mjs` in watch mode and appends output to `reports/<site>/flows/service.log`. A `qasis-site:` comment in each service file records the URL, which is how `--status` and `--uninstall` find them. It copies `siteSlug()` from `src/crawl.mjs`, so keep the two the same. `npm run watch` checks Playwright by spawning a child `node`, so setup itself never imports it.
- Non-secret settings (`provider`, `credentialStore`, optional `model`) live in `~/.config/qasis/config.json` (honours `XDG_CONFIG_HOME`).

**`src/` is the QA runner.** It uses Playwright, `@axe-core/playwright` and `@anthropic-ai/sdk`. The pipeline is driven by `cli.mjs`:
1. `config.mjs` `loadLlmSettings()` reads config plus the key through `setup/credentials.mjs`. This runs *before* crawling so that a missing setup fails fast.
2. `crawl.mjs` `crawlSite()` does a breadth-first crawl, one page at a time, restricted to the start URL's origin. It uses separate desktop (1440×900) and mobile (iPhone 13) contexts. It collects JS errors, failed and 4xx/5xx requests, axe violations, screenshots and timings. Same-site links that are not visited still get a HEAD/GET status check. The result is written to `raw/findings.json`.
3. `analyze.mjs` `condenseFindings()` groups the raw data and caps its size (`MAX_GROUPS`, `MAX_PAGES_PER_GROUP`) so the prompt stays bounded. The result is written to `raw/condensed.json`. Screenshots are never sent to the LLM.
4. `writeReportWithLlm()` (via `callLlmJson()` in `llm.mjs`) asks for structured JSON that matches `REPORT_SCHEMA`. The Anthropic path uses the SDK with streaming, a JSON-schema `output_config`, adaptive thinking and server-side fallbacks. The OpenAI path uses raw `fetch` with `response_format: json_schema`. If this step fails, `writeBasicReport()` produces the same report shape from fixed rules, and the report carries a warning.
5. `report.mjs` renders the report object to Markdown and/or HTML.

The report object (`overallHealth`, `summary`, `issues[]`, `positives[]`) is the contract between the LLM path, the rule-based fallback and the renderers. If you change `REPORT_SCHEMA`, update `writeBasicReport()` and both renderers to match. Severities (`critical/high/medium/low`) and categories are defined once in `analyze.mjs`. The severity rubric lives in `SYSTEM_PROMPT` and is mirrored by the fixed rules in `writeBasicReport()`.

To add an LLM provider, touch three places: `PROVIDERS` in `setup/providers.mjs`, `DEFAULT_MODELS`, and the `call*` dispatch in `src/llm.mjs`. Every LLM call goes through `callLlmJson()`.

**`src/flows/` is flow discovery.** It is driven by `src/flows-cli.mjs`, which runs one pass with `--once`, or otherwise loops every `--every` / `flowDiscovery.intervalHours` / 4 hours. It reschedules from `state.lastRunAt` and holds a per-site `.lock`.
1. `discover.mjs` `discoverFlows()` crawls read-only (it never submits or clicks). It extracts forms and calls to action, classifies their kind with heuristics, and gives each a stable `id`/`key` built from structure alone, plus a `shape` hash used to detect changes. Keep IDs deterministic and independent of crawl order, because the new/changed detection depends on that.
2. `store.mjs` `mergeFlows()` diffs the run against `reports/<site>/flows/state.json` into added, changed, unchanged and newly missing.
3. `document.mjs` `documentFlows()` has the LLM write docs (`DOCS_SCHEMA`) for new and changed flows. `basicDoc()` is the same shape built from rules, used as the fallback.
4. `render.mjs` writes `<id>.md`, `index.md` and `runs/<time>.md`. `run.mjs` ties a single pass together.

**`src/dashboard.mjs`** builds `reports/index.html` across all sites by reading only files on disk: each QA run's `raw/report.json` (written by `cli.mjs` as `{ run, meta, report }`; older runs fall back to `llm-report.json` or re-derive from `condensed.json` via `writeBasicReport()`) and each site's `flows/state.json`. `cli.mjs` and `flows-cli.mjs` rebuild it after each run; a failure there is only a warning.

**`dashboard/` is a Rails 8 app (Ruby 3.4) that shows a live, read-only view** of the same data, plus things the static `reports/index.html` cannot show: whether setup is complete, and the state of each watch service. It has no database. The plain Ruby classes under `app/models/qasis/` read `config.json`, `reports/` and the service files directly. They duplicate rules from the Node side: `siteSlug()`, the service file names and the `qasis-site:` marker from `setup/service.mjs`, the `.lock` file from `store.mjs`, and the log lines `flows-cli.mjs` prints (used to tell whether a pass is running). If you change any of those, update the dashboard too. It must never read the API key. On macOS it checks with `security find-generic-password` without `-w`.

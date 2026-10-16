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
```

Output goes to `reports/<host>/<YYYY-MM-DD>[-N]/`, which is gitignored. To check a change, run a small `--no-ai` pass and inspect `report.md` and the `raw/*.json` files.

## Architecture

There are two halves, and they deliberately have different dependency rules.

**`setup/` is the installer. It uses Node built-ins only, with no npm dependencies.** This is a security property stated in the README. Do not import third-party packages here.
- `index.mjs` handles the install/status/uninstall flow. `prompt.mjs` reads the hidden key in raw TTY mode. `providers.mjs` checks the key format and verifies it with a read-only `GET /v1/models`.
- `credentials.mjs` has three backends: macOS Keychain (`security -i`, with the key passed on stdin), Linux Secret Service (`secret-tool`), and a `0600` file fallback at `~/.config/qasis/credentials.json`. Keys never go in argv or env vars. Shell quoting in the Keychain backend is only safe because `KEY_PATTERN` in `providers.mjs` restricts the charset, so keep that validation if you touch either file.
- Non-secret settings (`provider`, `credentialStore`, optional `model`) live in `~/.config/qasis/config.json` (honours `XDG_CONFIG_HOME`).

**`src/` is the QA runner.** It uses Playwright, `@axe-core/playwright` and `@anthropic-ai/sdk`. The pipeline is driven by `cli.mjs`:
1. `config.mjs` `loadLlmSettings()` reads config plus the key through `setup/credentials.mjs`. This runs *before* crawling so that a missing setup fails fast.
2. `crawl.mjs` `crawlSite()` does a breadth-first crawl, one page at a time, restricted to the start URL's origin. It uses separate desktop (1440×900) and mobile (iPhone 13) contexts. It collects JS errors, failed and 4xx/5xx requests, axe violations, screenshots and timings. Same-site links that are not visited still get a HEAD/GET status check. The result is written to `raw/findings.json`.
3. `analyze.mjs` `condenseFindings()` groups the raw data and caps its size (`MAX_GROUPS`, `MAX_PAGES_PER_GROUP`) so the prompt stays bounded. The result is written to `raw/condensed.json`. Screenshots are never sent to the LLM.
4. `writeReportWithLlm()` asks for structured JSON that matches `REPORT_SCHEMA`. The Anthropic path uses the SDK with streaming, a JSON-schema `output_config`, adaptive thinking and server-side fallbacks. The OpenAI path uses raw `fetch` with `response_format: json_schema`. If this step fails, `writeBasicReport()` produces the same report shape from fixed rules, and the report carries a warning.
5. `report.mjs` renders the report object to Markdown and/or HTML.

The report object (`overallHealth`, `summary`, `issues[]`, `positives[]`) is the contract between the LLM path, the rule-based fallback and the renderers. If you change `REPORT_SCHEMA`, update `writeBasicReport()` and both renderers to match. Severities (`critical/high/medium/low`) and categories are defined once in `analyze.mjs`. The severity rubric lives in `SYSTEM_PROMPT` and is mirrored by the fixed rules in `writeBasicReport()`.

To add an LLM provider, touch three places: `PROVIDERS` in `setup/providers.mjs`, `DEFAULT_MODELS`, and the `call*` dispatch in `src/analyze.mjs`.

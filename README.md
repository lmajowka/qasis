# Qasis

An agent that continuously QAs websites and generates reports.

> Status: runs one QA pass over one website on demand. Scheduling comes later.

## Install

Requirements: macOS or Linux (Windows via WSL2), Node.js 22+.

```bash
git clone <this repo> qasis
cd qasis
bash qasis.sh
```

Run it directly in a terminal, not piped and not inside another agent session.
It asks for your LLM provider and API key.

```bash
bash qasis.sh --status      # show provider and whether a key is stored (masked)
bash qasis.sh --uninstall   # remove the stored key and config
```

## How the API key is handled

- **Hidden input.** The key is read in raw terminal mode. It is not echoed, and it never goes into shell history, command-line arguments or environment variables.
- **Verified before saving.** A read-only call (`GET /v1/models`) checks that the provider accepts the key.
- **Stored in the OS secret store:** macOS Keychain, or Secret Service (GNOME Keyring/KWallet) on Linux. The key is passed to these tools on stdin, so it never shows up in `ps`.
- **No `.env` with secrets.** If there is no secret store, Qasis asks before falling back to `~/.config/qasis/credentials.json`, which is readable only by you (mode `0600`, in a `0700` directory).
- **No dependencies.** The installer uses only Node built-ins, so there are no third-party packages to compromise.
- It refuses to run as root, and it creates files with `umask 077`.

Non-secret settings are kept in `~/.config/qasis/config.json`.

## Run a QA pass

The QA runner needs Playwright, axe-core and the Anthropic SDK (the installer itself still uses none):

```bash
npm install
npx playwright install chromium
```

Then:

```bash
npm run qa -- https://example.com
npm run qa -- example.com --depth 1 --max-pages 10 --format html
npm run qa -- example.com --no-ai      # skip the LLM, use a rule-based report
```

| Option | Default | Meaning |
|---|---|---|
| `--depth <n>` | 2 | How many clicks from the start URL to follow same-site links |
| `--max-pages <n>` | 20 | Maximum number of pages to open |
| `--format both\|md\|html` | both | Report format |
| `--no-ai` | off | Write a rule-based report without calling the LLM |
| `--out <dir>` | `reports` | Output root |

### What it checks

Headless Chromium opens each page, one at a time, staying on the start URL's origin:

- **JavaScript errors**: uncaught exceptions and `console.error` messages
- **Network**: requests that fail or return 4xx/5xx
- **Broken links**: same-site links that are visited (up to `--depth`) or, beyond that, checked with HEAD/GET
- **Accessibility**: axe-core, WCAG 2.x A/AA plus best practices
- **Screenshots**: full page at desktop (1440×900) and mobile (iPhone 13) sizes, plus a check for a missing viewport tag and sideways scrolling on mobile
- **Load times**: TTFB, first and largest contentful paint, DOMContentLoaded, load event, transfer size

### The report

The findings are grouped and condensed, then sent to the LLM chosen at install time
(`claude-opus-5-5` for Anthropic, `gpt-5` for OpenAI; set `"model"` in `config.json` to override).
It merges duplicates, assigns a severity (critical/high/medium/low) and writes the report in plain language.
If the LLM call fails, Qasis still writes a rule-based report and says so at the top.

Output goes to `reports/<site>/<date>/` (with `-2`, `-3`… for repeat runs on the same day):

```
report.md / report.html
screenshots/       01-home-desktop.png, 01-home-mobile.png, …
raw/findings.json  everything collected
raw/condensed.json what was sent to the LLM
raw/llm-report.json the LLM's structured answer, model and token usage
```

The site's findings (URLs, error messages, HTML snippets) are sent to your LLM provider. Screenshots are not.

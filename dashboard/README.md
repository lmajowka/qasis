# Qasis dashboard

A live Rails dashboard for this Qasis checkout. It reads the same files and
services the Node side leaves behind and never writes to them:

- **Installation**: `~/.config/qasis/config.json`, whether the API key exists in
  the credential store (on macOS it checks without reading the key), and whether
  Playwright and Chromium are installed.
- **Watch services**: the LaunchAgents / systemd user units from `npm run watch`.
  It shows their state, pid, schedule and options, whether a pass is running, when
  the next one is due, and the tail of `flows/service.log`.
- **Sites**: every directory under `reports/`, with QA runs, issues, flows and
  flow passes. Reports and flow docs are served from `/files/...`.

The page refreshes itself every 15 seconds.

```bash
bundle install
bin/rails server        # http://localhost:3000
```

No database is needed. `QASIS_ROOT` (default: the parent directory) and
`QASIS_REPORTS` (default: `$QASIS_ROOT/reports`) point it somewhere else.
It shows local paths and logs, so keep it bound to localhost.

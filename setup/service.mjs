// Background service for flow discovery, so watching a site survives crashes,
// logouts and reboots without a terminal left open:
//   macOS -> a launchd LaunchAgent in ~/Library/LaunchAgents
//   Linux -> a systemd user unit in ~/.config/systemd/user
// One service per site. Each runs `node src/flows-cli.mjs <url>` in watch mode,
// which keeps its own schedule in state.json, so a restart never runs a pass early.
// The service gets no secrets: flows-cli reads the key from the credential store itself.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLOWS_CLI = join(ROOT_DIR, 'src', 'flows-cli.mjs');
const REPORTS_DIR = join(ROOT_DIR, 'reports');

// Same rule as siteSlug() in src/crawl.mjs (setup/ may not import src/).
const siteSlug = (url) => new URL(url).host.replace(/[^a-z0-9.-]/gi, '_');

/** Where a site's service writes its output; next to its flow docs. */
export const logFile = (url) => join(REPORTS_DIR, siteSlug(url), 'flows', 'service.log');

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function check(res, what) {
  if (res.error) throw new Error(`${what} failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${what} failed: ${(res.stderr || res.stdout).trim()}`);
}

/** Environment for the service: just enough to find node and the credential helpers. */
function serviceEnv() {
  const env = {
    HOME: homedir(),
    PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    NO_COLOR: '1',
  };
  // Keep the config dir the installer used.
  if (process.env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  return env;
}

const SITE_MARKER = 'qasis-site:';
const siteFromFile = (path) => readFileSync(path, 'utf8').match(/qasis-site: (\S+)/)?.[1] ?? null;

// ---------------------------------------------------------------- macOS

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const launchd = {
  id: 'launchd',
  label: 'launchd (LaunchAgent)',
  dir: join(homedir(), 'Library', 'LaunchAgents'),
  name: (url) => `com.qasis.flows.${siteSlug(url)}`,
  file(url) {
    return join(this.dir, `${this.name(url)}.plist`);
  },
  domain: () => `gui/${userInfo().uid}`,

  write(url, argv) {
    const log = logFile(url);
    const env = Object.entries(serviceEnv())
      .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
      .join('\n');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Qasis flow discovery. Managed by: npm run watch / npm run unwatch. ${SITE_MARKER} ${xml(url)} -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(this.name(url))}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT_DIR)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash, but not after a clean exit. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <!-- A broken setup (e.g. missing key) retries every 5 minutes, not every 10 seconds. -->
  <key>ThrottleInterval</key><integer>300</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(url), plist, { mode: 0o644 });
  },

  start(url) {
    this.stop(url); // bootstrap fails if an older copy is still loaded
    check(run('launchctl', ['bootstrap', this.domain(), this.file(url)]), 'launchctl bootstrap');
  },

  stop(url) {
    const target = `${this.domain()}/${this.name(url)}`;
    run('launchctl', ['bootout', target]); // fine if not loaded
    // bootout returns before the job is gone; bootstrapping too soon fails with "Input/output error".
    for (let i = 0; i < 50 && run('launchctl', ['print', target]).status === 0; i++) sleepSync(100);
  },

  state(url) {
    const res = run('launchctl', ['print', `${this.domain()}/${this.name(url)}`]);
    if (res.status !== 0) return 'not loaded';
    const state = res.stdout.match(/^\s*state = (.+)$/m)?.[1] ?? 'unknown';
    const pid = res.stdout.match(/^\s*pid = (\d+)$/m)?.[1];
    return pid ? `${state} (pid ${pid})` : state;
  },

  list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.startsWith('com.qasis.flows.') && f.endsWith('.plist'))
      .map((f) => siteFromFile(join(this.dir, f)))
      .filter(Boolean);
  },

  notes: () => [],
};

// ---------------------------------------------------------------- Linux

// systemd unit quoting, so values are taken literally: % starts a specifier
// everywhere, and $ expands variables only in ExecStart.
const unitPath = (s) => String(s).replace(/%/g, '%%');
const unitWord = (s) => `"${unitPath(s).replace(/[\\"]/g, '\\$&')}"`;
const execWord = (s) => unitWord(s).replace(/\$/g, '$$$$');

const systemd = {
  id: 'systemd',
  label: 'systemd user unit',
  dir: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user'),
  name: (url) => `qasis-flows-${siteSlug(url)}.service`,
  file(url) {
    return join(this.dir, this.name(url));
  },

  write(url, argv, { credentialStore } = {}) {
    const log = logFile(url);
    const env = serviceEnv();
    // secret-tool needs the session bus; %t is the user's runtime dir (/run/user/<uid>).
    const extraEnv = credentialStore === 'secret-service' ? ' "DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"' : '';
    const unit = `# Qasis flow discovery. Managed by: npm run watch / npm run unwatch.
# ${SITE_MARKER} ${url}
[Unit]
Description=Qasis flow discovery for ${siteSlug(url)}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${unitPath(ROOT_DIR)}
ExecStart=${argv.map(execWord).join(' ')}
Environment=${Object.entries(env).map(([k, v]) => unitWord(`${k}=${v}`)).join(' ')}${extraEnv}
# Restart after a crash; a broken setup (e.g. missing key) retries every 5 minutes.
Restart=on-failure
RestartSec=300
# flows-cli exits 130 on SIGTERM; that is a normal stop, not a failure.
SuccessExitStatus=130
StandardOutput=append:${unitPath(log)}
StandardError=append:${unitPath(log)}

[Install]
WantedBy=default.target
`;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(url), unit, { mode: 0o644 });
  },

  start(url) {
    check(run('systemctl', ['--user', 'daemon-reload']), 'systemctl daemon-reload');
    check(run('systemctl', ['--user', 'enable', this.name(url)]), 'systemctl enable');
    check(run('systemctl', ['--user', 'restart', this.name(url)]), 'systemctl restart');
  },

  stop(url) {
    run('systemctl', ['--user', 'disable', '--now', this.name(url)]); // fine if not installed
  },

  state(url) {
    const res = run('systemctl', ['--user', 'show', this.name(url), '-p', 'ActiveState,SubState,MainPID']);
    const prop = (k) => res.stdout.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
    if (res.status !== 0 || !prop('ActiveState')) return 'unknown';
    const pid = prop('MainPID');
    return `${prop('ActiveState')}/${prop('SubState')}${pid && pid !== '0' ? ` (pid ${pid})` : ''}`;
  },

  list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.startsWith('qasis-flows-') && f.endsWith('.service'))
      .map((f) => siteFromFile(join(this.dir, f)))
      .filter(Boolean);
  },

  notes() {
    // Without lingering, user services stop at logout and only start at login.
    const res = run('loginctl', ['show-user', userInfo().username, '-p', 'Linger', '--value']);
    return res.status === 0 && res.stdout.trim() === 'no'
      ? [`User services stop when you log out. To keep watching after logout and start at boot, run: loginctl enable-linger ${userInfo().username}`]
      : [];
  },
};

// ---------------------------------------------------------------- API

/** The service manager for this OS, or null if there is none we support. */
export function serviceManager() {
  if (process.platform === 'darwin') return launchd;
  if (process.platform === 'linux' && run('systemctl', ['--user', 'show-environment']).status === 0) return systemd;
  return null;
}

/**
 * Install (or replace) and start the service for one site.
 * @param {string} url normalized start URL
 * @param {string[]} flowArgs extra flows-cli options, already validated
 */
export function installService(manager, url, flowArgs, { credentialStore } = {}) {
  const argv = [process.execPath, FLOWS_CLI, url, '--out', REPORTS_DIR, ...flowArgs];
  mkdirSync(dirname(logFile(url)), { recursive: true });
  manager.write(url, argv, { credentialStore });
  manager.start(url);
  return manager.file(url);
}

export function removeService(manager, url) {
  manager.stop(url);
  const file = manager.file(url);
  const existed = existsSync(file);
  rmSync(file, { force: true });
  if (manager === systemd) run('systemctl', ['--user', 'daemon-reload']);
  return existed;
}

/** @returns {{ url: string, state: string, log: string }[]} every site with an installed service */
export function listServices(manager) {
  return manager.list().map((url) => ({ url, state: manager.state(url), log: logFile(url) }));
}

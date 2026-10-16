// Qasis setup: pick an LLM provider, collect the API key securely, verify it,
// and store it in the OS secret store. Non-secret settings go to config.json.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { askSecret, choose, confirm, maskKey } from './prompt.mjs';
import { bold, cyan, dim, fail, green, heading, icons, ok, red, row, warn, yellow } from './style.mjs';
import { PROVIDERS, checkKeyFormat, verifyKey } from './providers.mjs';
import {
  CONFIG_DIR,
  detectSecureBackend,
  ensureConfigDir,
  fileBackend,
  getBackend,
  storeKey,
} from './credentials.mjs';
import { ROOT_DIR, installService, listServices, logFile, removeService, serviceManager } from './service.mjs';

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const MAX_ATTEMPTS = 3;

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(config) {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

async function chooseBackend() {
  const secure = detectSecureBackend();
  if (secure) return secure;

  console.log();
  warn('No OS secret store found (macOS Keychain or Linux Secret Service).');
  console.log(`  The key can instead be saved to a file readable only by you: ${cyan(fileBackend().label)}`);
  if (!(await confirm('Store the key in that file?', false))) {
    throw new Error('Aborted: no secure place to store the API key.');
  }
  return fileBackend();
}

async function collectKey(provider) {
  const { label, consoleUrl } = PROVIDERS[provider];
  heading('API key');
  console.log(`  Paste your ${bold(label)} API key. Get one at ${cyan(consoleUrl)}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const key = await askSecret('API key');
    if (!key) {
      console.log(yellow('No key entered.'));
      continue;
    }

    const formatProblem = checkKeyFormat(provider, key);
    if (formatProblem && !(await confirm(`${formatProblem} Use it anyway?`, false))) continue;
    if (formatProblem && !/^[A-Za-z0-9._\-]+$/.test(key)) {
      console.log(red('Key contains characters that cannot be stored safely.'));
      continue;
    }

    process.stdout.write(dim(`  Verifying ${maskKey(key)} with ${label}… `));
    const result = await verifyKey(provider, key);
    if (result.ok) {
      console.log(`${icons.ok} ${green('valid')}`);
      return key;
    }
    console.log(`${icons.fail}\n  ${red(result.reason)}`);
    if (result.reason.startsWith('Could not reach') && (await confirm('Save it without verifying?', false))) {
      return key;
    }
  }
  throw new Error('Too many failed attempts.');
}

async function install() {
  const existing = readConfig();
  if (existing && !(await confirm(`Qasis is already configured (${existing.provider}). Reconfigure?`, false))) {
    console.log(dim('Nothing changed.'));
    return;
  }

  heading('Provider');
  const provider = await choose(
    'Which LLM provider should Qasis use?',
    Object.entries(PROVIDERS).map(([value, p]) => ({ value, label: p.label })),
  );

  const backend = await chooseBackend();
  const key = await collectKey(provider);
  storeKey(backend, provider, key);

  // Remove a stale key left by a previous provider choice.
  if (existing && existing.provider !== provider) {
    getBackend(existing.credentialStore)?.delete(existing.provider);
  }

  writeConfig({
    version: 1,
    provider,
    credentialStore: backend.id,
    installedAt: new Date().toISOString(),
  });

  heading('Done');
  ok(`API key stored in ${cyan(backend.label)}`);
  ok(`Config written to ${cyan(CONFIG_FILE)}`);
  console.log(`\n${green(bold('Qasis is installed.'))} Run a QA pass with: ${cyan('npm run qa -- <url>')}`);
}

function status() {
  const config = readConfig();
  if (!config) {
    console.log(`${icons.warn} Qasis is not configured. Run: ${cyan('bash qasis.sh')}`);
    watchedSites();
    return;
  }
  const backend = getBackend(config.credentialStore);
  const key = backend?.get(config.provider);
  heading('Qasis status');
  row('Provider', bold(PROVIDERS[config.provider]?.label ?? config.provider));
  row('Credential store', backend?.label ?? config.credentialStore);
  row('API key', key ? `${icons.ok} present ${dim(`(${maskKey(key)})`)}` : `${icons.fail} ${red('MISSING')}`);
  row('Config', cyan(CONFIG_FILE));
  watchedSites();
}

function watchedSites() {
  const manager = serviceManager();
  const services = manager ? listServices(manager) : [];
  if (services.length) {
    heading('Watched sites');
    for (const s of services) console.log(`  ${bold(s.url)}\n    ${s.state}  ${dim(s.log)}`);
  }
}

async function uninstall() {
  const config = readConfig();
  if (!(await confirm('Remove the stored Qasis API key and config?', false))) {
    console.log(dim('Nothing changed.'));
    return;
  }
  const manager = serviceManager();
  for (const { url } of manager ? listServices(manager) : []) {
    removeService(manager, url);
    ok(`Stopped watching ${cyan(url)}`);
  }
  if (config) getBackend(config.credentialStore)?.delete(config.provider);
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  ok('Qasis credentials and config removed. You can now delete this folder.');
}

const WATCH_USAGE = `Usage: npm run watch -- <url> [--every <hours>] [--depth <n>] [--max-pages <n>] [--no-ai]
       npm run unwatch -- <url>`;

/** Parse `--watch/--unwatch <url> [flow options]`, validating what the service will be started with. */
function parseWatchArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      watch: { type: 'boolean' },
      unwatch: { type: 'boolean' },
      every: { type: 'string' },
      depth: { type: 'string' },
      'max-pages': { type: 'string' },
      'no-ai': { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1) throw new Error(`Give exactly one site.\n${WATCH_USAGE}`);
  const raw = positionals[0];
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).href;

  const flowArgs = [];
  const number = (name, valid, rule) => {
    if (values[name] === undefined) return;
    if (!valid(Number(values[name]))) throw new Error(`--${name} must be ${rule}`);
    flowArgs.push(`--${name}`, String(Number(values[name])));
  };
  number('every', (n) => n >= 0.1, 'a number of hours ≥ 0.1');
  number('depth', (n) => Number.isInteger(n) && n >= 0, 'an integer ≥ 0');
  number('max-pages', (n) => Number.isInteger(n) && n >= 1, 'an integer ≥ 1');
  if (values['no-ai']) flowArgs.push('--no-ai');
  return { url, flowArgs, useAi: !values['no-ai'] };
}

function requireServiceManager() {
  if (process.getuid?.() === 0) throw new Error('Do not run this as root or with sudo.');
  const manager = serviceManager();
  if (!manager) {
    throw new Error('No supported service manager (launchd or systemd --user). Run `npm run flows -- <url>` in tmux instead.');
  }
  return manager;
}

/** Check that the QA runner can start, so the service does not just fail in the background. */
function checkRunnerReady(useAi) {
  // Spawned, not imported: setup/ itself stays free of third-party packages.
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import { chromium } from 'playwright'; import { accessSync } from 'node:fs'; accessSync(chromium.executablePath());"],
    { cwd: ROOT_DIR, stdio: 'ignore' },
  );
  if (probe.status !== 0) {
    throw new Error('The QA runner is not installed. Run: npm install && npx playwright install chromium');
  }
  if (!useAi) return null;
  const config = readConfig();
  if (!config) throw new Error('Qasis is not configured. Run: bash qasis.sh (or add --no-ai)');
  if (!getBackend(config.credentialStore)?.get(config.provider)) {
    throw new Error(`No ${config.provider} API key found. Re-run: bash qasis.sh`);
  }
  return config;
}

async function watch() {
  const { url, flowArgs, useAi } = parseWatchArgs(process.argv.slice(2));
  const manager = requireServiceManager();
  const config = checkRunnerReady(useAi);

  heading(`Watch ${url}`);
  const file = installService(manager, url, flowArgs, { credentialStore: config?.credentialStore });
  ok(`Service installed: ${cyan(file)}`);
  for (const note of manager.notes()) warn(note);
  console.log(`\n  It starts at login and restarts if it crashes. Passes keep the existing schedule.`);
  console.log(`  Log:     ${cyan(logFile(url))}`);
  console.log(`  Status:  ${cyan('npm run status')}`);
  console.log(`  Stop:    ${cyan(`npm run unwatch -- ${url}`)}`);
}

async function unwatch() {
  const { url } = parseWatchArgs(process.argv.slice(2));
  const manager = requireServiceManager();
  if (removeService(manager, url)) ok(`Stopped watching ${cyan(url)}. Its flow docs are kept.`);
  else console.log(dim(`${url} was not being watched.`));
}

const args = process.argv.slice(2);
const command = args.includes('--watch')
  ? watch
  : args.includes('--unwatch')
    ? unwatch
    : args.includes('--uninstall')
      ? uninstall
      : args.includes('--status')
        ? status
        : install;

try {
  await command();
} catch (err) {
  console.error();
  fail(err.message);
  process.exit(1);
}

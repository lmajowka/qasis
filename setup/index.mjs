// Qasis setup: pick an LLM provider, collect the API key securely, verify it,
// and store it in the OS secret store. Non-secret settings go to config.json.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { askSecret, choose, confirm, maskKey } from './prompt.mjs';
import { PROVIDERS, checkKeyFormat, verifyKey } from './providers.mjs';
import {
  CONFIG_DIR,
  detectSecureBackend,
  ensureConfigDir,
  fileBackend,
  getBackend,
  storeKey,
} from './credentials.mjs';

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

  console.log('\n⚠ No OS secret store found (macOS Keychain or Linux Secret Service).');
  console.log(`  The key can instead be saved to a file readable only by you: ${fileBackend().label}`);
  if (!(await confirm('Store the key in that file?', false))) {
    throw new Error('Aborted: no secure place to store the API key.');
  }
  return fileBackend();
}

async function collectKey(provider) {
  const { label, consoleUrl } = PROVIDERS[provider];
  console.log(`\nPaste your ${label} API key. Get one at ${consoleUrl}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const key = await askSecret('API key');
    if (!key) {
      console.log('No key entered.');
      continue;
    }

    const formatProblem = checkKeyFormat(provider, key);
    if (formatProblem && !(await confirm(`${formatProblem} Use it anyway?`, false))) continue;
    if (formatProblem && !/^[A-Za-z0-9._\-]+$/.test(key)) {
      console.log('Key contains characters that cannot be stored safely.');
      continue;
    }

    process.stdout.write(`Verifying ${maskKey(key)} with ${label}… `);
    const result = await verifyKey(provider, key);
    if (result.ok) {
      console.log('✓ valid');
      return key;
    }
    console.log(`✗\n  ${result.reason}`);
    if (result.reason.startsWith('Could not reach') && (await confirm('Save it without verifying?', false))) {
      return key;
    }
  }
  throw new Error('Too many failed attempts.');
}

async function install() {
  const existing = readConfig();
  if (existing && !(await confirm(`Qasis is already configured (${existing.provider}). Reconfigure?`, false))) {
    console.log('Nothing changed.');
    return;
  }

  const provider = await choose(
    '\nWhich LLM provider should Qasis use?',
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

  console.log(`\n✓ API key stored in ${backend.label}`);
  console.log(`✓ Config written to ${CONFIG_FILE}`);
  console.log('\nQasis is installed. (It does not run any QA jobs yet.)');
}

function status() {
  const config = readConfig();
  if (!config) {
    console.log('Qasis is not configured. Run: bash qasis.sh');
    return;
  }
  const backend = getBackend(config.credentialStore);
  const key = backend?.get(config.provider);
  console.log(`Provider:          ${PROVIDERS[config.provider]?.label ?? config.provider}`);
  console.log(`Credential store:  ${backend?.label ?? config.credentialStore}`);
  console.log(`API key:           ${key ? `present (${maskKey(key)})` : 'MISSING'}`);
  console.log(`Config:            ${CONFIG_FILE}`);
}

async function uninstall() {
  const config = readConfig();
  if (!(await confirm('Remove the stored Qasis API key and config?', false))) {
    console.log('Nothing changed.');
    return;
  }
  if (config) getBackend(config.credentialStore)?.delete(config.provider);
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  console.log('✓ Qasis credentials and config removed. You can now delete this folder.');
}

const args = process.argv.slice(2);
const command = args.includes('--uninstall') ? uninstall : args.includes('--status') ? status : install;

try {
  await command();
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}

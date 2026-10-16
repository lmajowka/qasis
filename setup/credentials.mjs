// Credential storage. The API key goes into the OS secret store:
//   macOS -> Keychain (via `security`)
//   Linux -> Secret Service / GNOME Keyring (via `secret-tool`)
// and only falls back to a 0600 file under ~/.config/qasis if the user agrees.
// The key is always passed to helper tools on stdin, never on the command line,
// so it cannot be seen in `ps` output or shell history.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SERVICE = 'qasis';

export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'qasis');
const FILE_STORE = join(CONFIG_DIR, 'credentials.json');

const account = (provider) => `llm-api-key:${provider}`;

function run(cmd, args, input) {
  return spawnSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function hasCommand(cmd) {
  return run('sh', ['-c', `command -v ${cmd}`]).status === 0;
}

export function ensureConfigDir() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CONFIG_DIR, 0o700);
}

const keychain = {
  id: 'macos-keychain',
  label: 'macOS Keychain',
  available: () => process.platform === 'darwin' && hasCommand('security'),
  set(provider, key) {
    // `security -i` reads commands from stdin, keeping the key out of argv.
    // The key was validated against a strict charset, so quoting is safe.
    const cmd = `add-generic-password -U -s "${SERVICE}" -a "${account(provider)}" -l "Qasis ${provider} API key" -w "${key}"\n`;
    run('security', ['-i'], cmd);
  },
  get(provider) {
    const res = run('security', ['find-generic-password', '-s', SERVICE, '-a', account(provider), '-w']);
    return res.status === 0 ? res.stdout.replace(/\n$/, '') : null;
  },
  delete(provider) {
    run('security', ['delete-generic-password', '-s', SERVICE, '-a', account(provider)]);
  },
};

const secretService = {
  id: 'secret-service',
  label: 'Secret Service (GNOME Keyring / KWallet)',
  available: () =>
    process.platform === 'linux' && !!process.env.DBUS_SESSION_BUS_ADDRESS && hasCommand('secret-tool'),
  set(provider, key) {
    run('secret-tool', ['store', `--label=Qasis ${provider} API key`, 'service', SERVICE, 'account', account(provider)], key);
  },
  get(provider) {
    const res = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account(provider)]);
    return res.status === 0 && res.stdout ? res.stdout.replace(/\n$/, '') : null;
  },
  delete(provider) {
    run('secret-tool', ['clear', 'service', SERVICE, 'account', account(provider)]);
  },
};

const fileStore = {
  id: 'file',
  label: `file (${FILE_STORE}, mode 0600)`,
  available: () => true,
  read() {
    try {
      return JSON.parse(readFileSync(FILE_STORE, 'utf8'));
    } catch {
      return {};
    }
  },
  write(data) {
    ensureConfigDir();
    writeFileSync(FILE_STORE, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(FILE_STORE, 0o600);
  },
  set(provider, key) {
    this.write({ ...this.read(), [provider]: key });
  },
  get(provider) {
    return this.read()[provider] ?? null;
  },
  delete(provider) {
    const data = this.read();
    delete data[provider];
    if (Object.keys(data).length) this.write(data);
    else rmSync(FILE_STORE, { force: true });
  },
};

const BACKENDS = [keychain, secretService, fileStore];

export function getBackend(id) {
  return BACKENDS.find((b) => b.id === id);
}

/** Best secure backend on this machine, or null if only the file fallback exists. */
export function detectSecureBackend() {
  return [keychain, secretService].find((b) => b.available()) ?? null;
}

export function fileBackend() {
  return fileStore;
}

/** Store the key and read it back to prove it round-trips. */
export function storeKey(backend, provider, key) {
  backend.set(provider, key);
  if (backend.get(provider) !== key) {
    throw new Error(`Failed to save the key in ${backend.label}.`);
  }
}

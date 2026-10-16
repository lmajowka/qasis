// Reads what the installer saved: the provider choice from config.json and the
// API key from the credential store. The key stays in memory only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, getBackend } from '../setup/credentials.mjs';

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** @returns {{ provider: string, model?: string, apiKey: string }} */
export function loadLlmSettings() {
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    throw new Error('Qasis is not configured. Run: bash qasis.sh (or pass --no-ai for a report without the LLM)');
  }
  const apiKey = getBackend(config.credentialStore)?.get(config.provider);
  if (!apiKey) {
    throw new Error(`No ${config.provider} API key found in the credential store. Re-run: bash qasis.sh`);
  }
  return { provider: config.provider, model: config.model, apiKey };
}

// Reads what the installer saved: the provider choice from config.json and the
// API key from the credential store. The key stays in memory only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, getBackend } from '../setup/credentials.mjs';

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export const DEFAULT_FLOW_INTERVAL_HOURS = 4;

/** @returns {object | null} the parsed config.json, or null if Qasis is not installed */
function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** @returns {{ provider: string, model?: string, apiKey: string }} */
export function loadLlmSettings() {
  const config = readConfig();
  if (!config) {
    throw new Error('Qasis is not configured. Run: bash qasis.sh (or pass --no-ai to skip the LLM)');
  }
  const apiKey = getBackend(config.credentialStore)?.get(config.provider);
  if (!apiKey) {
    throw new Error(`No ${config.provider} API key found in the credential store. Re-run: bash qasis.sh`);
  }
  return { provider: config.provider, model: config.model, apiKey };
}

/** Hours between flow-discovery runs: `flowDiscovery.intervalHours` in config.json, else the default. */
export function flowIntervalHours() {
  const hours = readConfig()?.flowDiscovery?.intervalHours;
  return typeof hours === 'number' && hours > 0 ? hours : DEFAULT_FLOW_INTERVAL_HOURS;
}

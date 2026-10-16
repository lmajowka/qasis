// Supported LLM providers and a cheap, read-only call to verify a key works.

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    keyHint: 'sk-ant-',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    verify: (key) =>
      fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      }),
  },
  openai: {
    label: 'OpenAI',
    keyHint: 'sk-',
    consoleUrl: 'https://platform.openai.com/api-keys',
    verify: (key) =>
      fetch('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${key}` },
      }),
  },
  deepseek: {
    label: 'DeepSeek',
    keyHint: 'sk-',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    verify: (key) =>
      fetch('https://api.deepseek.com/models', {
        headers: { authorization: `Bearer ${key}` },
      }),
  },
};

// API keys are opaque tokens; anything outside this set is almost certainly a
// paste mistake (and rejecting it keeps the key safe to hand to keychain tools).
const KEY_PATTERN = /^[A-Za-z0-9._\-]{20,512}$/;

export function checkKeyFormat(providerId, key) {
  if (!KEY_PATTERN.test(key)) {
    return 'That does not look like an API key (unexpected characters or length).';
  }
  const { keyHint, label } = PROVIDERS[providerId];
  if (!key.startsWith(keyHint)) {
    return `${label} keys usually start with "${keyHint}".`;
  }
  return null;
}

/** @returns {Promise<{ ok: boolean, reason?: string }>} */
export async function verifyKey(providerId, key) {
  try {
    const res = await PROVIDERS[providerId].verify(key);
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'The provider rejected this key (unauthorized).' };
    }
    return { ok: false, reason: `Unexpected response from provider (HTTP ${res.status}).` };
  } catch (err) {
    return { ok: false, reason: `Could not reach the provider: ${err.cause?.code ?? err.message}` };
  }
}

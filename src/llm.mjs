// One structured-JSON call to the configured LLM provider. Shared by the QA
// report (analyze.mjs) and flow documentation (flows/document.mjs).
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-5', deepseek: 'deepseek-v4-pro' };

async function callAnthropic({ apiKey, model, system, schema, prompt }) {
  const client = new Anthropic({ apiKey });
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new Error(`The model declined the request (${message.stop_details?.category ?? 'no category'}).`);
  }
  if (message.stop_reason === 'max_tokens') throw new Error('The model ran out of output tokens.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, model: message.model, usage: message.usage };
}

// OpenAI-style chat completions, shared by OpenAI and DeepSeek.
async function callChatCompletions({ url, label, apiKey, model, system, prompt, extra }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      ...extra,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}: ${body.error?.message ?? 'unknown error'}`);
  const choice = body.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`The model declined the request: ${choice.message.refusal}`);
  if (choice?.finish_reason === 'length') throw new Error('The model ran out of output tokens.');
  return { text: choice?.message?.content ?? '', model: body.model, usage: body.usage };
}

function callOpenAI({ apiKey, model, system, schema, schemaName, prompt }) {
  return callChatCompletions({
    url: 'https://api.openai.com/v1/chat/completions',
    label: 'OpenAI',
    apiKey,
    model,
    system,
    prompt,
    extra: {
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    },
  });
}

// DeepSeek only offers `json_object` mode (no schema enforcement), so the schema
// goes in the prompt and callers shape-check the result.
async function callDeepSeek({ apiKey, model, system, schema, prompt }) {
  const result = await callChatCompletions({
    url: 'https://api.deepseek.com/chat/completions',
    label: 'DeepSeek',
    apiKey,
    model,
    system: `${system}\n\nRespond with a single JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}`,
    prompt,
    extra: { response_format: { type: 'json_object' }, max_tokens: 32000 },
  });
  if (!result.text.trim()) throw new Error('DeepSeek returned an empty response.');
  return result;
}

/**
 * Ask the configured LLM for JSON matching `schema`. Callers still check the
 * shape, since DeepSeek does not enforce the schema.
 * @returns {Promise<{ data: any, meta: { provider: string, model: string, usage: object } }>}
 */
export async function callLlmJson({ provider, apiKey, model }, { system, schema, schemaName, prompt }) {
  const call = { anthropic: callAnthropic, openai: callOpenAI, deepseek: callDeepSeek }[provider];
  if (!call) throw new Error(`Unsupported LLM provider: ${provider}`);
  const chosenModel = model || DEFAULT_MODELS[provider];
  const { text, model: usedModel, usage } = await call({ apiKey, model: chosenModel, system, schema, schemaName, prompt });

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The model returned a response that is not valid JSON.');
  }
  return { data, meta: { provider, model: usedModel ?? chosenModel, usage } };
}

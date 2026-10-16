// Documents discovered flows: a name, purpose, step-by-step instructions a
// manual tester can follow, the expected outcome and test ideas. The LLM writes
// these from the flow's structure; basicDoc() produces the same shape from
// fixed rules for --no-ai or when the LLM call fails.
import { callLlmJson } from '../llm.mjs';

export const BASIC_GENERATOR = 'basic rules (no AI)';
const BATCH_SIZE = 20; // flows per LLM call, to keep each prompt and answer bounded
const MAX_PAGES_SENT = 5;

const DOC_FIELDS = ['id', 'name', 'purpose', 'preconditions', 'steps', 'expectedOutcome', 'testIdeas', 'changeNote'];
const DOCS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['flows'],
  properties: {
    flows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: DOC_FIELDS,
        properties: {
          id: { type: 'string', description: 'The id of the flow, copied exactly from the input.' },
          name: { type: 'string', description: 'Short name, e.g. "Sign up with email".' },
          purpose: { type: 'string', description: 'One or two sentences: what the visitor achieves and why it matters to the business.' },
          preconditions: { type: 'string', description: 'What must be true first (e.g. "Signed out", "An item in the cart"); empty string if none.' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Numbered steps a manual tester can follow, from the start URL to submitting.' },
          expectedOutcome: { type: 'string', description: 'What should most likely happen on success. This is inferred, not observed.' },
          testIdeas: { type: 'array', items: { type: 'string' }, description: 'Three to six concrete things to test, including failure paths.' },
          changeNote: { type: 'string', description: 'For changed flows, what differs from before in plain language; empty string for new flows.' },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a QA analyst documenting the user flows of a website, so a tester can find, follow and test each one.

You receive flows that an automated crawler found. Each has a heuristic kind (signup, login, search, contact, newsletter, checkout, booking, download, password-reset or generic form), the pages it was found on, the click path from the start URL, and either a form's structure (fields, labels, required, submit button) or a call to action (a button, or a link that hands off to another site).

The crawler never fills in or submits forms and never clicks buttons, so nothing about the result was observed.

How to write each entry:
- Return one entry per input flow, with its id copied exactly.
- Correct the kind in the name if the structure clearly shows something else (e.g. a "form" that is a coupon field).
- Steps: start with opening the start URL, follow the click path, then name each field to fill in with its label (say which are required), then the button to press. Use the labels and texts from the data, quoted. For a call to action, end at the click and what should open.
- Expected outcome: what success should most likely look like. Say plainly that it is unverified when the data cannot tell.
- Test ideas: concrete checks for this flow, such as required-field validation, invalid email format, wrong password, duplicate sign-up, empty search, keyboard-only use, and the mobile layout. No generic filler.
- For a changed flow, compare "previous" with the current structure and describe the difference in changeNote.
- Use only what the data supports. Do not invent fields, pages or business rules.`;

const KIND_LABEL = {
  signup: 'Sign up',
  login: 'Log in',
  'password-reset': 'Password reset',
  search: 'Search',
  contact: 'Contact',
  newsletter: 'Newsletter sign-up',
  checkout: 'Checkout',
  booking: 'Booking',
  download: 'Download',
  form: 'Form',
};

const KIND_OUTCOME = {
  signup: 'An account is created and the visitor is signed in or asked to confirm their email.',
  login: 'The visitor is signed in and taken to their account or the page they came from.',
  'password-reset': 'A password reset email is sent, with a confirmation shown on screen.',
  search: 'A results page lists matches for the query.',
  contact: 'The message is sent and a confirmation is shown.',
  newsletter: 'The email address is subscribed and a confirmation is shown.',
  checkout: 'The item is added to the cart or the order moves to the next checkout step.',
  booking: 'A booking or scheduling page opens.',
  download: 'The download starts or a download page opens.',
  form: 'The form is accepted and a confirmation is shown.',
};

const KIND_TESTS = {
  signup: ['Submit with required fields empty', 'Use an invalid email format', 'Sign up twice with the same email', 'Try a weak or mismatched password'],
  login: ['Use a wrong password', 'Use an email that has no account', 'Check the "forgot password" link', 'Check that the session survives a reload'],
  'password-reset': ['Use an email that has no account', 'Check that the reset link expires', 'Check the message does not reveal whether the account exists'],
  search: ['Search with an empty query', 'Search for something with no results', 'Search with special characters'],
  contact: ['Submit with required fields empty', 'Use an invalid email format', 'Send a very long message'],
  newsletter: ['Use an invalid email format', 'Subscribe the same email twice'],
  checkout: ['Change the quantity', 'Remove the item again', 'Check prices and totals'],
  booking: ['Check that the booking page opens', 'Check that the link works on mobile'],
  download: ['Check that the file downloads and opens', 'Check the file size is reasonable'],
  form: ['Submit with required fields empty', 'Submit with invalid values'],
};

const quote = (s) => `"${s}"`;
const fieldText = (f) => `${quote(f.label || f.name || f.type)} (${f.type}${f.required ? ', required' : ''})`;

export function flowTitle(flow) {
  const where = flow.form?.heading || flow.cta?.text || (flow.form?.action && new URL(flow.form.action).pathname) || new URL(flow.pages[0]).pathname;
  return `${KIND_LABEL[flow.kind] ?? flow.kind}: ${where}`;
}

/** Plain-language difference between a changed flow and its previous structure. */
function describeChange(flow) {
  const before = flow.previous?.form;
  const after = flow.form;
  if (!before || !after) return 'The target of this call to action changed since the last run.';
  const label = (f) => quote(f.label || f.name || f.type);
  const id = (f) => `${f.name}|${f.type}`;
  const beforeIds = new Map(before.fields.map((f) => [id(f), f]));
  const afterIds = new Map(after.fields.map((f) => [id(f), f]));
  const notes = [];
  const added = after.fields.filter((f) => !beforeIds.has(id(f)));
  const removed = before.fields.filter((f) => !afterIds.has(id(f)));
  const required = after.fields.filter((f) => beforeIds.has(id(f)) && beforeIds.get(id(f)).required !== f.required);
  if (added.length) notes.push(`Added field(s): ${added.map(label).join(', ')}.`);
  if (removed.length) notes.push(`Removed field(s): ${removed.map(label).join(', ')}.`);
  if (required.length) notes.push(`Required changed for: ${required.map((f) => `${label(f)} (now ${f.required ? 'required' : 'optional'})`).join(', ')}.`);
  if (before.submit !== after.submit) notes.push(`Submit button changed from ${quote(before.submit ?? '—')} to ${quote(after.submit ?? '—')}.`);
  if (before.method !== after.method) notes.push(`Method changed from ${before.method.toUpperCase()} to ${after.method.toUpperCase()}.`);
  return notes.join(' ') || 'The structure of this form changed since the last run.';
}

/** Documentation from fixed rules, in the same shape the LLM returns. */
export function basicDoc(flow, startUrl) {
  // With no click path the flow was found on the start page itself.
  const steps = [`Open ${flow.entry[0]?.page ?? flow.pages[0] ?? startUrl}`];
  for (const step of flow.entry) steps.push(`Click ${quote(step.click)}`);
  if (flow.form) {
    if (!flow.form.visible) steps.push('Open the form (it is hidden until something on the page reveals it)');
    for (const f of flow.form.fields) steps.push(`Fill in ${fieldText(f)}`);
    steps.push(flow.form.submit ? `Press ${quote(flow.form.submit)}` : 'Submit the form');
  } else {
    steps.push(`Click ${quote(flow.cta.text)}${flow.cta.external ? ` (opens ${new URL(flow.cta.href).host})` : ''}`);
  }
  return {
    name: flowTitle(flow),
    purpose: `${KIND_LABEL[flow.kind] ?? 'Form'} flow found on ${flow.pages.length} page(s).`,
    preconditions: '',
    steps,
    expectedOutcome: `${KIND_OUTCOME[flow.kind] ?? KIND_OUTCOME.form} (Inferred from the kind of flow, not observed.)`,
    testIdeas: [...(KIND_TESTS[flow.kind] ?? KIND_TESTS.form), 'Complete the flow with the keyboard only', 'Complete the flow on a phone'],
    changeNote: flow.status === 'changed' ? describeChange(flow) : '',
    generatedBy: BASIC_GENERATOR,
  };
}

const toPrompt = (flow) => ({
  id: flow.id,
  status: flow.status,
  kind: flow.kind,
  source: flow.source,
  foundOn: flow.pages.slice(0, MAX_PAGES_SENT),
  pageCount: flow.pages.length,
  clickPath: flow.entry,
  form: flow.form,
  cta: flow.cta,
  previous: flow.status === 'changed' ? flow.previous : undefined,
});

function validDoc(doc) {
  return DOC_FIELDS.every((k) => k in doc)
    && ['name', 'purpose', 'preconditions', 'expectedOutcome', 'changeNote'].every((k) => typeof doc[k] === 'string')
    && Array.isArray(doc.steps) && Array.isArray(doc.testIdeas);
}

/**
 * Write docs for these flows (state entries) and attach them as `flow.doc`.
 * Uses the LLM when `llm` is set; any flow it does not document gets basicDoc(),
 * which also replaces the stale doc of a changed flow.
 * @returns {Promise<{ meta: object[], warnings: string[] }>}
 */
export async function documentFlows(flows, { llm, startUrl, log = () => {} }) {
  const meta = [];
  const warnings = [];
  const documented = new Set();
  if (llm) {
    for (let i = 0; i < flows.length; i += BATCH_SIZE) {
      const batch = flows.slice(i, i + BATCH_SIZE);
      log(`Documenting flows ${i + 1}–${i + batch.length} of ${flows.length} with ${llm.provider}…`);
      try {
        const { data, meta: m } = await callLlmJson(llm, {
          system: SYSTEM_PROMPT,
          schema: DOCS_SCHEMA,
          schemaName: 'flow_docs',
          prompt: `Start URL: ${startUrl}\n\nFlows (JSON):\n\n${JSON.stringify(batch.map(toPrompt))}`,
        });
        meta.push(m);
        const byId = new Map((Array.isArray(data?.flows) ? data.flows : []).filter(validDoc).map((d) => [d.id, d]));
        for (const flow of batch) {
          const doc = byId.get(flow.id);
          if (!doc) continue;
          flow.doc = { ...doc, generatedBy: `${m.model} (${m.provider})` };
          documented.add(flow.id);
        }
      } catch (err) {
        warnings.push(`The AI step failed for ${batch.length} flow(s) (${err.message}); those use basic rules instead.`);
        log(`⚠ ${warnings.at(-1)}`);
      }
    }
  }
  for (const flow of flows) {
    if (!documented.has(flow.id)) flow.doc = basicDoc(flow, startUrl);
  }
  return { meta, warnings };
}

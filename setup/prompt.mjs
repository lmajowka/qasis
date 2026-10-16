// Terminal prompts. Secrets are read in raw mode so they are never echoed,
// never land in shell history, and never pass through argv or env vars.
import { createInterface } from 'node:readline/promises';

export async function ask(question, fallback = '') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${question} ${hint} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

export async function choose(question, options) {
  console.log(question);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt.label}`));
  for (;;) {
    const answer = await ask(`Choose [1-${options.length}] (default 1): `, '1');
    const index = Number.parseInt(answer, 10) - 1;
    if (options[index]) return options[index].value;
    console.log('Invalid choice.');
  }
}

export function askSecret(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    return Promise.reject(new Error('Secret input requires an interactive terminal.'));
  }

  return new Promise((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          return resolve(value.trim());
        }
        if (ch === '\u0003' || ch === '\u0004') {
          // Ctrl-C / Ctrl-D
          cleanup();
          return reject(new Error('Cancelled.'));
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') value += ch; // drop other control characters
      }
    };

    stdout.write(`${question} (input hidden): `);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Show just enough of a key to recognise it: "sk-ant-…a1b2". */
export function maskKey(key) {
  if (key.length <= 12) return '…'.padEnd(4, '•');
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

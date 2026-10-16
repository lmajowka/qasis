// Terminal styling with plain ANSI escapes (no dependencies). Colors are
// dropped when stdout is not a TTY, when NO_COLOR is set, or when TERM=dumb.
const enabled =
  process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';

const wrap = (open, close) => (text) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const magenta = wrap(35, 39);

export const icons = {
  ok: green('✓'),
  fail: red('✗'),
  warn: yellow('⚠'),
  arrow: cyan('›'),
};

export const ok = (msg) => console.log(`${icons.ok} ${msg}`);
export const warn = (msg) => console.log(`${icons.warn} ${yellow(msg)}`);
export const fail = (msg) => console.error(`${icons.fail} ${red(msg)}`);

/** A section heading: "\n◆ Title" with a coloured marker. */
export const heading = (title) => console.log(`\n${magenta('◆')} ${bold(title)}`);

/** Aligned "Label   value" row for the status screen. */
export const row = (label, value) => console.log(`  ${dim(label.padEnd(18))}${value}`);

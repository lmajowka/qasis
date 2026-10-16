#!/usr/bin/env bash
# Qasis installer entry point.
#
#   bash qasis.sh               install / reconfigure
#   bash qasis.sh --status      show what is installed (never prints the key)
#   bash qasis.sh --uninstall   remove stored credentials and config
#
# Run this directly in a terminal: it needs interactive, hidden input.

set -euo pipefail
umask 077 # anything we create is readable by the current user only

REQUIRED_NODE_MAJOR=22
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors only on a real terminal, and never when NO_COLOR is set.
if [ -t 1 ] && [ -z "${NO_COLOR+x}" ] && [ "${TERM:-}" != "dumb" ]; then
  B=$'\033[1m' D=$'\033[2m' R=$'\033[31m' G=$'\033[32m' C=$'\033[36m' M=$'\033[35m' X=$'\033[0m'
else
  B='' D='' R='' G='' C='' M='' X=''
fi

fail() { printf '%s✗ %s%s\n' "$R" "$*" "$X" >&2; exit 1; }
ok()   { printf '%s✓%s %s\n' "$G" "$X" "$*"; }

printf '\n%s  ╭─────────────────────────────╮%s\n' "$M" "$X"
printf '%s  │%s  %s◆ Qasis%s  %ssetup & API key%s   %s│%s\n' "$M" "$X" "$B$C" "$X" "$D" "$X" "$M" "$X"
printf '%s  ╰─────────────────────────────╯%s\n\n' "$M" "$X"

# Never install as root: credentials would land in root's keychain/home.
if [ "$(id -u)" -eq 0 ]; then
  fail "Do not run Qasis setup as root or with sudo."
fi

case "$(uname -s)" in
  Darwin|Linux) ok "Platform: $(uname -s)" ;;
  *) fail "Unsupported platform $(uname -s). Use macOS or Linux (Windows via WSL2)." ;;
esac

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js ${REQUIRED_NODE_MAJOR}+ is required. Install it from https://nodejs.org or via nvm, then re-run."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  fail "Node.js ${REQUIRED_NODE_MAJOR}+ is required (found $(node -v))."
fi
ok "Node.js $(node -v)"

if [ ! -t 0 ] || [ ! -t 1 ]; then
  fail "Run this script in an interactive terminal (not piped, not inside another agent session)."
fi

exec node "$ROOT_DIR/setup/index.mjs" "$@"

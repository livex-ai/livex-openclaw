#!/bin/sh
set -eu
umask 077
LIVEX_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LIVEX_NODE=${LIVEX_NODE:-node}
case "$#:${1:-}" in
  0:|1:--check) ;;
  *) echo 'Usage: start-gateway.sh [--check]' >&2; exit 1 ;;
esac
case "${OPENCLAW_COMMAND:-}" in
  /*) [ -x "$OPENCLAW_COMMAND" ] || { echo 'OPENCLAW_COMMAND must be executable.' >&2; exit 1; } ;;
  *) echo 'Set OPENCLAW_COMMAND to the absolute path of your configured OpenClaw CLI or wrapper.' >&2; exit 1 ;;
esac
case "${OPENCLAW_STATE_DIR:-}" in
  /*) ;;
  *) echo 'Set OPENCLAW_STATE_DIR to the absolute path of your existing private state directory.' >&2; exit 1 ;;
esac
OPENCLAW_CONFIG_PATH=${OPENCLAW_CONFIG_PATH:-"$OPENCLAW_STATE_DIR/openclaw.json"}
export OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH
case "$OPENCLAW_CONFIG_PATH" in
  /*) ;;
  *) echo 'OPENCLAW_CONFIG_PATH must be an absolute path.' >&2; exit 1 ;;
esac
command -v "$LIVEX_NODE" >/dev/null 2>&1 || { echo 'Install Node.js or set LIVEX_NODE to its executable path.' >&2; exit 1; }
command -v lsof >/dev/null 2>&1 || { echo 'Install lsof and add it to PATH before startup.' >&2; exit 1; }
if [ "${1:-}" != '--check' ] && lsof -nP -iTCP:18791 -sTCP:LISTEN >/dev/null 2>&1; then
  echo 'OpenClaw is already listening on port 18791. Existing Gateway left untouched. Stop it in its terminal before starting again.' >&2
  exit 1
fi
"$LIVEX_NODE" "$LIVEX_SCRIPT_DIR/preflight.mjs" --config "$OPENCLAW_CONFIG_PATH" "$@"
if [ "${1:-}" = '--check' ]; then exit 0; fi
exec "$OPENCLAW_COMMAND" gateway run --bind loopback --port 18791 --auth token --tailscale off

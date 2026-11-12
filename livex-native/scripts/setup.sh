#!/usr/bin/env bash
# Set up LiveX Debugger on a stock OpenClaw install.
#
# Default is a dry run that only prints the commands. Pass --apply to run them.
# This script never restarts a Gateway and never runs interactive sign-in.
set -euo pipefail

usage() {
  echo "usage: $0 [--apply]" >&2
}

APPLY=0
case "${1:-}" in
  "") ;;
  --apply) APPLY=1 ;;
  -h | --help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_IDS=(livex-gcp-readonly livex-slack-summary)
AGENTS_DIR="$ROOT/agents"
AGENT_IDS=(debugger)
FRAGMENT="$ROOT/config/openclaw.fragment.json5"
MODEL="openai/gpt-6-astra"

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [ "$APPLY" -eq 1 ]; then
    "$@"
  fi
}

# Re-run safety (--apply only; dry run never calls openclaw).
# `plugins list --json` prints {"plugins":[{"id":...}]} and `agents list --json`
# prints [{"id":...}] (src/cli/plugins-list-command.ts, src/commands/agents.commands.list.ts).
has_plugin() {
  openclaw plugins list --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const ids = (JSON.parse(s).plugins || []).map((p) => p.id);
      process.exit(ids.includes(process.argv[1]) ? 0 : 1);
    });' "$1"
}
has_agent() {
  openclaw agents list --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const list = JSON.parse(s);
      process.exit(Array.isArray(list) && list.some((a) => a.id === process.argv[1]) ? 0 : 1);
    });' "$1"
}

if [ "$APPLY" -eq 1 ]; then
  command -v node >/dev/null || { echo "node not found on PATH" >&2; exit 1; }
  command -v openclaw >/dev/null || { echo "openclaw CLI not found on PATH" >&2; exit 1; }
else
  echo "Dry run: printing commands only. Re-run with --apply to execute."
fi
echo

echo "# 1. Install the official Codex plugin (the agent's brain)."
if [ "$APPLY" -eq 1 ] && has_plugin codex; then
  echo "codex plugin already present; skipping install."
else
  run openclaw plugins install @openclaw/codex
fi
echo

echo "# 2. Sign in to OpenAI for Codex. Interactive; run it yourself:"
echo "#      openclaw models auth login --provider openai --agent debugger"
echo

echo "# 3. Install the LiveX evidence and Slack summary plugins."
echo "#    Linked install: OpenClaw loads TypeScript entries only from source"
echo "#    checkouts and linked/local paths. --force confirms the local source"
echo "#    and makes a re-run safe."
for plugin_id in "${PLUGIN_IDS[@]}"; do
  run openclaw plugins install -l "$ROOT/plugins/$plugin_id" --force
done
echo

echo "# 4. Create each agent with its folder under agents/ as its workspace."
for agent_id in "${AGENT_IDS[@]}"; do
  if [ "$APPLY" -eq 1 ] && has_agent "$agent_id"; then
    echo "agent $agent_id already exists; skipping agents add."
  else
    run openclaw agents add "$agent_id" --workspace "$AGENTS_DIR/$agent_id" --model "$MODEL" --non-interactive
  fi
done
echo

cat <<EOF
# 5. Merge the config fragment into ~/.openclaw/openclaw.json:
#      $FRAGMENT
#    Set the GCLOUD_*, CLOUDSDK_CONFIG, GCP_PROJECT,
#    SLACK_SENDER_ID and PYTHON_PATH variables for the Gateway process.
#    If upgrading the earlier two-agent demo, see the routing migration in
#    $ROOT/README.md before merging. Config changes apply on hot reload.
#
# 6. In the Control UI:
#    - Plugins: confirm codex, livex-gcp-readonly and livex-slack-summary
#      are enabled; fill any missing livex-gcp-readonly config fields.
#    - Agents: open "debugger" (LiveX Debugger) for triage and diagnosis.
#      Both LiveX tools answer only Slack turns from SLACK_SENDER_ID.
#      A Control UI chat has no LiveX evidence tools.
#    - In a chat with the agent, run /status and check "Runtime: OpenAI Codex".
#
# 7. The Slack channel wildcard and agents.defaults.systemAgent both point
#    to debugger. Set the Slack bot and app tokens as for any Slack app.
EOF

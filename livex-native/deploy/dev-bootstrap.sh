#!/usr/bin/env bash
# One-time, idempotent setup for running livex-native NEXT TO PR #1 on the
# existing livex-openclaw-dev VM (LIVEX_ON_DEV_VM=1). Runs as root via deploy.sh.
#
# It only creates /opt/livex-openclaw-test (never touches /opt/livex-openclaw or
# PR #1's containers) and, if runtime.env is missing, derives it from the running
# PR #1 Gateway: the two Slack tokens from its container environment, and the
# logs project, allowed Slack user and gcloud account from its config. Secret
# values are never printed.
set -euo pipefail
umask 077

root=/opt/livex-openclaw-test
dev_container=livex-openclaw-dev-gateway-1

[[ $(hostname) == livex-openclaw-dev ]] \
  || { echo "dev-bootstrap: refusing to run on host '$(hostname)'." >&2; exit 1; }

install -d -m 0755 "$root" "$root/releases"
install -d -m 0700 -o 1000 -g 1000 "$root/state" "$root/gcloud"

if [[ -s $root/runtime.env ]]; then
  echo "dev-bootstrap: $root/runtime.env exists; kept."
  exit 0
fi

[[ $(docker inspect --format '{{.State.Running}}' "$dev_container" 2>/dev/null) == true ]] || {
  echo "dev-bootstrap: $root/runtime.env is missing and $dev_container is not running, so its settings cannot be read." >&2
  echo "Start it once (sudo docker start $dev_container) and rerun the deploy." >&2
  exit 1
}

# Non-secret settings from PR #1's config.
settings=$(docker exec "$dev_container" node -e '
const c = JSON.parse(require("fs").readFileSync("/home/node/.openclaw/openclaw.json", "utf8"));
const p = c.plugins?.entries?.["livex-gcp-readonly"]?.config ?? {};
process.stdout.write([p.project ?? "", p.allowedSenderId ?? "", p.gcloudAccount ?? ""].join("\n") + "\n");
')
gcp_project=$(sed -n 1p <<<"$settings")
sender=$(sed -n 2p <<<"$settings")
account=$(sed -n 3p <<<"$settings")
[[ $gcp_project =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ ]] || { echo "dev-bootstrap: unexpected logs project in PR #1 config." >&2; exit 1; }
[[ $sender =~ ^[UW][A-Z0-9]+$ ]] || { echo "dev-bootstrap: unexpected allowedSenderId in PR #1 config." >&2; exit 1; }
[[ $account =~ ^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$ ]] || { echo "dev-bootstrap: unexpected gcloudAccount in PR #1 config." >&2; exit 1; }

tmp=$(mktemp "$root/.runtime.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT
{
  echo "OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$dev_container" \
    | grep -E '^SLACK_(BOT|APP)_TOKEN=' || true
  echo "SLACK_SENDER_ID=$sender"
  echo "GCLOUD_PATH=/opt/google-cloud-sdk/bin/gcloud"
  echo "CLOUDSDK_CONFIG=/home/node/.config/gcloud"
  echo "GCLOUD_ACCOUNT=$account"
  echo "GCP_PROJECT=$gcp_project"
  echo "PYTHON_PATH=/usr/bin/python3"
  echo "GCLOUD_SDK_ROOT=/opt/google-cloud-sdk"
} >"$tmp"
[[ $(grep -cE '^SLACK_(BOT|APP)_TOKEN=.' "$tmp") == 2 ]] \
  || { echo "dev-bootstrap: could not read both Slack tokens from $dev_container." >&2; exit 1; }
chmod 0600 "$tmp"
mv "$tmp" "$root/runtime.env"
trap - EXIT
echo "dev-bootstrap: wrote $root/runtime.env (logs project $gcp_project, Slack user $sender, account $account)."

#!/usr/bin/env bash
# Initialize isolated livex-native staging on the existing DEV VM.
# Read only the GCP tool settings from the running PR #1 Gateway.
set -euo pipefail
umask 077

root=/opt/livex-openclaw-stage
runtime_env=$root/runtime.env
dev_container=livex-openclaw-dev-gateway-1

[[ $(hostname) == livex-openclaw-dev ]] \
  || { echo "dev-bootstrap: refusing to run on host '$(hostname)'." >&2; exit 1; }

# An earlier design installed /opt/livex-openclaw-test on this VM with a copy of
# PR #1's Slack tokens. If its Gateway runs, two Gateways share one Slack app.
legacy_root=/opt/livex-openclaw-test
legacy_container=livex-openclaw-test-gateway-1
if [[ $(docker inspect --type container --format '{{.State.Running}}' "$legacy_container" 2>/dev/null) == true ]]; then
  echo "dev-bootstrap: $legacy_container is running on PR #1's Slack app. Stop it first: sudo docker stop $legacy_container" >&2
  exit 1
fi
if [[ -e $legacy_root ]] || docker inspect --type container "$legacy_container" >/dev/null 2>&1; then
  echo "dev-bootstrap: WARNING: leftover install found ($legacy_root and/or the stopped container $legacy_container)." >&2
  echo "dev-bootstrap: it can hold a copy of PR #1's Slack tokens, and starting that container would put a second Gateway on the same Slack app." >&2
  echo "dev-bootstrap: remove it once (README, 'Remove the earlier DEV install')." >&2
fi

for dir in "$root" "$root/releases" "$root/state" "$root/gcloud"; do
  [[ ! -L $dir ]] || { echo "dev-bootstrap: staging paths must be real directories: $dir" >&2; exit 1; }
done
install -d -m 0755 "$root" "$root/releases"
install -d -m 0700 -o 1000 -g 1000 "$root/state" "$root/gcloud"

if [[ -e $runtime_env ]]; then
  [[ ! -L $runtime_env && -O $runtime_env && -f $runtime_env && -s $runtime_env ]] \
    || { echo "dev-bootstrap: expected a nonempty root-owned file at $runtime_env." >&2; exit 1; }
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?SLACK_(BOT_TOKEN|APP_TOKEN|USER_TOKEN|SIGNING_SECRET)([[:space:]]*[:=]|[[:space:]]*$)' "$runtime_env"; then
    echo "dev-bootstrap: remove Slack credentials from $runtime_env before staging." >&2
    exit 1
  fi
  chmod 0600 "$runtime_env"
  echo "dev-bootstrap: $runtime_env exists; kept."
  exit 0
fi

[[ $(docker inspect --format '{{.State.Running}}' "$dev_container" 2>/dev/null) == true ]] || {
  echo "dev-bootstrap: $root/runtime.env is missing and $dev_container is not running, so its settings cannot be read." >&2
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

gateway_token=$(openssl rand -hex 32)
tmp=$(mktemp "$root/.runtime.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT
{
  echo "OPENCLAW_GATEWAY_TOKEN=$gateway_token"
  echo "SLACK_SENDER_ID=$sender"
  echo "GCLOUD_PATH=/opt/google-cloud-sdk/bin/gcloud"
  echo "CLOUDSDK_CONFIG=/home/node/.config/gcloud"
  echo "GCLOUD_ACCOUNT=$account"
  echo "GCP_PROJECT=$gcp_project"
  echo "PYTHON_PATH=/usr/bin/python3"
  echo "GCLOUD_SDK_ROOT=/opt/google-cloud-sdk"
} >"$tmp"
# Publish once so concurrent setup cannot replace the staging gateway token.
ln "$tmp" "$runtime_env"
echo "dev-bootstrap: wrote $runtime_env."

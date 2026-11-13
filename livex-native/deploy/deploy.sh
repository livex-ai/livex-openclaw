#!/usr/bin/env bash
# Deploy a reviewed livex-native bundle to the test VM or stage it on DEV.
# Runs on the operator's Mac. See deploy/README.md for the one-time VM setup.
#
#   bash livex-native/deploy/deploy.sh FULL_SHA [--dry-run]
#
# --dry-run prints every gcloud command and never runs gcloud.
set -euo pipefail
umask 077

usage() {
  echo "Usage: bash livex-native/deploy/deploy.sh FULL_COMMIT_SHA [--dry-run]" >&2
  exit 2
}

[[ ${1:-} =~ ^[0-9a-f]{40}$ ]] || usage
[[ $# == 1 || ( $# == 2 && $2 == --dry-run ) ]] || usage
sha=$1
dry=0
[[ ${2:-} == --dry-run ]] && dry=1

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(git -C "$here" rev-parse --show-toplevel)
tooling=$(git -C "$repo" rev-parse HEAD)
# Refuse an edited or untracked deploy script: only reviewed, committed tooling runs.
git -C "$repo" ls-files --error-unmatch -- livex-native/deploy/deploy.sh >/dev/null 2>&1 \
  && git -C "$repo" diff --exit-code --quiet "$tooling" -- livex-native/deploy \
  || { echo "Use the committed deployment tooling (livex-native/deploy has local changes)." >&2; exit 1; }
[[ $(git -C "$repo" cat-file -t "$sha") == commit ]] || { echo "Not a commit: $sha" >&2; exit 1; }
# Deploy exactly the checked-out, reviewed tooling's commit.
[[ $sha == "$tooling" ]] || { echo "sha must equal the checked-out HEAD ($tooling)." >&2; exit 1; }

# The default target is a dedicated test VM. DEV mode stages a separate Gateway
# with channel startup disabled and leaves the running DEV Gateway alone.
on_dev=0
[[ ${LIVEX_ON_DEV_VM:-0} == 1 ]] && on_dev=1
project=ai-mvp-dv
zone=${LIVEX_TEST_ZONE:-us-central1-a}
if ((on_dev)); then
  [[ -z ${LIVEX_TEST_VM:-} ]] || { echo "LIVEX_ON_DEV_VM=1 cannot be combined with LIVEX_TEST_VM." >&2; exit 1; }
  vm=livex-openclaw-dev
else
  vm=${LIVEX_TEST_VM:-livex-openclaw-test}
  [[ $vm != livex-openclaw-dev ]] \
    || { echo "Refusing to deploy to livex-openclaw-dev (use LIVEX_ON_DEV_VM=1 for the side-by-side install)." >&2; exit 1; }
  [[ $vm =~ ^livex-openclaw-test(-[a-z0-9-]+)?$ ]] \
    || { echo "VM name must match livex-openclaw-test[-suffix]; refusing '$vm'." >&2; exit 1; }
fi
[[ ${LIVEX_TEST_PROJECT:-$project} == "$project" ]] || { echo "Project is fixed to $project." >&2; exit 1; }
[[ $zone =~ ^[a-z]+-[a-z]+[0-9]+-[a-z]$ ]] || { echo "Invalid zone: $zone" >&2; exit 1; }
location=(--project="$project" --zone="$zone")
# SSH goes through IAP (the VM firewall only admits IAP); LIVEX_TEST_IAP=0 turns it off.
ssh_extra=()
scp_extra=()
if [[ ${LIVEX_TEST_IAP:-1} != 0 ]]; then
  location+=(--tunnel-through-iap)
else
  # Direct SSH, as PR #1's deploy does: force IPv4.
  ssh_extra=(--ssh-flag=-4)
  scp_extra=(--scp-flag=-4)
fi
compose_project=livex-openclaw-test
default_timeout=120
if ((on_dev)); then
  compose_project=livex-openclaw-stage
  default_timeout=300
fi
root=/opt/$compose_project
health_timeout=${LIVEX_HEALTH_TIMEOUT:-$default_timeout}
[[ $health_timeout =~ ^[1-9][0-9]{0,3}$ ]] && ((health_timeout <= 3600)) \
  || { echo "LIVEX_HEALTH_TIMEOUT must be a whole number of seconds from 1 to 3600." >&2; exit 2; }
# Optional free-space floor (GiB) for remote.sh; forwarded only when set.
min_free_arg=""
if [[ -n ${LIVEX_MIN_FREE_GIB:-} ]]; then
  [[ $LIVEX_MIN_FREE_GIB =~ ^[0-9]{1,4}$ ]] \
    || { echo "LIVEX_MIN_FREE_GIB must be a whole number of GiB from 0 to 9999." >&2; exit 2; }
  min_free_arg=" LIVEX_MIN_FREE_GIB=$LIVEX_MIN_FREE_GIB"
fi

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ $dry == 0 ]]; then "$@"; fi
}

work=$(mktemp -d "${TMPDIR:-/tmp}/livex-test-deploy.XXXXXX")
trap 'rm -rf "$work"' EXIT
archive="$work/livex-native-$sha.tgz"
git -C "$repo" archive --format=tar.gz -o "$archive" "$sha" livex-native
hash=$(shasum -a 256 "$archive" | cut -d ' ' -f1)
echo "Archive: livex-native @ $sha (sha256 $hash)"
echo "Target: $vm ($project, $zone), project $compose_project, readiness timeout ${health_timeout}s"
if ((on_dev)); then echo "DEV staging: the current DEV Gateway keeps serving Slack."; fi

upload="livex-deploy-$sha.tgz"
if ((on_dev)); then
  # 1. Bootstrap the separate staging root. Send reviewed code over stdin so it
  # does not depend on the remote login shell's quoting.
  bootstrap=$(git -C "$repo" show "$sha:livex-native/deploy/dev-bootstrap.sh")
  run gcloud compute ssh "$vm" "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"} --command="sudo bash -s" <<<"$bootstrap"
else
  # 1. The VM must already be set up (README); also proves access before uploading.
  run gcloud compute ssh "$vm" "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"} --command="sudo test -d $root/state && sudo test -r $root/runtime.env"
fi
# 2. Upload to the operator's home on the VM.
run gcloud compute scp "${location[@]}" ${scp_extra[@]+"${scp_extra[@]}"} "$archive" "$vm:$upload"
# 3. Verify, unpack, and run remote.sh under the deploy lock. sha and hash are
#    validated hex, so they are safe to embed.
inner='set -eu; test -f "$UP"; echo "$HASH  $UP" | sha256sum -c - >/dev/null; rel='"$root"'/releases/$SHA; if [ ! -d "$rel" ]; then tmp=$(mktemp -d '"$root"'/releases/.incoming.XXXXXX); trap '\''rm -rf "$tmp"'\'' EXIT; tar -xzf "$UP" -C "$tmp"; mv "$tmp" "$rel"; trap - EXIT; fi; rm -f "$UP"; exec bash "$rel/livex-native/deploy/remote.sh" "$SHA"'
remote_cmd="up=\"\$HOME/$upload\"; sudo flock -n $root/deploy.lock env UP=\"\$up\" SHA=$sha HASH=$hash LIVEX_ON_DEV_VM=$on_dev LIVEX_HEALTH_TIMEOUT=$health_timeout$min_free_arg bash -c $(printf %q "$inner")"
run gcloud compute ssh "$vm" "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"} --command="$remote_cmd"
if [[ $dry == 1 ]]; then echo "Dry run: nothing was uploaded or changed."; exit 0; fi

lx="sudo docker compose --project-name $compose_project -f $root/current-release/livex-native/deploy/compose.yaml --env-file $root/compose.env"
echo
echo "Next, once: sign Codex in for the debugger agent (approve the code at https://auth.openai.com/codex/device):"
printf '  gcloud compute ssh %s' "$vm"; printf ' %q' "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"}; printf -- " --command=%q -- -t\n" "$lx exec gateway node /app/openclaw.mjs models auth login --provider openai --method device-code --agent debugger"
if ((on_dev)); then
  echo "After sign-in, check the staged debugger agent (shared Slack stays on the current DEV Gateway):"
  printf '  gcloud compute ssh %s' "$vm"; printf ' %q' "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"}; printf -- " --command=%q\n" "$lx exec -T gateway node /app/openclaw.mjs agent --agent debugger --session-key stage-smoke --message 'Reply with READY only.' --json"
fi

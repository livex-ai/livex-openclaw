#!/usr/bin/env bash
# Deploy a reviewed commit's livex-native/ bundle to the SEPARATE test VM.
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

# The target is a test VM. The name is allowlisted, the project is fixed, and only
# the zone can be overridden. LIVEX_ON_DEV_VM=1 is the one explicit exception: it
# installs side by side on livex-openclaw-dev under /opt/livex-openclaw-test, never
# touching PR #1's /opt/livex-openclaw, and stops PR #1's Gateway only at cutover.
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
root=/opt/livex-openclaw-test

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
echo "Target: $vm ($project, $zone)$( ((on_dev)) && echo ' side by side with PR #1, which is stopped at cutover')"

upload="livex-deploy-$sha.tgz"
if ((on_dev)); then
  # 1. Idempotent side-by-side setup on the dev VM (creates /opt/livex-openclaw-test
  #    and, once, runtime.env from PR #1's running Gateway). Sent from the reviewed sha.
  bootstrap=$(git -C "$repo" show "$sha:livex-native/deploy/dev-bootstrap.sh")
  run gcloud compute ssh "$vm" "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"} --command="sudo bash -c $(printf %q "$bootstrap")"
else
  # 1. The VM must already be set up (README); also proves access before uploading.
  run gcloud compute ssh "$vm" "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"} --command="sudo test -d $root/state && sudo test -r $root/runtime.env"
fi
# 2. Upload to the operator's home on the VM.
run gcloud compute scp "${location[@]}" ${scp_extra[@]+"${scp_extra[@]}"} "$archive" "$vm:$upload"
# 3. Verify, unpack, and run remote.sh under the deploy lock. sha and hash are
#    validated hex, so they are safe to embed.
inner='set -eu; test -f "$UP"; echo "$HASH  $UP" | sha256sum -c - >/dev/null; rel='"$root"'/releases/$SHA; tmp=$(mktemp -d '"$root"'/releases/.incoming.XXXXXX); tar -xzf "$UP" -C "$tmp"; rm -rf "$rel"; mv "$tmp" "$rel"; rm -f "$UP"; exec bash "$rel/livex-native/deploy/remote.sh" "$SHA"'
remote_cmd="up=\"\$HOME/$upload\"; sudo flock -n $root/deploy.lock env UP=\"\$up\" SHA=$sha HASH=$hash LIVEX_ON_DEV_VM=$on_dev bash -c $(printf %q "$inner")"
run gcloud compute ssh "$vm" "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"} --command="$remote_cmd"
if [[ $dry == 1 ]]; then echo "Dry run: nothing was uploaded or changed."; exit 0; fi

lx="sudo docker compose --project-name livex-openclaw-test -f $root/current-release/livex-native/deploy/compose.yaml --env-file $root/compose.env"
echo
echo "Next, once: sign Codex in for the oncall agent (approve the code at https://auth.openai.com/codex/device):"
printf '  gcloud compute ssh %s' "$vm"; printf ' %q' "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"}; printf -- " -- -t %q\n" "$lx exec gateway node /app/openclaw.mjs models auth login --provider openai --method device-code --agent oncall"
if ((on_dev)); then
  echo "PR #1's Gateway is stopped. To switch back to it:"
  printf '  gcloud compute ssh %s' "$vm"; printf ' %q' "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"}; printf -- " --command=%q\n" "sudo docker stop livex-openclaw-test-gateway-1 && sudo docker start livex-openclaw-dev-gateway-1"
fi

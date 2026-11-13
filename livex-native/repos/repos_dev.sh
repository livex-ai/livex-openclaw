#!/usr/bin/env bash
# `make repos_dev`: build the pinned source snapshots on the operator's Mac, upload
# them to the DEV VM and install them under /opt/livex-openclaw-native-dev/repos.
#
#   bash livex-native/repos/repos_dev.sh [--dry-run]
#
# --dry-run prints every gcloud command and runs none (it does not build either).
# A real run needs CONFIRM=livex-openclaw-dev. Installing does not restart anything:
# the running container keeps its old /repos mount until `make deploy_dev` recreates it.
# Same IAP handling as deploy.sh: LIVEX_TEST_IAP=0 switches to direct SSH over IPv4.
# Test knobs: LIVEX_REPOS_MANIFEST (also skips the "manifest is committed" check).
set -euo pipefail

dry=0
case ${1:-} in
  "") ;;
  --dry-run) dry=1 ;;
  *) echo "Usage: bash livex-native/repos/repos_dev.sh [--dry-run]" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "Usage: bash livex-native/repos/repos_dev.sh [--dry-run]" >&2; exit 2; }

here=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)
manifest=${LIVEX_REPOS_MANIFEST:-$here/manifest.json}
vm=livex-openclaw-dev
project=ai-mvp-dv
zone=${LIVEX_TEST_ZONE:-us-central1-a}
root=/opt/livex-openclaw-native-dev

if ((!dry)) && [[ ${CONFIRM:-} != livex-openclaw-dev ]]; then
  echo "repos_dev: refusing. This installs source snapshots on the live DEV VM; confirm with: make repos_dev CONFIRM=livex-openclaw-dev" >&2
  exit 1
fi
[[ $zone =~ ^[a-z]+-[a-z]+[0-9]+-[a-z]$ ]] || { echo "repos_dev: invalid zone: $zone" >&2; exit 1; }
for tool in git tar gzip; do
  command -v "$tool" >/dev/null 2>&1 || { echo "repos_dev: '$tool' is required." >&2; exit 1; }
done
if ((!dry)); then
  command -v gcloud >/dev/null 2>&1 || { echo "repos_dev: gcloud is required (install and sign in, or use repos_dev_dry)." >&2; exit 1; }
fi
[[ -f $manifest ]] || { echo "repos_dev: manifest not found: $manifest" >&2; exit 1; }
if [[ -z ${LIVEX_REPOS_MANIFEST:-} ]]; then
  repo=$(git -C "$here" rev-parse --show-toplevel)
  dirty=$(git -C "$repo" status --porcelain --untracked-files=all -- livex-native/repos/manifest.json)
  if [[ -n $dirty ]]; then
    echo "repos_dev: refusing, livex-native/repos/manifest.json is not committed (pin, review, commit, then retry):" >&2
    printf '%s\n' "$dirty" >&2
    exit 1
  fi
fi
grep -Eq '"commit": "[0-9a-f]{40}"' "$manifest" || { echo "repos_dev: no pinned commits in $manifest; run: make repos_pin" >&2; exit 1; }

sha=$(if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$manifest"; else sha256sum "$manifest"; fi | cut -c1-12)
name=repositories-$sha.tar.gz
location=(--project="$project" --zone="$zone")
ssh_extra=()
scp_extra=()
if [[ ${LIVEX_TEST_IAP:-1} != 0 ]]; then
  location+=(--tunnel-through-iap)
else
  ssh_extra=(--ssh-flag=-4)
  scp_extra=(--scp-flag=-4)
fi

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ $dry == 0 ]]; then "$@"; fi
}

echo "repos_dev: target = $vm ($root/repos), snapshot $name"
echo "repos_dev: installing does not restart the Gateway; run make deploy_dev afterwards to activate"
out=${LIVEX_REPOS_OUT:-$here/build}
if ((dry)); then
  asha=SHA256_OF_ARCHIVE_KNOWN_AFTER_BUILD
else
  LIVEX_REPOS_OUT=$out bash "$here/repos.sh" build
  asha=$(sed -n 's/^  "archiveSha256": "\([0-9a-f]\{64\}\)",$/\1/p' "$out/repositories.receipt.json")
  [[ $asha =~ ^[0-9a-f]{64}$ ]] || { echo "repos_dev: could not read the archive sha256 from the receipt." >&2; exit 1; }
fi

# The manifest travels with the archive under a name that cannot collide on the VM.
mname=livex-repos-manifest-$sha.json
work=$(mktemp -d "${TMPDIR:-/tmp}/livex-repos-dev.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$manifest" "$work/$mname"
# The upload holds source: owner-only on both ends (the install runs as root).
chmod 0600 "$work/$mname"
if ((!dry)); then chmod 0600 "$out/$name"; fi
run gcloud compute ssh "$vm" "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"} --command="sudo test -d $root && sudo test -r $root/runtime.env"
run gcloud compute scp "${location[@]}" ${scp_extra[@]+"${scp_extra[@]}"} "$out/$name" "$work/$mname" "$vm:"
# $HOME is the ssh user's; the reviewed script travels over stdin (as deploy.sh does for
# the bootstrap) and runs under the deploy lock so it cannot race a deploy; the marker tells
# repos.sh the lock is already held.
remote_cmd="sudo flock -n $root/deploy.lock env LIVEX_REPOS_LOCKED=1 bash -s -- install \"\$HOME/$name\" $asha \"\$HOME/$mname\"; rc=\$?; rm -f \"\$HOME/$name\" \"\$HOME/$mname\"; exit \$rc"
script=$(cat "$here/repos.sh")
run gcloud compute ssh "$vm" "${location[@]}" ${ssh_extra[@]+"${ssh_extra[@]}"} --command="$remote_cmd" <<<"$script"
if ((dry)); then
  echo "Dry run: nothing was built, uploaded or changed."
else
  echo "repos_dev: installed. The running Gateway still has its old /repos mount; run: make deploy_dev CONFIRM=livex-openclaw-dev"
fi

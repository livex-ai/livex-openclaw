#!/usr/bin/env bash
# `make deploy_dev`: deploy the checked-out HEAD to the LIVE Slack-serving
# livex-native Gateway on the DEV VM (livex-openclaw-dev, /opt/livex-openclaw-native-dev).
# Runs on the operator's Mac. This only checks the preconditions, then hands over
# to deploy.sh in live mode (which does the real work and prints every gcloud call).
#
#   bash livex-native/deploy/deploy_dev.sh [--dry-run]
#
# Preconditions (each refusal changes nothing):
#   1. livex-native/ has no modified, staged or untracked files, so the archive that
#      is deployed is exactly HEAD and nothing local is silently left out.
#   2. HEAD is contained in an origin/* branch (checked after `git fetch --prune`),
#      so the deployed commit is reviewable by others.
#   3. git, tar and shasum exist; gcloud exists unless --dry-run.
#   4. A real (not --dry-run) deploy restarts the live Slack Gateway, so it needs
#      CONFIRM=livex-openclaw-dev in the environment (make deploy_dev CONFIRM=...).
# deploy.sh needs no Node; Node is only needed to run the apply/patch tests.
set -euo pipefail

dry=0
case ${1:-} in
  "") ;;
  --dry-run) dry=1 ;;
  *) echo "Usage: bash livex-native/deploy/deploy_dev.sh [--dry-run]" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "Usage: bash livex-native/deploy/deploy_dev.sh [--dry-run]" >&2; exit 2; }

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(git -C "$here" rev-parse --show-toplevel)
cd "$repo"

for tool in git tar shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "deploy_dev: '$tool' is required." >&2; exit 1; }
done
if ((!dry)); then
  command -v gcloud >/dev/null 2>&1 || { echo "deploy_dev: gcloud is required (install and sign in, or use deploy_dev_dry)." >&2; exit 1; }
fi

dirty=$(git status --porcelain --untracked-files=all -- livex-native)
if [[ -n $dirty ]]; then
  echo "deploy_dev: refusing, livex-native/ has uncommitted or untracked files:" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

sha=$(git rev-parse HEAD)
git fetch --quiet --prune origin \
  || { echo "deploy_dev: 'git fetch --prune origin' failed; cannot confirm HEAD is pushed." >&2; exit 1; }
branches=$(git branch -r --contains "$sha" --list 'origin/*' 2>/dev/null | sed 's/^[* ]*//' | grep -v -- ' -> ' || true)
if [[ -z $branches ]]; then
  echo "deploy_dev: refusing, $sha is not on any origin branch. Push it first (git push origin HEAD)." >&2
  exit 1
fi

echo "deploy_dev: HEAD $sha ($(git log -1 --format=%s "$sha"))"
echo "deploy_dev: on origin branch(es): $(printf '%s' "$branches" | tr '\n' ' ')"
echo "deploy_dev: target = LIVE Gateway on livex-openclaw-dev (/opt/livex-openclaw-native-dev, Slack on, port 18790)"
if ((!dry)) && [[ ${CONFIRM:-} != livex-openclaw-dev ]]; then
  echo "deploy_dev: refusing. This restarts the live Slack Gateway; confirm with: make deploy_dev CONFIRM=livex-openclaw-dev" >&2
  exit 1
fi

args=("$sha")
((!dry)) || args+=(--dry-run)
LIVEX_DEV_LIVE=1 exec bash "$here/deploy.sh" "${args[@]}"

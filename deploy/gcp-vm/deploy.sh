#!/usr/bin/env bash
# Deploy a reviewed commit to the existing livex-openclaw-dev installation.
set -euo pipefail
umask 077

if [[ ! ${1:-} =~ ^[0-9a-f]{40}$ ]] || ! { [[ $# == 1 ]] || [[ $# == 3 && $2 == --resume-after-base ]]; }; then
  echo "Usage: bash deploy/gcp-vm/deploy.sh FULL_COMMIT_SHA [--resume-after-base LOCAL_BUILD_DIR]" >&2
  exit 2
fi
sha=$1
helpers=$(cd "$(dirname "$0")" && pwd -P)
repo=$(git -C "$helpers" rev-parse --show-toplevel)
tooling=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" diff --exit-code --quiet "$tooling" -- deploy/gcp-vm/deploy.sh || { echo "Use the committed deployment script." >&2; exit 1; }
[[ $(git -C "$repo" cat-file -t "$sha") == commit ]]


vm=livex-openclaw-dev
location=(--project=ai-mvp-dv --zone=us-central1-a)
remote() { gcloud compute ssh "$vm" "${location[@]}" --ssh-flag=-4 --command="$1"; }
old=$(remote "sudo docker inspect --format '{{.Image}}' livex-openclaw-dev-gateway-1")
[[ $old =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Cannot identify running image.' >&2; exit 1; }
upload="openclaw-deploy-$sha"
resume_flag=""
if [[ $# == 3 ]]; then
  work=$(cd "$3" && pwd -P)
  [[ $(git -C "$work/src" rev-parse HEAD) == "$sha" && -f "$work/package-context/openclaw-current.tgz" ]]
  [[ $(gzip -dc "$work/source.tar.gz" | { git get-tar-commit-id; cat >/dev/null; }) == "$sha" ]] || exit 1
  remote "test -d '$upload/package-context' && sudo test -f '/opt/livex-openclaw/releases/$sha/build-receipts.json'"
  resume_flag=--resume-after-base
else
  [[ $(node --version) == v24.16.0 && $(pnpm --version) == 12.12.1 ]] || {
    echo 'Use Node 24.16.0 and pnpm 12.12.1 on PATH.' >&2
    exit 1
  }
  remote "test ! -e '$upload' && sudo test ! -e '/opt/livex-openclaw/releases/$sha'" || {
    echo 'Existing candidate or upload. Reconcile before retrying.' >&2
    exit 1
  }

  work=$(mktemp -d "${DEPLOY_WORK_DIR:-${TMPDIR:-/tmp}}/openclaw-deploy.XXXXXX")
  work=$(cd "$work" && pwd -P)
  echo "Private build artifacts: $work"
  mkdir "$work/tmp" "$work/package" "$work/helpers"
  for helper in build_candidate.py activate_image.py release_inputs.py; do
    git -C "$repo" show "$tooling:deploy/gcp-vm/$helper" > "$work/helpers/$helper"
  done
  export TMPDIR="$work/tmp" npm_config_cache="$work/npm-cache"
  export OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4608 OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=4608
  git init -q "$work/src"
  cd "$work/src"
  git fetch -q --depth=1 "$repo" "$sha"
  git checkout -q --detach FETCH_HEAD
  [[ $(git rev-parse HEAD) == "$sha" ]]
  git archive "$sha" | gzip -n > "$work/source.tar.gz"
  pnpm install --frozen-lockfile
  node scripts/package-openclaw-for-docker.mjs --allow-unreleased-changelog \
    --bundle-plugin codex --bundle-plugin slack --output-dir "$work/package" --output-name openclaw-current.tgz
  git diff --quiet HEAD --
  source scripts/lib/docker-e2e-package.sh
  ctx=$(docker_e2e_prepare_package_context "$work/package/openclaw-current.tgz")
  mv "$ctx" "$work/package-context"
fi
archive_hash=$(shasum -a 256 "$work/source.tar.gz" | cut -d ' ' -f1)
pkg_hash=$(shasum -a 256 "$work/package-context/openclaw-current.tgz" | cut -d ' ' -f1)

if [[ -n $resume_flag ]]; then
  # Never overwrite existing helpers, receipts or inputs during reconciliation.
  repair=$(mktemp -d "$work/resume.XXXXXX")
  for helper in build_candidate.py release_inputs.py activate_image.py; do
    git -C "$repo" show "$tooling:deploy/gcp-vm/$helper" > "$repair/$helper"
  done
  stage="$upload/$(basename "$repair")"
  remote "umask 077 && mkdir '$stage' && ln -s ../package-context '$stage/package-context' && ln -s ../source.tar.gz '$stage/source.tar.gz'"
  gcloud compute scp "${location[@]}" --scp-flag=-4 "$repair/"*.py "$vm:$stage/"
else
  stage="$upload"
  remote "umask 077 && mkdir '$upload'"
  gcloud compute scp "${location[@]}" --scp-flag=-4 --recurse "$work/source.tar.gz" \
    "$work/package-context" "$work/helpers/build_candidate.py" "$work/helpers/activate_image.py" \
    "$work/helpers/release_inputs.py" "$vm:$upload/"
fi
remote "sudo flock -n /opt/livex-openclaw/deploy.lock sh -ec 'python3 -E $stage/build_candidate.py $sha $old $archive_hash $pkg_hash $resume_flag && python3 -E $stage/activate_image.py $sha $old'"

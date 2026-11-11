#!/usr/bin/env bash
# Runs on the test VM as root (via deploy.sh, under /opt/livex-openclaw-test/deploy.lock):
#   bash releases/<sha>/livex-native/deploy/remote.sh FULL_SHA
# Builds the image, snapshots state, applies config in the new image, cuts over,
# gates on /readyz, and rolls back (image + config + state) on failure. Never
# prints secrets: no `set -x`, and runtime.env is only handed to docker compose.
#
# Test knobs (defaults are the real values): LIVEX_ROOT, LIVEX_HEALTH_TIMEOUT,
# LIVEX_HEALTH_INTERVAL.
set -euo pipefail
umask 077

sha=${1:-}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "Usage: remote.sh FULL_COMMIT_SHA" >&2; exit 2; }

# Same allowlist as deploy.sh: a test VM, or livex-openclaw-dev only in the explicit
# side-by-side mode (LIVEX_ON_DEV_VM=1). This script never touches /opt/livex-openclaw.
on_dev=0
[[ ${LIVEX_ON_DEV_VM:-0} == 1 ]] && on_dev=1
dev_container=livex-openclaw-dev-gateway-1
if ((on_dev)); then
  [[ $(hostname) == livex-openclaw-dev ]] \
    || { echo "Refusing: LIVEX_ON_DEV_VM=1 but host is '$(hostname)'." >&2; exit 1; }
else
  [[ $(hostname) =~ ^livex-openclaw-test(-[a-z0-9-]+)?$ ]] \
    || { echo "Refusing to run on host '$(hostname)': not a livex-openclaw-test VM." >&2; exit 1; }
fi

root=${LIVEX_ROOT:-/opt/livex-openclaw-test}
project=livex-openclaw-test
release=$root/releases/$sha
deploy=$release/livex-native/deploy
state=$root/state
runtime_env=$root/runtime.env
# /readyz also consults channel accounts, so a bad Slack config fails the deploy.
health_url=http://127.0.0.1:18789/readyz
health_timeout=${LIVEX_HEALTH_TIMEOUT:-120}
health_interval=${LIVEX_HEALTH_INTERVAL:-3}
new_image=livex-openclaw-test:$sha
snapshot=$release/state.before.tgz

[[ -f $deploy/compose.yaml && -f $deploy/Dockerfile && -f $deploy/versions.env ]] \
  || { echo "Release $sha is not unpacked at $release." >&2; exit 1; }
[[ -d $state && -d $root/gcloud && -r $runtime_env ]] \
  || { echo "VM is not set up: need $state, $root/gcloud and a readable $runtime_env (README)." >&2; exit 1; }

# versions.env is parsed, not sourced. Every pin must be real (no placeholders).
version() { sed -n "s/^$1=//p" "$deploy/versions.env" | head -n1; }
openclaw_image=$(version OPENCLAW_IMAGE)
sdk_image=$(version SDK_IMAGE)
slack_spec=$(version SLACK_PLUGIN_SPEC)
slack_integrity=$(version SLACK_PLUGIN_INTEGRITY)
digest_re='^[a-z0-9./-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$'
[[ $openclaw_image =~ $digest_re && $sdk_image =~ $digest_re \
  && $slack_spec =~ ^@openclaw/slack@[0-9]{4}\.[0-9]+\.[0-9]+$ \
  && $slack_integrity =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]] || {
  echo "versions.env must pin real image digests, an exact Slack plugin version and its sha512 integrity (placeholder or malformed value found)." >&2
  exit 1
}

# Compose reads these from the environment; runtime.env only feeds the containers.
dc() {
  local image=$1
  shift
  OPENCLAW_IMAGE=$image RUNTIME_ENV_FILE=$runtime_env STATE_DIR=$state SDK_STATE_DIR=$root/gcloud \
    docker compose --project-name "$project" -f "$deploy/compose.yaml" "$@"
}

wait_ready() {
  local waited=0
  while ((waited < health_timeout)); do
    if curl -fsS --max-time 3 "$health_url" >/dev/null 2>&1; then return 0; fi
    sleep "$health_interval"
    waited=$((waited + health_interval))
  done
  return 1
}

# Replace the state directory with the snapshot via rename. This runs from the
# EXIT trap inside an `if`, where bash disables errexit, so every step checks its
# own status and returns non-zero. The failed state is never deleted: it is kept
# as $failed for forensics. Returns 0 only when the snapshot is in place.
failed=""
restore_state() {
  local tmp=$root/state.restore.$$
  failed=$root/state.failed.$sha.$(date +%Y%m%d%H%M%S)
  rm -rf "$tmp" || return 1
  mkdir "$tmp" || return 1
  # A corrupt snapshot fails here with the original (failed-apply) state untouched.
  tar -C "$tmp" -xpzf "$snapshot" || { rm -rf "$tmp"; return 1; }
  [[ -d $tmp/state ]] || { rm -rf "$tmp"; return 1; }
  mv "$state" "$failed" || { rm -rf "$tmp"; return 1; }
  if ! mv "$tmp/state" "$state"; then
    mv "$failed" "$state" || return 1 # failed state is then still at $failed
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp" || true
  return 0
}

previous=""
[[ -s $root/current ]] && previous=$(<"$root/current")
dev_stopped=0 # set when this run stopped PR #1's Gateway (side-by-side mode)
have_snapshot=0
restored=1
phase=prepare # prepare -> stopped (old gateway down) -> done

on_exit() {
  local rc=$?
  trap - EXIT
  if ((rc == 0)); then exit 0; fi
  echo "DEPLOY FAILED (exit $rc) during phase: $phase" >&2
  if [[ $phase == stopped ]]; then
    # Always stop the NEW gateway first, so nothing writes to state or recreates a
    # missing bind-mount source while it is swapped. `stop` leaves the
    # unless-stopped container down, so docker cannot restart it in the window.
    dc "$new_image" stop gateway >&2 || echo "Could not stop the new gateway." >&2
    restored=1
    if ((have_snapshot)); then
      echo "Restoring state snapshot (config, workspaces, plugins, SQLite)" >&2
      if restore_state >&2; then
        [[ -z $failed ]] || { echo "Failed state kept at $failed" >&2; chmod 0700 "$failed" 2>/dev/null || true; }
      else
        restored=0
        echo "STATE RESTORE FAILED. The gateway is left STOPPED; no previous image was started on broken state." >&2
        echo "  snapshot: $snapshot" >&2
        echo "  state dir: $state (failed-apply state if the snapshot would not extract)" >&2
        [[ ! -d ${failed:-/nonexistent} ]] || echo "  moved-aside failed state: $failed" >&2
        echo "  Fix by hand: tar -tzf the snapshot, then restore it over $state, then start the previous image (README, Rollback)." >&2
      fi
    fi
    local test_ready=0
    if ((!restored)); then
      :
    elif [[ -n $previous ]]; then
      echo "Rolling back to $previous" >&2
      if dc "$previous" up -d --pull never gateway >&2 && wait_ready; then
        test_ready=1
        echo "Rollback ready on $previous; $sha was NOT activated." >&2
      else
        echo "ROLLBACK ALSO FAILED. Inspect: sudo docker logs livex-openclaw-test-gateway-1" >&2
      fi
    else
      echo "First deploy failed: gateway left stopped (state unchanged or restored)." >&2
    fi
    # Side-by-side mode: if this run stopped PR #1 and no livex-native Gateway is
    # ready now, bring PR #1 back so Slack is not left without a bot. Stop ours first
    # so the two never share the Slack app.
    if ((dev_stopped && !test_ready)); then
      dc "$new_image" stop gateway >/dev/null 2>&1 || true
      if docker start "$dev_container" >/dev/null; then
        echo "PR #1's Gateway ($dev_container) was started again." >&2
      else
        echo "Could not start PR #1's Gateway: sudo docker start $dev_container" >&2
      fi
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT

echo "== disk before build"
df -h "$root" || true
echo "== build $new_image"
docker build \
  --build-arg "OPENCLAW_IMAGE=$openclaw_image" \
  --build-arg "SDK_IMAGE=$sdk_image" \
  --build-arg "SLACK_PLUGIN_SPEC=$slack_spec" \
  --build-arg "SLACK_PLUGIN_INTEGRITY=$slack_integrity" \
  --build-arg "SOURCE_SHA=$sha" \
  -f "$deploy/Dockerfile" -t "$new_image" "$release"

echo "== stop gateway, snapshot state, apply config"
phase=stopped
dc "$new_image" stop gateway
# Snapshot after the stop so SQLite files are quiescent. Only this directory
# changes on apply: the gcloud directory holds gcloud's own caches (the attached
# service account keeps no credentials there) and is not touched by apply.
tar -C "$root" -czf "$snapshot" state
chmod 0600 "$snapshot"
# A bad snapshot must stop the deploy before apply touches anything.
tar -tzf "$snapshot" >/dev/null || { echo "State snapshot failed verification; state untouched." >&2; exit 1; }
have_snapshot=1
dc "$new_image" run --rm --no-deps -T \
  -e "LIVEX_RELEASE_SHA=$sha" -e "SLACK_PLUGIN_SPEC=$slack_spec" \
  --entrypoint node cli /opt/livex-native/deploy/apply.mjs
dc "$new_image" run --rm --no-deps -T cli config validate

if ((on_dev)) && [[ $(docker inspect --format '{{.State.Running}}' "$dev_container" 2>/dev/null) == true ]]; then
  # One Slack app, one active Gateway: stop PR #1 only now, after the new image is
  # built and its config validated. `stop` keeps its unless-stopped container down.
  echo "== stop PR #1 Gateway ($dev_container)"
  docker stop "$dev_container" >/dev/null
  dev_stopped=1
fi
echo "== start $new_image"
dc "$new_image" up -d --pull never gateway
wait_ready || { echo "$health_url not ready within ${health_timeout}s." >&2; exit 1; }

# Activate: record previous/current only after a ready start.
write_atomic() {
  printf '%s\n' "$2" >"$1.tmp.$$" || return 1
  mv "$1.tmp.$$" "$1" || return 1
}
if [[ -n $previous ]]; then write_atomic "$root/previous" "$previous" || exit 1; fi
write_atomic "$root/current" "$new_image" || exit 1
# Stable path for operator compose commands (README); the env file carries the
# interpolation values compose.yaml needs.
ln -sfn "$release" "$root/current-release"
cat >"$root/compose.env.tmp.$$" <<EOF
OPENCLAW_IMAGE=$new_image
RUNTIME_ENV_FILE=$runtime_env
STATE_DIR=$state
SDK_STATE_DIR=$root/gcloud
EOF
mv "$root/compose.env.tmp.$$" "$root/compose.env"
phase=done

# Keep the current and previous images and the newest releases; drop the rest.
for image in $(docker image ls --format '{{.Repository}}:{{.Tag}}' "livex-openclaw-test" 2>/dev/null); do
  [[ $image == "$new_image" || $image == "$previous" ]] || docker image rm "$image" >/dev/null 2>&1 || true
done
keep=3
count=0
for dir in $(ls -1t "$root/releases" 2>/dev/null); do
  count=$((count + 1))
  [[ $dir == "$sha" || $previous == *":$dir" || $count -le $keep ]] || rm -rf "${root:?}/releases/$dir"
done
# Best-effort housekeeping: old build cache (not on the shared dev VM, where the
# cache also serves PR #1's builds), and failed-state dirs beyond the newest two.
((on_dev)) || docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
for dir in $(ls -1dt "$root"/state.failed.* 2>/dev/null | tail -n +3); do rm -rf "$dir" || true; done
echo "== disk after deploy"
df -h "$root" || true
echo "DEPLOYED $sha (image $new_image, previous ${previous:-none})"

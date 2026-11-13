#!/usr/bin/env bash
# Runs as root under the selected test or staging root's deploy.lock (via deploy.sh):
#   bash releases/<sha>/livex-native/deploy/remote.sh FULL_SHA
# Builds the image, snapshots state, applies config in the new image, cuts over,
# gates on /readyz, and rolls back (image + config + state) on failure. Never
# prints secrets: no `set -x`, and runtime.env is only handed to docker compose.
#
# Test knobs (defaults are the real values): LIVEX_ROOT, LIVEX_HEALTH_TIMEOUT,
# LIVEX_HEALTH_INTERVAL, LIVEX_MIN_FREE_GIB (free-space floor before a build;
# default 5, whole GiB, 0 turns the check off).
set -euo pipefail
umask 077

sha=${1:-}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "Usage: remote.sh FULL_COMMIT_SHA" >&2; exit 2; }

# DEV mode uses a separate Compose project and leaves the existing bot running.
on_dev=0
[[ ${LIVEX_ON_DEV_VM:-0} == 1 ]] && on_dev=1
if ((on_dev)); then
  [[ $(hostname) == livex-openclaw-dev ]] \
    || { echo "Refusing: LIVEX_ON_DEV_VM=1 but host is '$(hostname)'." >&2; exit 1; }
else
  [[ $(hostname) =~ ^livex-openclaw-test(-[a-z0-9-]+)?$ ]] \
    || { echo "Refusing to run on host '$(hostname)': not a livex-openclaw-test VM." >&2; exit 1; }
fi

project=livex-openclaw-test
default_timeout=120
if ((on_dev)); then
  project=livex-openclaw-stage
  default_timeout=300
fi
root=${LIVEX_ROOT:-/opt/$project}
release=$root/releases/$sha
deploy=$release/livex-native/deploy
state=$root/state
runtime_env=$root/runtime.env
health_url=http://127.0.0.1:18789/readyz
health_timeout=${LIVEX_HEALTH_TIMEOUT:-$default_timeout}
health_interval=${LIVEX_HEALTH_INTERVAL:-3}
[[ $health_timeout =~ ^[1-9][0-9]{0,3}$ && $health_interval =~ ^[1-9][0-9]{0,3}$ ]] \
  && ((health_timeout <= 3600 && health_interval <= 3600)) \
  || { echo "Readiness timeout and interval must be whole seconds from 1 to 3600." >&2; exit 2; }
min_free_gib=${LIVEX_MIN_FREE_GIB:-5}
[[ $min_free_gib =~ ^[0-9]{1,4}$ ]] \
  || { echo "LIVEX_MIN_FREE_GIB must be a whole number of GiB from 0 to 9999." >&2; exit 2; }
new_image=$project:$sha
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

# Gateway memory cap (compose.yaml mem_limit). OPT-IN: 0 means no cap. An
# operator sets it in the existing compose.env, which this script parses (never
# sources) and carries forward so it survives redeploys. README, "Memory and disk".
gateway_mem_limit=0
if [[ -r $root/compose.env ]]; then
  override=$(sed -n 's/^LIVEX_GATEWAY_MEM_LIMIT=//p' "$root/compose.env" | head -n1)
  if [[ -n $override ]]; then
    [[ $override =~ ^(0|[1-9][0-9]{0,5}[mg])$ ]] \
      || { echo "LIVEX_GATEWAY_MEM_LIMIT in $root/compose.env must be 0 (no cap) or look like 3g or 3072m." >&2; exit 2; }
    # A cap that is too low also breaks rollback, because the previous image is
    # restarted under the same cap. Refuse anything under 1 GiB.
    if [[ $override != 0 ]]; then
      mem_mib=$((10#${override%[mg]}))
      [[ $override == *g ]] && mem_mib=$((mem_mib * 1024))
      ((mem_mib >= 1024)) \
        || { echo "LIVEX_GATEWAY_MEM_LIMIT in $root/compose.env must be at least 1g (or 0 for no cap)." >&2; exit 2; }
    fi
    gateway_mem_limit=$override
  fi
fi

# Compose reads these from the environment; runtime.env only feeds the containers.
dc() {
  local image=$1
  shift
  OPENCLAW_IMAGE=$image RUNTIME_ENV_FILE=$runtime_env STATE_DIR=$state SDK_STATE_DIR=$root/gcloud \
    LIVEX_GATEWAY_MEM_LIMIT=$gateway_mem_limit \
    LIVEX_STAGE_ONLY=$on_dev docker compose --project-name "$project" -f "$deploy/compose.yaml" "$@"
}

wait_ready() {
  local image_id remaining probe_timeout deadline=$((SECONDS + health_timeout))
  image_id=$(docker image inspect --format '{{.Id}}' "$1") || return 1
  [[ -n $image_id ]] || return 1
  while ((SECONDS < deadline)); do
    # Check the named candidate's image as well as the loopback endpoint.
    if [[ $(docker inspect --format '{{if .State.Running}}{{.Image}}{{end}}' "$project-gateway-1" 2>/dev/null) == "$image_id" ]]; then
      remaining=$((deadline - SECONDS))
      ((remaining > 0)) || return 1
      probe_timeout=$((remaining < 3 ? remaining : 3))
      if curl -fsS --max-time "$probe_timeout" "$health_url" >/dev/null 2>&1; then return 0; fi
    fi
    remaining=$((deadline - SECONDS))
    if ((remaining > 0)); then
      sleep "$((remaining < health_interval ? remaining : health_interval))"
    fi
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

# Activation records. Staged as temporaries, then renamed with `current` last.
activating=0
saved_link=""
saved_prev_present=0
saved_prev=""
clean_activation_tmp() {
  rm -f "$root/previous.tmp.$$" "$root/current.tmp.$$" "$root/compose.env.tmp.$$" \
    "$root/compose.env.saved.$$" "$root/current-release.tmp.$$" || true
}
# Re-point the activation records at what they named before the renames began.
restore_records() {
  local rc=0
  if [[ -n $saved_link ]]; then
    ln -sfn "$saved_link" "$root/current-release.tmp.$$" \
      && mv -T "$root/current-release.tmp.$$" "$root/current-release" || rc=1
  else
    rm -f "$root/current-release" || rc=1
  fi
  if [[ -f $root/compose.env.saved.$$ ]]; then
    mv "$root/compose.env.saved.$$" "$root/compose.env" || rc=1
  else
    rm -f "$root/compose.env" || rc=1
  fi
  if ((saved_prev_present)); then
    printf '%s\n' "$saved_prev" >"$root/previous.tmp.$$" && mv "$root/previous.tmp.$$" "$root/previous" || rc=1
  else
    rm -f "$root/previous" || rc=1
  fi
  return "$rc"
}

previous=""
[[ -s $root/current ]] && previous=$(<"$root/current")
# A same-SHA deploy needs its own attempt snapshot and must preserve the
# previous distinct release and its pre-activation snapshot.
if [[ $previous == "$new_image" ]]; then snapshot=$release/state.retry.$$.tgz; fi
was_running=0 # our gateway was running before this deploy (rollback only restarts it then)
have_snapshot=0
restored=1
phase=prepare # prepare -> stopped (old gateway down) -> done

on_exit() {
  local rc=$?
  trap - EXIT
  if ((rc == 0)); then exit 0; fi
  echo "DEPLOY FAILED (exit $rc) during phase: $phase" >&2
  if [[ $phase == stopped ]]; then
    # Interrupted activation: put the records back first, so they stay mutually
    # consistent with the image the rollback starts. Every step is status-checked.
    if ((activating)); then restore_records >&2 || echo "WARNING: could not fully restore activation records; check $root/{current,previous,compose.env,current-release}." >&2; fi
    clean_activation_tmp
    # Always stop the NEW gateway first, so nothing writes to state or recreates a
    # missing bind-mount source while it is swapped. `stop` leaves the
    # unless-stopped container down, so docker cannot restart it in the window.
    if ! dc "$new_image" stop gateway >&2; then
      echo "Could not stop the candidate. State snapshot left at $snapshot." >&2
      exit "$rc"
    fi
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
    if ((!restored)); then
      :
    elif [[ -n $previous ]] && ((!was_running)); then
      echo "Previous release $previous was not running before this deploy; left stopped." >&2
    elif [[ -n $previous ]]; then
      echo "Rolling back to $previous" >&2
      if dc "$previous" up -d --pull never gateway >&2 && wait_ready "$previous"; then
        echo "Rollback ready on $previous; $sha was NOT activated." >&2
      else
        echo "ROLLBACK ALSO FAILED. Inspect: sudo docker logs $project-gateway-1" >&2
      fi
    else
      echo "First deploy failed: gateway left stopped (state unchanged or restored)." >&2
    fi
    if ((restored)) && [[ $previous == "$new_image" ]]; then rm -f "$snapshot" || true; fi
  fi
  exit "$rc"
}
trap on_exit EXIT

# Free-space floor. Runs before the build and before anything is stopped, so a
# refusal leaves the running Gateway untouched. Checks the filesystem holding the
# deploy root and, when `docker info` answers, Docker's data root (where the
# build and image layers land). An unreadable path or missing docker is skipped.
free_kib() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }
if ((10#$min_free_gib > 0)); then
  need_kib=$((10#$min_free_gib * 1024 * 1024))
  docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  for path in "$root" "$docker_root"; do
    [[ -n $path && -d $path ]] || continue
    have_kib=$(free_kib "$path")
    [[ $have_kib =~ ^[0-9]+$ ]] || continue
    if ((have_kib < need_kib)); then
      echo "Refusing to deploy: $path has $((have_kib / 1024 / 1024)) GiB free, below the ${min_free_gib} GiB floor (LIVEX_MIN_FREE_GIB). The running Gateway was not touched." >&2
      exit 1
    fi
  done
fi

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
[[ $(docker inspect --format '{{.State.Running}}' "$project-gateway-1" 2>/dev/null) == true ]] && was_running=1
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
  -e "LIVEX_RELEASE_SHA=$sha" -e "SLACK_PLUGIN_SPEC=$slack_spec" -e "LIVEX_STAGE_ONLY=$on_dev" \
  --entrypoint node cli /opt/livex-native/deploy/apply.mjs
dc "$new_image" run --rm --no-deps -T cli config validate

echo "== start $new_image"
dc "$new_image" up -d --pull never gateway
wait_ready "$new_image" || { echo "$project-gateway-1 not ready at $health_url within ${health_timeout}s." >&2; exit 1; }

# Activate only after a ready start. Phase stays `stopped` until the end, so a
# failure rolls back. Stage ALL temporaries first (any failure here changes no
# record), save the old records, then rename with `current` last, the commit
# point. If a rename fails, on_exit restores the saved records. Each step checks
# its own status: errexit does not reliably fire in this flow.
stage() { printf '%s\n' "$2" >"$1.tmp.$$" || exit 1; }
[[ -z $previous || $previous == "$new_image" ]] || stage "$root/previous" "$previous"
stage "$root/current" "$new_image"
# Stable path for operator compose commands (README); the env file carries the
# interpolation values compose.yaml needs.
ln -sfn "$release" "$root/current-release.tmp.$$" || exit 1
cat >"$root/compose.env.tmp.$$" <<EOF || exit 1
OPENCLAW_IMAGE=$new_image
RUNTIME_ENV_FILE=$runtime_env
STATE_DIR=$state
SDK_STATE_DIR=$root/gcloud
LIVEX_STAGE_ONLY=$on_dev
LIVEX_GATEWAY_MEM_LIMIT=$gateway_mem_limit
EOF
saved_link=$(readlink "$root/current-release" 2>/dev/null || true)
if [[ -f $root/compose.env ]]; then cp -p "$root/compose.env" "$root/compose.env.saved.$$" || exit 1; fi
if [[ -s $root/previous ]]; then saved_prev_present=1; saved_prev=$(<"$root/previous"); fi
activating=1
mv -T "$root/current-release.tmp.$$" "$root/current-release" || exit 1
mv "$root/compose.env.tmp.$$" "$root/compose.env" || exit 1
if [[ -f $root/previous.tmp.$$ ]]; then mv "$root/previous.tmp.$$" "$root/previous" || exit 1; fi
mv "$root/current.tmp.$$" "$root/current" || exit 1
activating=0
clean_activation_tmp
phase=done
if [[ $previous == "$new_image" ]]; then
  rm -f "$snapshot" || true
  previous=""
  [[ ! -s $root/previous ]] || previous=$(<"$root/previous")
fi

# Keep the current and previous images and the newest releases; drop the rest.
for image in $(docker image ls --format '{{.Repository}}:{{.Tag}}' "$project" 2>/dev/null); do
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
if ((on_dev)); then
  echo "STAGED $sha (image $new_image, previous ${previous:-none}, channel startup disabled)"
else
  echo "DEPLOYED $sha (image $new_image, previous ${previous:-none})"
fi

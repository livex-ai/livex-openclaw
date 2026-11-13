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

# DEV staging mode uses a separate Compose project and leaves the existing bot
# running. LIVE mode (LIVEX_DEV_LIVE=1) is the Slack-serving native Gateway on the
# DEV VM: its own project, root and host port, with channels ON.
on_dev=0
[[ ${LIVEX_ON_DEV_VM:-0} == 1 ]] && on_dev=1
live=0
[[ ${LIVEX_DEV_LIVE:-0} == 1 ]] && live=1
unmanaged=${LIVEX_UNMANAGED_AGENTS:-}
if [[ -n $unmanaged ]]; then
  ((live)) || { echo "Refusing: LIVEX_UNMANAGED_AGENTS only applies with LIVEX_DEV_LIVE=1." >&2; exit 1; }
  [[ $unmanaged =~ ^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*){0,4}$ ]] \
    || { echo "Refusing: LIVEX_UNMANAGED_AGENTS must be 1 to 5 comma-separated agent ids like oncall,other." >&2; exit 1; }
fi
if ((live && on_dev)); then
  echo "Refusing: LIVEX_DEV_LIVE=1 cannot be combined with LIVEX_ON_DEV_VM=1." >&2
  exit 1
fi
if ((live)); then
  [[ $(hostname) == livex-openclaw-dev ]] \
    || { echo "Refusing: LIVEX_DEV_LIVE=1 but host is '$(hostname)'." >&2; exit 1; }
elif ((on_dev)); then
  [[ $(hostname) == livex-openclaw-dev ]] \
    || { echo "Refusing: LIVEX_ON_DEV_VM=1 but host is '$(hostname)'." >&2; exit 1; }
else
  [[ $(hostname) =~ ^livex-openclaw-test(-[a-z0-9-]+)?$ ]] \
    || { echo "Refusing to run on host '$(hostname)': not a livex-openclaw-test VM." >&2; exit 1; }
fi

project=livex-openclaw-test
default_timeout=120
host_port=18789
if ((on_dev)); then
  project=livex-openclaw-stage
  default_timeout=300
elif ((live)); then
  project=livex-openclaw-native-dev
  default_timeout=300
  host_port=18790
fi
root=${LIVEX_ROOT:-/opt/$project}
if ((live)); then
  # LIVEX_ROOT is a test knob; never let it point at another install's root.
  case $root in
    /opt/livex-openclaw-stage | /opt/livex-openclaw-test | /opt/livex-openclaw-dev | /opt/livex-openclaw)
      echo "Refusing: live mode must not use $root." >&2; exit 1 ;;
  esac
fi
release=$root/releases/$sha
deploy=$release/livex-native/deploy
state=$root/state
runtime_env=$root/runtime.env
health_url=http://127.0.0.1:$host_port/readyz
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
# LIVE mode only: a hand-made install (no current-release link, compose.env whose
# STATE_DIR is some other directory) is migrated once, see plan_adoption below.
adopting=0
legacy_state=""
if ((live)); then
  grep -Eq '^SLACK_BOT_TOKEN=.' "$runtime_env" 2>/dev/null && grep -Eq '^SLACK_APP_TOKEN=.' "$runtime_env" \
    || { echo "Refusing: live mode serves Slack, but $runtime_env lacks SLACK_BOT_TOKEN and/or SLACK_APP_TOKEN." >&2; exit 1; }
  if [[ ! -L $root/current-release && ! -e $root/current-release && -f $root/compose.env ]]; then
    legacy_state=$(sed -n 's/^STATE_DIR=//p' "$root/compose.env" | head -n1)
    [[ -z $legacy_state || $legacy_state == "$state" ]] || adopting=1
  fi
fi
[[ -d $root/gcloud && -r $runtime_env ]] && { ((adopting)) || [[ -d $state ]]; } \
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
  OPENCLAW_IMAGE=$image RUNTIME_ENV_FILE=$runtime_env STATE_DIR=${state_mount:-$state} SDK_STATE_DIR=$root/gcloud \
    LIVEX_GATEWAY_MEM_LIMIT=$gateway_mem_limit LIVEX_HOST_PORT=$host_port \
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

free_kib() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }

# One-time adoption of the hand-made live layout (live mode only). The old
# install keeps its compose.yaml, compose.env, records and release-*/state dirs at
# the root; none of them is modified or deleted here. Everything adoption adds is
# $root/state (a COPY of the state the running Gateway uses, made while it is
# stopped) and $root/adopt-backup.<ts>/. Failure undoes exactly that and restarts
# the original image from the original compose.yaml and a pristine copy of the
# original compose.env.
adopt_ts=$(date +%Y%m%d%H%M%S)
adopt_backup=$root/adopt-backup.$adopt_ts
adopt_aside=$root/state.pre-adopt.$adopt_ts
adopt_tag=""           # pre-adopt tag on the legacy image: the rollback target, immune to a same-sha rebuild
adopt_tag_made=0
adopt_keep=0
records_ok=1
rollback_ok=1
adopt_aside_made=0
adopt_state_created=0
adopt_backup_made=0
legacy_image=""
legacy_compose() {
  docker compose --project-name "$project" -f "$root/compose.yaml" --env-file "$root/compose.env" "$@"
}
plan_adoption() {
  local cur prev have_kib need_kib
  [[ -f $root/compose.yaml && ! -L $root/compose.yaml ]] \
    || { echo "Adoption refused: $root/compose.yaml is missing, so the original gateway could not be restored." >&2; return 1; }
  [[ $legacy_state == "$root"/* && ${legacy_state#"$root"/} =~ ^release-[A-Za-z0-9._-]+/state$ && ! -L $legacy_state && -d $legacy_state ]] \
    || { echo "Adoption refused: STATE_DIR '$legacy_state' in $root/compose.env is not a real $root/release-*/state directory." >&2; return 1; }
  legacy_image=$(sed -n 's/^OPENCLAW_IMAGE=//p' "$root/compose.env" | head -n1)
  [[ $legacy_image =~ ^$project:[A-Za-z0-9._-]+$ ]] \
    || { echo "Adoption refused: OPENCLAW_IMAGE '$legacy_image' in $root/compose.env is not a $project image." >&2; return 1; }
  docker image inspect --format '{{.Id}}' "$legacy_image" >/dev/null 2>&1 \
    || { echo "Adoption refused: image $legacy_image is not present, so rollback could not restart it." >&2; return 1; }
  cur=""
  [[ -s $root/current ]] && cur=$(<"$root/current")
  [[ -z $cur || $cur =~ ^[0-9a-f]{40}$ || $cur == "$legacy_image" ]] \
    || { echo "Adoption refused: unrecognized current record." >&2; return 1; }
  # Prove the old install is what we think it is BEFORE anything is stopped: its
  # compose files render, define `gateway`, and the running container was created
  # from $root/compose.yaml and publishes 127.0.0.1:$host_port.
  local published label services
  legacy_compose config -q >/dev/null 2>&1 \
    || { echo "Adoption refused: 'docker compose config' fails for $root/compose.yaml with $root/compose.env." >&2; return 1; }
  services=$(legacy_compose config --services 2>/dev/null || true) # not a pipe: grep -q would SIGPIPE it under pipefail
  grep -qx gateway <<<"$services" \
    || { echo "Adoption refused: $root/compose.yaml defines no 'gateway' service." >&2; return 1; }
  [[ $(docker inspect --format '{{.State.Running}}' "$project-gateway-1" 2>/dev/null) == true ]] \
    || { echo "Adoption refused: container $project-gateway-1 is not running, so it is not the live Gateway." >&2; return 1; }
  label=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$project-gateway-1" 2>/dev/null)
  [[ $label == "$root/compose.yaml" ]] \
    || { echo "Adoption refused: $project-gateway-1 was created from '$label', not $root/compose.yaml." >&2; return 1; }
  # `compose port` reports the running container's real binding.
  published=$(legacy_compose port gateway 18789 2>/dev/null || true)
  [[ $published == "127.0.0.1:$host_port" ]] \
    || { echo "Adoption refused: gateway publishes '${published:-nothing}' for 18789, expected 127.0.0.1:$host_port." >&2; return 1; }
  if [[ -L $state ]] || { [[ -e $state ]] && [[ ! -d $state ]]; }; then
    echo "Adoption refused: $state is not a plain directory." >&2; return 1
  fi
  [[ ! -e $adopt_aside && ! -e $adopt_backup ]] \
    || { echo "Adoption refused: $adopt_aside or $adopt_backup already exists (retry in a second)." >&2; return 1; }
  # The copy needs room next to the original (free-space floor applies on top).
  need_kib=$(du -sk "$legacy_state" 2>/dev/null | awk '{ print $1 }')
  have_kib=$(free_kib "$root")
  if [[ $need_kib =~ ^[0-9]+$ && $have_kib =~ ^[0-9]+$ ]] && ((have_kib < need_kib + 10#$min_free_gib * 1024 * 1024)); then
    echo "Adoption refused: copying $legacy_state needs $((need_kib / 1024)) MiB plus the ${min_free_gib} GiB floor; $root has $((have_kib / 1024)) MiB free." >&2
    return 1
  fi
  # A rebuild of the same sha would move the legacy tag; rollback must not depend on it.
  adopt_tag=$project:pre-adopt-$adopt_ts
  docker tag "$legacy_image" "$adopt_tag" \
    || { echo "Adoption refused: could not tag $legacy_image as $adopt_tag." >&2; return 1; }
  adopt_tag_made=1
  echo "== adoption plan: copy $legacy_state -> $state; convert records to $project:<sha>; keep every legacy release-* dir, record and $root/compose.yaml untouched"
  [[ ! -e $state ]] || echo "   existing $state will be moved aside to $adopt_aside (never deleted)"
  echo "   legacy image $legacy_image is pinned as $adopt_tag for rollback and becomes the new previous"
}
# Runs with the old gateway stopped. Every step is status-checked (EXIT-trap use).
adopt_state() {
  local f
  mkdir "$adopt_backup" || return 1
  adopt_backup_made=1
  for f in compose.env current previous prepared; do
    if [[ -e $root/$f ]]; then cp -p "$root/$f" "$adopt_backup/$f" || return 1; fi
  done
  if [[ -e $state ]]; then
    mv "$state" "$adopt_aside" || return 1
    adopt_aside_made=1
  fi
  adopt_state_created=1
  cp -a "$legacy_state" "$state" || return 1
  # Names only: cp -a's exit status vouches for owner, mode and content, and the
  # GNU/BSD stat and find -printf flags differ, so a portable attribute compare is
  # not worth a second code path. This catches a truncated or partial tree.
  cmp -s <(cd "$legacy_state" && find . | LC_ALL=C sort) <(cd "$state" && find . | LC_ALL=C sort) || return 1
  return 0
}
# Remove our copy and put any moved-aside directory back. Returns 0 only when
# $state is exactly what it was before adoption started.
undo_adoption() {
  local rc=0
  if ((adopt_state_created)); then
    rm -rf "${state:?}" || rc=1
    adopt_state_created=0
  fi
  if ((adopt_aside_made)); then
    if [[ ! -e $state ]] && mv "$adopt_aside" "$state"; then adopt_aside_made=0; else rc=1; fi
  fi
  return "$rc"
}
# Start the gateway that was running before this deploy. In adoption that is the
# pinned pre-adopt tag from the ORIGINAL compose.yaml. The env file is the root
# compose.env (original unless restoring it failed, then the backup copy); an
# exported OPENCLAW_IMAGE overrides its image line.
start_previous() {
  local envf=$root/compose.env
  if ((adopting)); then
    if [[ $(sed -n 's/^STATE_DIR=//p' "$envf" 2>/dev/null | head -n1) != "$legacy_state" && -f $adopt_backup/compose.env ]]; then
      envf=$adopt_backup/compose.env
    fi
    OPENCLAW_IMAGE=$1 docker compose --project-name "$project" -f "$root/compose.yaml" --env-file "$envf" up -d --pull never gateway
  else
    dc "$1" up -d --pull never gateway
  fi
}

previous=""
[[ -s $root/current ]] && previous=$(<"$root/current")
if ((adopting)); then
  plan_adoption || { rc=$?; ((!adopt_tag_made)) || docker image rm "$adopt_tag" >/dev/null 2>&1 || true; exit "$rc"; }
  previous=$adopt_tag
elif ((live)) && [[ -n $previous && ! $previous =~ ^$project:[0-9a-f]{40}$ ]]; then
  echo "Refusing: unrecognized current record '$previous' in $root/current (expected $project:<sha>)." >&2
  exit 1
fi
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
    if ((activating)); then restore_records >&2 || { records_ok=0; echo "WARNING: could not fully restore activation records; check $root/{current,previous,compose.env,current-release}." >&2; }; fi
    clean_activation_tmp
    # Always stop the NEW gateway first, so nothing writes to state or recreates a
    # missing bind-mount source while it is swapped. `stop` leaves the
    # unless-stopped container down, so docker cannot restart it in the window.
    if ! dc "$new_image" stop gateway >&2; then
      echo "Could not stop the candidate. State snapshot left at $snapshot." >&2
      exit "$rc"
    fi
    restored=1
    if ((adopting)); then
      # The legacy state dir was only ever copied, never written: put $state back
      # as it was and restart the original gateway from the original files.
      echo "Undoing adoption (removing the copied $state, restoring any moved-aside one)" >&2
      if ! undo_adoption >&2; then
        restored=0
        echo "ADOPTION UNDO FAILED. The gateway is left STOPPED. The original state is untouched at $legacy_state;" >&2
        echo "  original records are in $adopt_backup; a moved-aside state dir (if any) is $adopt_aside." >&2
      fi
    elif ((have_snapshot)); then
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
      # A same-sha rebuild moved the legacy tag; put it back on the original image.
      if ((adopting)); then docker tag "$adopt_tag" "$legacy_image" >&2 || echo "WARNING: could not restore tag $legacy_image" >&2; fi
      if start_previous "$previous" >&2 && wait_ready "$previous"; then
        echo "Rollback ready on $previous; $sha was NOT activated." >&2
      else
        rollback_ok=0
        echo "ROLLBACK ALSO FAILED. Inspect: sudo docker logs $project-gateway-1" >&2
      fi
    else
      echo "First deploy failed: gateway left stopped (state unchanged or restored)." >&2
    fi
    if ((restored)) && [[ $previous == "$new_image" ]]; then rm -f "$snapshot" || true; fi
    # The backup and the pin are the only pristine copies of the original records
    # and image: drop them only when everything was restored AND the original
    # gateway is back. Otherwise keep both and say how to finish by hand.
    if ((adopting && !(restored && records_ok && rollback_ok))); then
      adopt_keep=1
      echo "KEPT for manual recovery: $adopt_backup (original compose.env, current, previous, prepared) and image tag $adopt_tag (original image)." >&2
      echo "  Restore records: sudo cp -p $adopt_backup/compose.env $adopt_backup/current $adopt_backup/previous $adopt_backup/prepared $root/  (skip files that are absent)" >&2
      echo "  Start original:  sudo env OPENCLAW_IMAGE=$adopt_tag docker compose --project-name $project -f $root/compose.yaml --env-file $root/compose.env up -d --pull never gateway" >&2
    elif ((adopting && adopt_backup_made)); then
      rm -rf "${adopt_backup:?}" || true
    fi
  fi
  # Drop the pin only after a restored failure before activation (never after phase=done).
  if ((adopt_tag_made && !adopt_keep)) && [[ $phase != done ]]; then docker image rm "$adopt_tag" >/dev/null 2>&1 || true; fi
  exit "$rc"
}
trap on_exit EXIT

# Free-space floor. Runs before the build and before anything is stopped, so a
# refusal leaves the running Gateway untouched. Checks the filesystem holding the
# deploy root and, when `docker info` answers, Docker's data root (where the
# build and image layers land). An unreadable path or missing docker is skipped.
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

if ((live)); then
  # Read-only guard, before anything is stopped: refuse a release that would drop
  # a LiveX agent the live config already serves (apply.mjs, refuseDroppedLivexAgents).
  echo "== check the live agents and preview the config change (read-only)"
  state_mount=${legacy_state:-$state} dc "$new_image" run --rm --no-deps -T \
    -e LIVEX_LIVE_GUARD=1 -e LIVEX_CHECK_AGENTS_ONLY=1 -e "LIVEX_UNMANAGED_AGENTS=$unmanaged" -e "LIVEX_HOST_PORT=$host_port" \
    --entrypoint node cli /opt/livex-native/deploy/apply.mjs \
    || { echo "Refusing: the live config serves an agent this release does not ship (see above). The Gateway was not touched." >&2; exit 1; }
fi
echo "== stop gateway, snapshot state, apply config"
[[ $(docker inspect --format '{{.State.Running}}' "$project-gateway-1" 2>/dev/null) == true ]] && was_running=1
phase=stopped
dc "$new_image" stop gateway
if ((adopting)); then
  echo "== adopt: copy $legacy_state -> $state"
  adopt_state || { echo "Adoption copy failed; undoing it." >&2; exit 1; }
fi
# Snapshot after the stop so SQLite files are quiescent. Only this directory
# changes on apply: the gcloud directory holds gcloud's own caches (the attached
# service account keeps no credentials there) and is not touched by apply.
tar -C "$root" -czf "$snapshot" state
chmod 0600 "$snapshot"
# A bad snapshot must stop the deploy before apply touches anything.
tar -tzf "$snapshot" >/dev/null || { echo "State snapshot failed verification; state untouched." >&2; exit 1; }
have_snapshot=1
dc "$new_image" run --rm --no-deps -T \
  -e "LIVEX_RELEASE_SHA=$sha" -e "SLACK_PLUGIN_SPEC=$slack_spec" -e "LIVEX_STAGE_ONLY=$on_dev" -e "LIVEX_LIVE_GUARD=$live" -e "LIVEX_UNMANAGED_AGENTS=$unmanaged" -e "LIVEX_HOST_PORT=$host_port" \
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
LIVEX_HOST_PORT=$host_port
EOF
saved_link=$(readlink "$root/current-release" 2>/dev/null || true)
if [[ -f $root/compose.env ]]; then cp -p "$root/compose.env" "$root/compose.env.saved.$$" || exit 1; fi
if [[ -s $root/previous ]]; then saved_prev_present=1; saved_prev=$(<"$root/previous"); fi
activating=1
mv -T "$root/current-release.tmp.$$" "$root/current-release" || exit 1
mv "$root/compose.env.tmp.$$" "$root/compose.env" || exit 1
if [[ -f $root/previous.tmp.$$ ]]; then mv "$root/previous.tmp.$$" "$root/previous" || exit 1
fi
mv "$root/current.tmp.$$" "$root/current" || exit 1
activating=0
clean_activation_tmp
phase=done
# Activated: nothing below may turn this into a failed deploy (and on_exit would
# no longer roll back anyway), so housekeeping is strictly best-effort.
set +e
if [[ $previous == "$new_image" ]]; then
  rm -f "$snapshot" || true
  previous=""
  [[ ! -s $root/previous ]] || previous=$(<"$root/previous")
fi

# Keep the current and previous images and the newest releases; drop the rest.
for image in $(docker image ls --format '{{.Repository}}:{{.Tag}}' "$project" 2>/dev/null); do
  [[ $image == "$new_image" || $image == "$previous" || $image == "$adopt_tag" ]] || docker image rm "$image" >/dev/null 2>&1 || true
done
keep=3
count=0
for dir in $(ls -1t "$root/releases" 2>/dev/null); do
  count=$((count + 1))
  [[ $dir == "$sha" || $previous == *":$dir" || $count -le $keep ]] || rm -rf "${root:?}/releases/$dir" || true
done
# Best-effort housekeeping: old build cache (dedicated test VM only), and
# failed-state dirs beyond the newest two.
# Live mode: dangling images only (never tagged ones). No builder prune here: the
# VM's build cache also serves staging and other builds. The test VM prunes its own.
if ((live)); then docker image prune -f >/dev/null 2>&1 || true; fi
((on_dev || live)) || docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
for dir in $(ls -1dt "$root"/state.failed.* 2>/dev/null | tail -n +3); do rm -rf "$dir" || true; done
if ((live)); then
  # Legacy hand-made leftovers are NEVER deleted by a deploy: release-*/state is the
  # only pre-adoption copy of the live state (sessions, Codex sign-ins). List them
  # with sizes and print the exact command for the operator.
  if ((adopting && adopt_aside_made)); then rmdir "$adopt_aside" 2>/dev/null && adopt_aside_made=0 || true; fi
  legacy_dirs=()
  for dir in "$root"/release-*/ "$root"/state.pre-adopt.*/; do
    [[ -d $dir && ! -L ${dir%/} ]] && legacy_dirs+=("${dir%/}")
  done
  if ((${#legacy_dirs[@]})); then
    echo "== legacy leftovers (kept; they are the rollback anchor until a later deploy has succeeded)"
    du -sh "${legacy_dirs[@]}" 2>/dev/null || true
    printf 'Reclaim after a later deploy succeeded:  sudo rm -rf'
    printf ' %q' "${legacy_dirs[@]}"
    printf '\n'
  fi
fi
echo "== disk after deploy"
df -h "$root" || true
if ((adopting)); then
  echo "ADOPTED the hand-made install: state copied to $state, original files kept (backup of records: $adopt_backup)"
fi
if ((on_dev)); then
  echo "STAGED $sha (image $new_image, previous ${previous:-none}, channel startup disabled)"
elif ((live)); then
  echo "DEPLOYED $sha LIVE (image $new_image, previous ${previous:-none}, host port $host_port, Slack on)"
else
  echo "DEPLOYED $sha (image $new_image, previous ${previous:-none})"
fi

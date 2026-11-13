# Deploy livex-native

The default target is the dedicated `livex-openclaw-test` VM. It uses its own
Slack app and the official OpenClaw image. `LIVEX_ON_DEV_VM=1` stages a candidate
on the existing DEV VM for Gateway and Codex checks. `make deploy_dev` (below)
deploys the live, Slack-serving Gateway on that VM.

**What is and is not modified.** This repo changes no OpenClaw core source. The
image is the official one (digest-pinned) plus the Google Cloud CLI and
`livex-native`. There is one build-time patch to a plugin package:
`patch-slack-navigation.mjs` edits the official `@openclaw/slack` monitor bundle
so passive URL buttons are not enqueued as block actions (PR #34's guard). It
refuses to run unless the bundle's sha256 matches the verified
`@openclaw/slack@2026.10.5` file, so a version bump breaks the build until the
patch is re-verified against the new bundle (or removed if upstream has the fix).

## Stage on the existing DEV VM

The candidate uses `/opt/livex-openclaw-stage`, the `livex-openclaw-stage`
Compose project, and loopback port `18789`. The current DEV Gateway keeps
serving Slack on port `18791`.

- Bootstrap reads the GCP project, account, and authorized sender from DEV. It
  generates a separate Gateway token and leaves Slack credentials out of the
  staging environment.
- The candidate disables Slack in config and suppresses channel startup. It
  keeps the official entrypoint and traces startup, including Doctor. The
  staging readiness window defaults to 300 seconds.
- A failed staging attempt rolls back only the staging project and its state.
  Docker build-cache pruning stays off on DEV.

```bash
sha=$(git rev-parse HEAD)
LIVEX_ON_DEV_VM=1 LIVEX_TEST_IAP=0 LIVEX_HEALTH_TIMEOUT=300 \
  bash livex-native/deploy/deploy.sh "$sha"
```

Run from the reviewed PR checkout. Drop `LIVEX_TEST_IAP=0` if using IAP. The
deploy prints a device-code sign-in command for `debugger` and a local agent
command to check its reply. Use this direct SSH tunnel for the Control UI.

```bash
gcloud compute ssh livex-openclaw-dev --project=ai-mvp-dv --zone=us-central1-a \
  --ssh-flag=-4 -- -N -L 18789:127.0.0.1:18789
```

Use the staging Gateway token from `/opt/livex-openclaw-stage/runtime.env` in
the Control UI. Use the dedicated test VM and its own Slack app to verify
Slack replies and GCP tools through an authorized Slack turn.

Staging builds the image `livex-openclaw-stage:<sha>` (the dedicated VM builds
`livex-openclaw-test:<sha>`); the image name and Compose project are the same
string.

## Deploy the live DEV Gateway: `make deploy_dev`

The Slack-serving native Gateway on `livex-openclaw-dev` runs from
`/opt/livex-openclaw-native-dev` as Compose project `livex-openclaw-native-dev`,
published on `127.0.0.1:18790`, with Slack on. This release ships the `debugger`
agent only; the running install also serves `oncall` (the opt-in OnCall agent, a
separate PR), which `make` leaves untouched, see "Agent guard". From the repository
root of a reviewed checkout:

```bash
make deploy_dev_dry                              # checks, prints every gcloud command, runs none
make deploy_dev CONFIRM=livex-openclaw-dev       # deploys the checked-out HEAD
LIVEX_TEST_IAP=0 make deploy_dev CONFIRM=livex-openclaw-dev   # direct SSH instead of IAP
```

`deploy_dev.sh` (called by the Makefile) refuses unless `livex-native/` has no
modified, staged or untracked files and HEAD is contained in an `origin/*` branch
(it runs `git fetch --prune origin` first and prints the sha and branches). A real
deploy also needs `CONFIRM=livex-openclaw-dev`, because it restarts the live Slack
Gateway; `deploy_dev_dry` does not. It needs `git`, `tar`, `shasum` and, outside
`--dry-run`, `gcloud`; it needs no Node. It then runs `deploy.sh` with
`LIVEX_DEV_LIVE=1` on that sha, which keeps its own refusals (committed tooling, sha
equals HEAD). Only the `livex-native/` tree of HEAD is deployed.

**How it differs from staging** (`LIVEX_ON_DEV_VM=1`): the VM, project, root and
port are fixed (`livex-openclaw-dev`, `/opt/livex-openclaw-native-dev`, `18790`),
Slack is on (`remote.sh` refuses if `runtime.env` has no `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN`; `apply.mjs` sets `channels.slack` from them), channel startup is
not suppressed, and `/readyz` is polled on `18790`. `LIVEX_DEV_LIVE=1` refuses to combine with `LIVEX_ON_DEV_VM` or
`LIVEX_TEST_VM`, and `remote.sh` refuses off `livex-openclaw-dev`. Nothing outside
`/opt/livex-openclaw-native-dev` is written on the filesystem, and
`/opt/livex-openclaw-stage` is never touched. A deploy restarts the Gateway briefly (Slack reconnects); a
failure rolls back as described under "Rollback scope", including restarting the
previous image only if it was running.

### Agent guard

Before it builds or stops anything, a live deploy runs `apply.mjs` read-only in
the new image against the live `openclaw.json` (`LIVEX_LIVE_GUARD=1`,
`LIVEX_CHECK_AGENTS_ONLY=1`). It refuses when the live config serves a LiveX agent
(`oncall`, `debugger`, or any agent whose workspace has a `skills/.livex-shipped`
manifest) that the release's fragment does not ship, because apply would leave it
frozen and unmanaged. Either deploy a commit that includes the agent (for example the
PR that adds OnCall) or list it in `LIVEX_UNMANAGED_AGENTS`. Staging and the test VM
are unchanged. The check runs again inside the real apply.

**`LIVEX_UNMANAGED_AGENTS`** is a comma-separated allowlist of agent ids (1 to 5,
`^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*)*$`) that a live deploy must leave alone.
`make deploy_dev` and `make deploy_dev_dry` default it to `oncall`, because OnCall
lives in a separate PR (#51) and is not in this branch. `deploy_dev.sh` prints it;
`deploy.sh` validates it, shows it in the summary and in `--dry-run`, and forwards it;
`remote.sh` validates it again and passes it to both the pre-stop check and the real
apply. Outside `make` it defaults to empty, which is strict. It is refused without
`LIVEX_DEV_LIVE=1` (`apply.mjs` also needs `LIVEX_LIVE_GUARD=1`), and `apply.mjs`
refuses a list that names an agent the release ships, so a managed agent cannot be
marked unmanaged by accident (if that comes from the Makefile default, run
`make deploy_dev LIVEX_UNMANAGED_AGENTS= ...`). The guard prints
`live guard: leaving unmanaged agent(s) untouched: oncall`.

"Untouched" covers the agent's own state only: apply never writes its
`agents.entries.<id>` entry, never copies into, prunes in or writes a manifest in its
workspace, and neither adds, removes nor changes a binding for it (the retirement of
a stock OnCall Slack wildcard is switched off for `oncall`; such a wildcard would
instead stop apply as a shadowing wildcard). It does NOT freeze what the agent
shares with this release: plugin code and config (`plugins.*`), the `channels.slack`
policy, the global `tools` floor and the Codex appServer settings
(`plugins.entries.codex.*`) are rewritten by apply, and the agent runs on them after
the deploy. The merge also sets `agents.ownership: "explicit"`,
`agents.defaults.systemAgent` (debugger, as the live config already has) and the
other defaults, plus the debugger Slack route. Tests assert the agent-level
guarantees against a config that mirrors the live one.

**Preview before the stop.** The pre-stop check (`LIVEX_CHECK_AGENTS_ONLY=1`) runs the
same config preparation and merge as the real apply, so its refusals (for example a
shadowing wildcard) surface before anything is stopped, and then prints what apply
would change in `openclaw.json`: one line per path, sorted, `+` added, `~` changed,
`-` removed; arrays as `[n items #hash]`; values of paths matching
`token|secret|password|key` and SecretRefs as `<changed>`; the first 80 lines and a
count; then the changed paths that are shared settings (`plugins.*`,
`channels.slack.*`, `tools.*`). It writes nothing (no backup, plugin install or
workspace copy; a test compares a hash of the whole state tree). It is read before
apply's plugin install, so config that the install itself writes is not shown. It
appears in the deploy log under "check the live agents and preview the config
change".

To run the preview alone, copy only `deploy/apply.mjs` and
`config/openclaw.fragment.json5` into a directory `$d` (as `$d/deploy/` and
`$d/config/`) and run it inside the live Gateway container, which supplies `json5`
(`/app`), the state path and the Slack env:

```bash
docker exec -i -e d=/tmp/preview <gateway container> sh -c 'LIVEX_NATIVE_DIR=$d \
  LIVEX_PLUGIN_ROOT=/opt/livex-native LIVEX_HOST_PORT=18790 LIVEX_LIVE_GUARD=1 \
  LIVEX_CHECK_AGENTS_ONLY=1 LIVEX_UNMANAGED_AGENTS=oncall node $d/deploy/apply.mjs'
```

No other release file is needed in this mode. `LIVEX_PLUGIN_ROOT` is where the plugins
live in the image (default: `LIVEX_NATIVE_DIR`); without it a preview run from a temp
dir would show `plugins.load.paths` as changed, which is an artifact of the temp dir.
`LIVEX_HOST_PORT` is the host port of the install (`remote.sh` passes 18790 live,
18789 for staging and the test VM, to both the check and the real apply).

**Control UI origins.** apply sets `gateway.controlUi.allowedOrigins` to the
`127.0.0.1` and `localhost` origins of the container port (18789) and the host port
(`LIVEX_HOST_PORT`), added after any origins already in the config. Operator-added
entries are kept, so a tunnel to `http://127.0.0.1:18790` keeps working on the live
install. The other gateway keys apply writes (`mode`, `bind`, `port`, `auth`) are
still overwritten, as before: they are fixed by the container setup, not per-operator
settings. To go strict again run
`make deploy_dev CONFIRM=livex-openclaw-dev LIVEX_UNMANAGED_AGENTS=` (or deploy a
commit that ships the agent).

### One-time adoption of the hand-made install

The first `make deploy_dev` finds the layout that was set up by hand: no
`current-release` link, `current`/`previous` records that are bare commit shas, a
`compose.env` whose `STATE_DIR` is `release-<sha>.<rand>/state`. `remote.sh` plans
the migration before it builds or stops anything, and refuses (changing nothing) if
the layout is not recognized, `compose.yaml` or the running image is missing,
`docker compose config` fails or lacks a `gateway` service, `gateway-1` is not
running or was not created from `$root/compose.yaml`, it does not publish
`127.0.0.1:18790` (`compose port`), or there is not room to copy the state. It
also pins the running image as `livex-openclaw-native-dev:pre-adopt-<ts>`, so a
rebuild of the same sha cannot move the rollback target. Then, with the Gateway
stopped:

1. `compose.env` and the records are copied to `adopt-backup.<ts>/`.
2. An existing `$root/state` is renamed to `state.pre-adopt.<ts>` (never deleted;
   an empty leftover is removed after a good deploy).
3. The state directory named by the old `compose.env` is **copied** (`cp -a`:
   owner and modes kept) to `$root/state`. The old `release-*/state` is never
   written.
4. The normal flow runs on the copy: snapshot, apply, `config validate`, start,
   `/readyz` on 18790, then the records are written in our format
   (`current-release`, `compose.env`, `previous`, `current` last). `previous` is
   the pinned `pre-adopt-<ts>` tag of the old running image; the old `previous`
   record is superseded, as in any deploy.

If anything fails, the copy is removed, the moved-aside state is put back, and the
original image (by its pre-adopt tag, which is also re-applied to the original
sha tag) is restarted from the original `$root/compose.yaml` and `compose.env`
(the old records are written back; if that restore itself failed, the backup copy
is used). A failure at any point, including the backup step, takes this path.
The failed deploy leaves no new directories besides `releases/<sha>`. A retry
adopts again. After success the layout is the normal one, so later deploys do not
adopt. The root `compose.yaml`, the `prepared` record and every `release-*` dir
stay as they were.

Codex sign-ins live in the state, so the copy keeps them; if an agent asks again,
`deploy.sh` prints the device-code commands (one per agent) to run through
`docker compose exec`.

### Disk housekeeping and the legacy leftovers

After a good live deploy: images of the project other than the current and
previous are removed, `docker image prune -f` drops dangling images (this is
Docker-wide, and never removes tagged images), the newest three `releases/<sha>`
and two `state.failed.*` are kept (existing behavior). Live mode does not run
`docker builder prune`: the VM's build cache is shared with staging and other
builds. Free it by hand if disk is short. The legacy `release-*` directories (a full state copy each) and
`state.pre-adopt.*` are **not** deleted by any deploy: the old state there is the
only pre-adoption copy and holds sessions and Codex auth, so the deploy lists them
with sizes and prints the exact `sudo rm -rf ...` line instead. Run it by hand
after at least one later deploy has succeeded and you no longer need to roll back
to the hand-made layout. No deploy deletes a path outside
`/opt/livex-openclaw-native-dev`.

### Rolling back a live deploy that succeeded

On the VM, with `lx` defined as in "After the first deploy" but for project
`livex-openclaw-native-dev` and root `/opt/livex-openclaw-native-dev`, follow
"Rollback" (the pre-deploy snapshot is `releases/<sha>/state.before.tgz`). To go
back to the hand-made layout after adoption, stop the gateway and start the old
image from the old files:
`sudo env OPENCLAW_IMAGE=<the previous record> docker compose --project-name livex-openclaw-native-dev -f /opt/livex-openclaw-native-dev/compose.yaml --env-file /opt/livex-openclaw-native-dev/adopt-backup.<ts>/compose.env up -d --pull never gateway`.
That serves the pre-adoption state, so sessions since the adoption are not in it.

| File | Runs on | What it does |
| --- | --- | --- |
| `deploy.sh` | operator Mac | Checks the script is committed and the sha is HEAD, `git archive`s it, uploads it over IAP, runs `remote.sh` under a lock. `--dry-run` prints the gcloud commands and runs none |
| `deploy_dev.sh` | operator Mac | `make deploy_dev`: checks a clean `livex-native/` and a pushed HEAD, then runs `deploy.sh` with `LIVEX_DEV_LIVE=1` |
| `remote.sh` | VM, as root | Builds the image, snapshots state, applies config in the new image, cuts over, gates on `/readyz`, rolls back on failure |
| `Dockerfile` | VM build | Official OpenClaw image (digest-pinned) + Google Cloud CLI + `livex-native` + the Slack plugin tarball, patched by `patch-slack-navigation.mjs` |
| `versions.env` | VM build | Pinned image digests, Slack plugin version and sha512 |
| `verify-tarball.mjs` | VM build | Fails the build if the Slack tarball's sha512 differs from the pin |
| `compose.yaml` | VM | `gateway` (loopback-only port) and `cli` (profile `tools`) |
| `apply.mjs` | in the `cli` container | Idempotent config merge, plugin install, workspace copy |

### Remove the earlier DEV install

An earlier design installed `/opt/livex-openclaw-test` on `livex-openclaw-dev`
with a copy of PR #1's Slack tokens in its `runtime.env`, and a
`livex-openclaw-test-gateway-1` container. Starting that container would put a
second Gateway on the same Slack app. `dev-bootstrap.sh` refuses to stage while
it runs and warns while the leftover exists. Remove it once, on the DEV VM:

```bash
# Must print nothing: no other container may mount the leftover directory.
sudo docker ps -aq | xargs -r sudo docker inspect --format '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' | grep /opt/livex-openclaw-test | grep -v '^/livex-openclaw-test-'
sudo docker rm -f livex-openclaw-test-gateway-1
sudo docker network rm livex-openclaw-test_default
sudo rm -f /opt/livex-openclaw-test/runtime.env
sudo rm -rf /opt/livex-openclaw-test
```

The last line also deletes that install's state and snapshots; keep the
directory (minus `runtime.env`) if you still want them.

## Deploy

```bash
( set -e; cd <checkout>; sha=<40-hex>; git fetch origin refs/pull/50/head; test "$(git rev-parse FETCH_HEAD)" = "$sha"; test "$(git rev-parse HEAD)" = "$sha"; export PATH=<toolchain node 24.16>/bin:$PATH; bash livex-native/deploy/deploy.sh "$sha" )
```

Add `--dry-run` to see every command first. `deploy.sh` refuses unless `sha` is the
checked-out HEAD and `livex-native/deploy` matches HEAD. The project is fixed to
`ai-mvp-dv`. The VM name must match `livex-openclaw-test[-suffix]` (default
`livex-openclaw-test`, override with `LIVEX_TEST_VM`) and the zone defaults to
`us-central1-a` (`LIVEX_TEST_ZONE`). ssh and scp go through IAP; set
`LIVEX_TEST_IAP=0` only if you have another allowed path to port 22.

What a deploy does on the VM, in order: check free disk (below); build
`livex-openclaw-test:<sha>` (`livex-openclaw-stage:<sha>` when staging); stop the
gateway; snapshot the state directory; run `apply.mjs` and `openclaw config
validate` in the new image; start the new gateway; wait up to 120 s (300 s for
DEV staging, or set `LIVEX_HEALTH_TIMEOUT`) for
`http://127.0.0.1:18789/readyz`. Only then are the activation records changed:
all four are first staged as temporaries (a failure there changes nothing), then
renamed in the order `current-release`, `compose.env`, `previous`, `current`
(the commit point). If a rename fails, the deploy rolls back and restores the
four records to their earlier values, so they stay consistent with the image that
is running. `/readyz` includes the channel check, so a broken Slack
config fails the deploy (compose still uses `/healthz` for container liveness).
A failure before the stop (free-space check, build, bad `versions.env`) leaves
the running gateway untouched.

Deploying the same sha again is supported. The previous distinct release and its
`state.before.tgz` are kept; the attempt snapshots to `state.retry.<pid>.tgz`
instead, which is deleted once the redeploy succeeds or its state is restored.

### Memory and disk

- **Free space.** Before the build, `remote.sh` refuses unless the filesystem
  holding the deploy root, and Docker's data root when `docker info` answers,
  each have at least 5 GiB free. This runs before anything is stopped, so the
  running gateway is untouched. Override the floor with
  `LIVEX_MIN_FREE_GIB=<whole GiB, 0-9999>` in the environment of `deploy.sh`
  (`0` turns it off); `deploy.sh` validates it and forwards it, and `--dry-run`
  shows it. The 5 GiB is a starting value, not a measured need: a build adds a
  second full image next to the running one.
  - **If it refuses**, free space by hand on the VM (as root). Safe to remove:
    images of this project other than the `current` and `previous` recorded in
    `/opt/<project>/` (`docker image ls livex-openclaw-test` or
    `livex-openclaw-stage`, then `docker image rm <repo:tag>`), and old
    `releases/<sha>` directories other than the ones named by `current`,
    `previous` and `current-release`. Never remove other projects' images (the
    shared DEV VM runs other Gateways), the state directory, or
    `state.failed.*` you still need. `docker builder prune -f` is safe on the
    dedicated VM but not on the DEV VM, whose cache staging and the live install share.
- **Memory.** No cap by default (`mem_limit: ${LIVEX_GATEWAY_MEM_LIMIT:-0}`;
  `0` means unlimited, and compose.yaml was only read, not run through
  `docker compose config`, here). The value is unmeasured, OpenClaw lowers the
  `oom_score_adj` of the children it starts (`src/process/`), so a cgroup cap
  would make the kernel kill the Codex child or a `gcloud` helper mid-turn
  rather than the Gateway, and GCE images have no swap. To set a cap, first
  measure: run `sudo docker stats --no-stream` repeatedly during a real
  multi-page Codex turn on that VM (the Gateway and the Codex child share one
  container). Then add `LIVEX_GATEWAY_MEM_LIMIT=<n>g` (or `<n>m`) with margin
  above the peak to `/opt/<project>/compose.env`; `remote.sh` validates it
  (`0`, or at least `1g`: a cap that is too low also breaks rollback, which restarts the previous image under it) and carries it across deploys. VM sizes for reference:
  `e2-medium` 4 GB; the shared DEV VM `e2-standard-2` 8 GB also hosts other
  Gateways.

### What apply does (all idempotent)

- Merges `config/openclaw.fragment.json5` into `openclaw.json` without resolving
  `${VARS}`; they resolve at runtime from `runtime.env`.
- Sets `gateway` to `mode local`, `bind lan` (needed inside the container for the
  published port), port 18789, token auth from `${OPENCLAW_GATEWAY_TOKEN}`, and the
  Control UI origins for the tunnel.
- Writes `agents.entries.<id>.workspace` for the shipped agent and keeps
  exactly one load path, `/opt/livex-native/plugins/livex-gcp-readonly`.
- Copies each agent's `AGENTS.md` and `skills/` into `state/workspace-<id>/`.
- Ensures plugins (below).
- In DEV staging, replaces the Slack config with an explicitly disabled channel.
- On the dedicated VM, if both Slack tokens are in `runtime.env`, sets
  `channels.slack` to socket mode with env SecretRefs
  (`docs/channels/slack/setup.md`). Tokens are never copied into the config.
- Keeps the previous config as `openclaw.json.pre-<sha>`.

### Exact merge semantics

- Objects merge key by key; fragment values win over existing ones.
- **Union arrays** (existing entries stay, fragment entries are added once):
  `plugins.allow`, `plugins.load.paths` (stale copies of this plugin's path are
  dropped, other paths stay).
- **Bindings**: the fragment defines the default Debugger Slack route. The
  installer retires the verified OnCall wildcard from the earlier native demo
  and keeps operator-managed channel routes. See the
  [upgrade instructions](../README.md#upgrade-the-earlier-two-agent-demo).
- **Repositories**: when `repos/manifest.json` pins at least one commit,
  `plugins.entries.livex-gcp-readonly.config.repositories` is MANAGED: it is replaced by
  `{ id, path: "/repos/<id>", commit }` for every pinned entry (a stale VM list is dropped).
  With no pins, a non-empty list on the VM is kept (the fragment's empty list does not
  overwrite it). The change preview lists the rendered repositories.
- **All other arrays** (`skills`, `tools.allow`, `users`, `allowFrom`, ...) are
  replaced by the fragment's value.
- **Other keys removed from the fragment persist.** The managed routing migration is the exception.
  To delete a key, edit `openclaw.json` on the VM, or restore from a snapshot.
- Workspaces: `AGENTS.md` and each shipped `skills/<name>/` are overwritten each
  release. `skills/.livex-shipped` lists the skills a release shipped; a skill that
  was in the previous list but not in the new release is deleted. Skills an operator
  or agent created are never touched, and the first deploy (no list yet) prunes
  nothing. `SOUL.md`, `IDENTITY.md`, `USER.md` and `memory/` are never touched.

### Plugins

OpenClaw treats a local tarball as an unverified source and asks for capability
consent, even for the official Slack package. `apply.mjs` runs
`openclaw plugins install npm-pack:<tarball> --force --accept-capabilities` for
the release tarball, then checks the accepted surface: anything beyond the Slack
channel and its skills fails the deploy.

- **codex** is bundled in the official image (`docs/install/docker.md`). Apply
  never installs it and fails if `plugins list` does not show it.
- **Slack** ships as a separate package (`bundledDist: false`). The build verifies
  the pinned npm archive against its registry SHA512 in `versions.env`, then
  backports PR #34's passive URL-button guard to the exact monitor bundle
  (`patch-slack-navigation.mjs`; this is the one patch to a plugin package).
  Re-verify it on every Slack plugin version bump: it fails the build unless the
  bundle's sha256 matches the verified file name and digest.
  Apply compares the release archive's SHA512 with the managed install record
  and installs the local archive when they differ, including stock installations
  at the same version. Apply verifies the installed version, integrity, and
  Slack-only capability surface.
- OpenClaw's managed npm project resolves the package's dependencies and may
  contact the registry during installation. Deploys with the same installed
  release archive skip installation.
- The state snapshot (below) covers installed plugins.

### Rollback scope

Before apply, with the gateway stopped (so SQLite files are quiescent), `remote.sh`
snapshots the whole state directory to `releases/<sha>/state.before.tgz` (mode 0600).
The snapshot is verified with `tar -tzf` before apply runs; a bad snapshot aborts the
deploy with state untouched; the previous gateway is restarted only if it was
running before the deploy, otherwise it is left stopped. If anything fails
after the stop, `remote.sh` first stops the new gateway (so nothing writes to state
or makes docker recreate a missing bind-mount source during the swap), then restores
the snapshot by rename, then starts the previous image and waits for `/readyz`.
The failed state is never deleted: it is kept as
`/opt/livex-openclaw-test/state.failed.<sha>.<timestamp>` (the newest two are kept and
older ones are pruned after a later successful deploy). If the snapshot cannot be
restored (for example it will not extract), the gateway is left stopped, no previous
image is started on broken state, and the script prints where the snapshot and state
are and exits non-zero. Rollback therefore covers the image,
`openclaw.json`, workspaces, installed plugins and the SQLite databases. On a first
deploy with no previous image it restores the snapshot and leaves the gateway
stopped. The gcloud directory is not snapshotted: it holds only gcloud's own caches
(the attached service account stores no credentials there) and apply never writes it.
The VM keeps the current and previous images and the newest three releases, runs
`docker builder prune` for cache older than a week after a good deploy (not on the
shared DEV VM), and prints `df -h` before the build and after the deploy.

Agents are written straight into config, not created with `openclaw agents add`.
On a fresh state that command also creates a `main` agent and pins
`agents.defaults.systemAgent` to it (seen in the smoke test), while the fragment
already pins `debugger`. Writing the entries is the same config `agents add`
produces for a basic non-interactive add (`docs/cli/agents.md`), and the
idempotent merge keeps one code path for first deploy and upgrades.

The JSON5 fragment is parsed with `json5` from `/app/node_modules`. It is a
runtime dependency of OpenClaw itself (it parses `openclaw.json`), and the
Dockerfile fails the build if it stops resolving. This keeps the fragment as the
single source, with its comments.

## One-time setup (operator runs these)

Replace `LOG_PROJECT` with the project whose Cloud Logging the agents read
(the same value as `GCP_PROJECT` below).

```bash
# 1. Service account, read-only on logs. No key files, no `gcloud auth login`.
gcloud iam service-accounts create livex-openclaw-test --project=ai-mvp-dv \
  --display-name="LiveX OpenClaw test"
gcloud projects add-iam-policy-binding LOG_PROJECT \
  --member=serviceAccount:livex-openclaw-test@ai-mvp-dv.iam.gserviceaccount.com \
  --role=roles/logging.viewer

# 2. The VM: Debian 12, e2-medium, 30 GB, attached service account, OS Login,
#    and only the logging-read API scope.
gcloud compute instances create livex-openclaw-test --project=ai-mvp-dv \
  --zone=us-central1-a --machine-type=e2-medium \
  --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB \
  --service-account=livex-openclaw-test@ai-mvp-dv.iam.gserviceaccount.com \
  --scopes=logging-read --metadata=enable-oslogin=TRUE --tags=livex-openclaw-test

# 3. Ingress: SSH from IAP only. Nothing exposes 18789; compose publishes it on
#    the VM's loopback and you reach it through an SSH tunnel.
gcloud compute firewall-rules create livex-openclaw-test-ssh --project=ai-mvp-dv \
  --network=default --allow=tcp:22 --source-ranges=35.235.240.0/20 \
  --target-tags=livex-openclaw-test
```

- **Check the network's other rules.** The `default` network usually has
  `default-allow-ssh` (port 22 from anywhere), which would still admit the VM.
  List it with `gcloud compute firewall-rules list --project=ai-mvp-dv
  --filter="network:default"` and delete or narrow it if nothing else relies on
  it (or use a dedicated network).
- **Prerequisites for each operator** (once per person): `roles/iap.tunnelResourceAccessor`
  for the IAP tunnel; `roles/compute.osAdminLogin` (OS Login with sudo, which
  `remote.sh` needs); `roles/compute.viewer` for the instance lookup; and
  `roles/iam.serviceAccountUser` on
  `livex-openclaw-test@ai-mvp-dv.iam.gserviceaccount.com`, which OS Login requires to
  SSH into a VM with an attached service account. Whoever creates the VM needs the
  last one too.
- **The VM keeps an external IP** on purpose: it needs outbound access to ghcr.io,
  gcr.io, registry.npmjs.org, Slack and OpenAI. For more hardening, create it with
  `--no-address` and add a Cloud NAT; IAP still works.
- **Scope check:** `logging-read` allows `gcloud logging read`. Nothing in the
  deployed bundle calls another Google API. Image pulls use anonymous public
  registries, and OS Login uses IAM, not a VM scope. Not yet run on this VM; if a
  call fails with a scope error, widen only as far as that call needs.

On the VM (`gcloud compute ssh livex-openclaw-test --project=ai-mvp-dv
--zone=us-central1-a --tunnel-through-iap`), install Docker with the compose plugin,
as `docs/install/gcp.md` does. Everything below runs docker with `sudo`, so the
`docker` group is not used:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo docker --version && sudo docker compose version
```

Create the directories and the private runtime env (root-only, mode 0600):

```bash
sudo install -d -m 0755 /opt/livex-openclaw-test /opt/livex-openclaw-test/releases
sudo install -d -m 0700 -o 1000 -g 1000 /opt/livex-openclaw-test/state /opt/livex-openclaw-test/gcloud
sudo touch /opt/livex-openclaw-test/runtime.env
sudo chmod 0600 /opt/livex-openclaw-test/runtime.env
sudoedit /opt/livex-openclaw-test/runtime.env      # paste the block below
```

```bash
OPENCLAW_GATEWAY_TOKEN=<openssl rand -hex 32>
SLACK_BOT_TOKEN=<xoxb- token of the TEST Slack app>
SLACK_APP_TOKEN=<xapp- token of the TEST Slack app>
SLACK_SENDER_ID=<Slack member ID allowed to talk to the bot, e.g. U0123ABCD>
GCLOUD_PATH=/opt/google-cloud-sdk/bin/gcloud
CLOUDSDK_CONFIG=/home/node/.config/gcloud
GCLOUD_ACCOUNT=livex-openclaw-test@ai-mvp-dv.iam.gserviceaccount.com
GCP_PROJECT=<LOG_PROJECT>
PYTHON_PATH=/usr/bin/python3
GCLOUD_SDK_ROOT=/opt/google-cloud-sdk
```

`SLACK_SENDER_ID` must be set before the first deploy: it gates both LiveX tools
and the channel allowlist, and an unresolved value stays literal.

### Separate Slack app

Create a new Slack app, "LiveX Debugger (test)", in Socket Mode, from the
"Recommended" manifest in `docs/channels/slack/setup.md`. Add the bot scope
`chat:write.customize` (the agent's display identity needs it). Use its own
tokens in `runtime.env`. Run ONE active Gateway per Slack app: Slack delivers
each Socket Mode event to only one of the app's connections, so the same app on
the dev VM and here would split messages. Invite the app to the channels it should read.

### gcloud on the VM

The container reads logs as the VM's attached service account through the
metadata server, so nothing is logged in and no key file exists.
`CLOUDSDK_CONFIG` is a writable state directory only. The plugin always calls
`gcloud --account=$GCLOUD_ACCOUNT --project=$GCP_PROJECT`. After the first
deploy, prove it works from the container (not yet run for this setup):

```bash
lx run --rm --no-deps --entrypoint gcloud cli \
  --account=livex-openclaw-test@ai-mvp-dv.iam.gserviceaccount.com \
  --project=LOG_PROJECT logging read 'severity>=ERROR' --limit=1
```

## After the first deploy

This section and Rollback are for the dedicated `livex-openclaw-test` VM only. Do
not run these commands on `livex-openclaw-dev`: there the `livex-openclaw-test`
project is a leftover (see "Remove the earlier DEV install").

Run the deploy command above. On the VM, define a helper once. Each successful
deploy points `current-release` and `compose.env` at the new release and image:

```bash
lx() { sudo docker compose --project-name livex-openclaw-test \
  -f /opt/livex-openclaw-test/current-release/livex-native/deploy/compose.yaml \
  --env-file /opt/livex-openclaw-test/compose.env "$@"; }
```

1. Codex sign-in (interactive, device code). Run it inside the gateway
   container, because `models auth login` talks to the Gateway that owns the
   state directory and the separate `cli` container has no network path to it:

   ```bash
   lx exec gateway node /app/openclaw.mjs models auth login --provider openai --method device-code --agent debugger
   ```

   Then `/status` in a chat with the bot should say `Runtime: OpenAI Codex`.
2. Control UI. From the Mac, keep this tunnel open and browse to
   `http://127.0.0.1:18789/`; paste `OPENCLAW_GATEWAY_TOKEN` into Settings:

   ```bash
   gcloud compute ssh livex-openclaw-test --project=ai-mvp-dv --zone=us-central1-a \
     --tunnel-through-iap -- -N -L 18789:127.0.0.1:18789
   ```

   A new browser may need a pairing approval:
   `lx exec gateway node /app/openclaw.mjs devices list`, then `devices approve <id>`.
3. Mention the bot in a channel it was invited to, from `SLACK_SENDER_ID`.

Logs: `lx logs -f gateway`. Status: `lx ps`.

## Rollback

A failed deploy rolls back by itself (image, config and state; see Rollback scope).
To undo a deploy that succeeded, on the VM:

```bash
cd /opt/livex-openclaw-test
lx stop gateway
# Optional: also discard everything since that deploy (sessions, workspaces) by
# restoring its pre-deploy snapshot; skip these two lines to keep current state.
sudo mv state state.discarded && sudo tar -C . -xpzf releases/<bad-sha>/state.before.tgz
# Make `current`, compose.env and current-release point at the previous release,
# so the next deploy records the right `previous`:
img=$(sudo cat previous); sha=${img##*:}
echo "$img" | sudo tee current >/dev/null
sudo sed -i "s|^OPENCLAW_IMAGE=.*|OPENCLAW_IMAGE=$img|" compose.env
sudo ln -sfn /opt/livex-openclaw-test/releases/$sha current-release
lx up -d --pull never gateway
```

If you keep the current state, restore only the config instead (before the `lx up`):
`sudo cp -p state/openclaw.json.pre-<bad-sha> state/openclaw.json`. Or redeploy the
older sha with `deploy.sh` (it must be the checked-out HEAD). A newer image may have
migrated state on startup, so an older image can refuse it; if so, redeploy forward.

## Add repositories

`livex_repository_read` reads pinned, read-only source snapshots mounted at `/repos`.
The pins live in [`repos/manifest.json`](../repos/manifest.json); the operator flow
(`make repos_pin`, commit, `make repos_dev`, `make deploy_dev`) is in
[`repos/README.md`](../repos/README.md). What the deploy does with them:

- `compose.yaml` always mounts `${LIVEX_REPOS_DIR}:/repos:ro`. `remote.sh` writes
  `LIVEX_REPOS_DIR` to `compose.env`: live mode uses `$root/repos`, a symlink that
  `repos.sh install` repoints (an empty `$root/repos-empty` stands in until the first
  install); stage and test modes mount an empty `$root/repos-empty`.
- Docker resolves the symlink when the container is created, so a new snapshot is only
  seen after a deploy (or `docker compose up -d --force-recreate gateway`).
- Before anything is stopped (live mode), `remote.sh` runs a throwaway container from
  the new image as uid 1000 and checks that every pinned entry has `$root/repos/<id>`
  owned by that user with `git cat-file -e <commit>^{commit}` succeeding. A missing
  snapshot refuses the deploy ("run make repos_dev first") and leaves the Gateway alone.
- `apply.mjs` renders the repositories list from the manifest shipped in the image.

## Verification

The earlier DEV cutover timed out during the official image's startup Doctor
run. Run `python3 -B livex-native/deploy/test_deploy.py` from the repository root
for local success and rollback tests with Docker stubbed. `node --test deploy/test_apply.mjs deploy/test_patch_identifiers.mjs`
covers apply and the Slack patch's identifier check. `python3 -B livex-native/repos/test_repos.py`
covers the source-snapshot tooling (pin, build, install, verify, rollback, make targets). The isolated staging flow still needs a live signed-in smoke test.

- The plugin's TypeScript entry and its `*-operation-api.ts` module loading from
  `/opt/livex-native` in the production image.
- Slack plugin install from the baked tarball, including its npm dependencies.
- `gcloud --account` with metadata credentials and the `logging-read` scope.
- Control UI pairing through the tunnel.
- Codex's native shell uses bubblewrap sandboxing, which may fail inside this
  unprivileged container (no extra capabilities are granted). That fails closed:
  native shell commands error instead of running unsandboxed. Do not add
  privileges to work around it; the LiveX tools do not depend on the native shell.

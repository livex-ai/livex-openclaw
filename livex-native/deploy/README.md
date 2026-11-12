# Deploy livex-native

The default target is the dedicated `livex-openclaw-test` VM. It uses its own
Slack app and the official OpenClaw image. `LIVEX_ON_DEV_VM=1` stages a candidate
on the existing DEV VM for Gateway and Codex checks.

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

| File | Runs on | What it does |
| --- | --- | --- |
| `deploy.sh` | operator Mac | Checks the script is committed and the sha is HEAD, `git archive`s it, uploads it over IAP, runs `remote.sh` under a lock. `--dry-run` prints the gcloud commands and runs none |
| `remote.sh` | VM, as root | Builds the image, snapshots state, applies config in the new image, cuts over, gates on `/readyz`, rolls back on failure |
| `Dockerfile` | VM build | Official OpenClaw image (digest-pinned) + Google Cloud CLI + `livex-native` + the Slack plugin tarball |
| `versions.env` | VM build | Pinned image digests, Slack plugin version and sha512 |
| `verify-tarball.mjs` | VM build | Fails the build if the Slack tarball's sha512 differs from the pin |
| `compose.yaml` | VM | `gateway` (loopback-only port) and `cli` (profile `tools`) |
| `apply.mjs` | in the `cli` container | Idempotent config merge, plugin install, workspace copy |

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

What a deploy does on the VM, in order: build `livex-openclaw-test:<sha>`; stop the
gateway; snapshot the state directory; run `apply.mjs` and `openclaw config
validate` in the new image; start the new gateway; wait up to 120 s (300 s for
DEV staging, or set `LIVEX_HEALTH_TIMEOUT`) for
`http://127.0.0.1:18789/readyz`. Only then are `current` and `previous` written.
`/readyz` includes the channel check, so a broken Slack config fails the deploy
(compose still uses `/healthz` for container liveness). A failure before the stop
(build, bad `versions.env`) leaves the running gateway untouched.

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
- **Kept if set**: a non-empty `plugins.entries.livex-gcp-readonly.config.repositories`
  on the VM is not overwritten by the fragment's empty list.
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
consent, even for the official Slack package. `apply.mjs` passes
`--accept-capabilities` for the release tarball, then checks the accepted
surface: anything beyond the Slack channel and its skills fails the deploy.

- **codex** is bundled in the official image (`docs/install/docker.md`). Apply
  never installs it and fails if `plugins list` does not show it.
- **Slack** ships as a separate package (`bundledDist: false`). The build verifies
  the pinned npm archive against its registry SHA512 in `versions.env`, then
  backports PR #34's passive URL-button guard to the exact monitor bundle.
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
deploy with state untouched and the previous gateway restarted. If anything fails
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
`docker builder prune` for cache older than a week after a good deploy, and prints
`df -h` before the build and after the deploy.

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

`livex_repository_read` shows nothing until reviewed snapshots exist.
`repositories` is empty and there is no `/repos` mount by default. To add one,
put a checkout at `/opt/livex-openclaw-test/repos/<id>`, uncomment the `/repos`
read-only volume in `compose.yaml`, and add
`{ id, path: "/repos/<id>", commit: "<40-hex>" }` to
`plugins.entries.livex-gcp-readonly.config.repositories` in the fragment
(or in `openclaw.json`; a non-empty list on the VM is kept). Then redeploy.

## Verification

The earlier DEV cutover timed out during the official image's startup Doctor
run. Run `python3 -B livex-native/deploy/test_deploy.py` from the repository root
for local success and rollback tests with Docker stubbed. The isolated staging flow still needs a live signed-in smoke test.

- The plugin's TypeScript entry and its `*-operation-api.ts` module loading from
  `/opt/livex-native` in the production image.
- Slack plugin install from the baked tarball, including its npm dependencies.
- `gcloud --account` with metadata credentials and the `logging-read` scope.
- Control UI pairing through the tunnel.
- Codex's native shell uses bubblewrap sandboxing, which may fail inside this
  unprivileged container (no extra capabilities are granted). That fails closed:
  native shell commands error instead of running unsandboxed. Do not add
  privileges to work around it; the LiveX tools do not depend on the native shell.

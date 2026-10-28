# Private GCP VM oncall runtime

This package prepares a reviewed fork for one Debian VM; it never provisions,
starts, authenticates, or modifies an existing deployment. Use the generic
[GCP guide](../../docs/install/gcp.md) for host setup, but use **attached service
account authentication** for this workload instead of its user-login examples.
The Grafana deployment's image/config packaging is a useful precedent; its
Cloud Run lifecycle is not used here.

## Review the inputs

An operator manually creates a credential-free JSON snapshot outside the repo
from the intended configuration. Do not pass live `openclaw.json`, copy desktop
`auth.json`, or copy credential stores to this tool. Every credential field
must already be a default-provider env SecretRef, for example
`{"source":"env","provider":"default","id":"SLACK_BOT_TOKEN"}`.
Raw credential fields, exported top-level environment maps, literal headers, and
host file/exec/store providers are rejected. Native `auth.profiles` provider/mode
metadata may remain; credential-bearing fields must use env SecretRefs. This is
an input validator, not an automatic sanitizer; the operator still reviews
all unknown/custom fields for private data before use.

Keep all operational settings: Slack accounts/default account, routing,
caller/channel gates, follow-up/mention policies, Codex runtime and tool
permissions, skills, and every repository ID and immutable commit pin.
`prepare.py` copies unchanged fields; it only maps **whole string** absolute
paths, changes Gateway `loopback` to container `lan`, selects the supplied
attached SA account, and fills an absent effective oncall primary model while preserving fallbacks.
An existing different primary, including one inherited from defaults, is rejected. Config/runtime/skills/tools remain in native OpenClaw JSON.
Use explicit `gateway.mode: "local"`, `gateway.auth.mode: "token"` and an
env-referenced Gateway token. The reviewed Gateway port must be `18791`; different ports are rejected.
No extra Codex TOML or desktop auth transplant is needed.

Create a private settings JSON alongside the snapshot with these fields:

- `attachedServiceAccount`: exact attached `NAME@PROJECT.iam.gserviceaccount.com`.
- `approvedModel`: explicitly approved `provider/model` string.
- `image`: final built runtime `registry/image@sha256:<64 lowercase hex>`.
- `sourceSha`: exact reviewed 40-character source commit.
- `pathMap`: every absolute source string mapped to its container destination,
  including unchanged absolute paths as explicit identity mappings.

Use `/opt/oncall/plugins/livex-gcp-readonly` for the GCP plugin and
`/opt/oncall/plugins/livex-oncall-reports` for the report plugin. Preserve the
reviewed `plugins.allow`, report plugin `enabled` setting and
`config.agentProfiles` selection; map both `plugins.load.paths` entries exactly.
Use `/home/node/.openclaw/workspace` for the persistent instruction workspace, `/opt/oncall-skills/skills`
for the shared skills root, `/opt/google-cloud-sdk/bin/gcloud` for `gcloudPath`,
`/opt/google-cloud-sdk` for paging `sdkRoot`, `/usr/bin/python3` for Python,
`/home/node/.config/gcloud` for SDK config, and `/repos/<name>` for each checkout.
Map other legitimate paths explicitly. No prefix substitution is performed.
The private repository inventory is never committed. The tool preserves every supplied binding; it never invents inventory.

Slack `allowFrom` and channel `users` must match the plugin's allowed sender.
The reviewed snapshot must include the routed account and matching channel
restrictions. Invalid pins, unresolved Mac paths, missing mappings/bindings,
and identity conflicts fail preparation. Review the output against the source;
only the documented fields may differ. This offline check does not replace
native schema validation or prove authorization against the running VM.

## Build reviewed bytes only

Use a clean, reviewed commit containing this package. Set these operator inputs;
angle-bracket placeholders below must be replaced, never used literally:

```sh
export SOURCE_SHA='<reviewed-40-character-commit>'
export FORK_IMAGE='<reviewed-fork-image>@sha256:<digest>'
export SDK_IMAGE='<reviewed-google-cloud-cli-stable-image>@sha256:<digest>'
export BUILD_TAG='<local-runtime-tag>'
export PRIVATE_ROOT='<absolute-private-release-root>'
umask 077
mkdir -p "$PRIVATE_ROOT"
git archive "$SOURCE_SHA" > "$PRIVATE_ROOT/source.tar"
mkdir "$PRIVATE_ROOT/build"
tar -xf "$PRIVATE_ROOT/source.tar" -C "$PRIVATE_ROOT/build"
cd "$PRIVATE_ROOT/build"
python3 agent-skills/scripts/library.py validate
# Build the base from this same archive, if it has not been built yet.
# Use a local tag first; publish only through your approved registry workflow.
docker build --build-arg GIT_COMMIT="$SOURCE_SHA" \
  --build-arg OPENCLAW_EXTENSIONS="codex,slack" -t '<fork-base-tag>' .
# Resolve the approved base's registry digest and set FORK_IMAGE to that digest.
docker build -f deploy/gcp-vm/Dockerfile --build-arg FORK_IMAGE \
  --build-arg SDK_IMAGE --build-arg SOURCE_SHA -t "$BUILD_TAG" .
```

Select `codex,slack` when building the base. These opt-in plugins and their
runtime dependencies are otherwise pruned from the image. Include any additional
opt-in plugins required by the reviewed configuration.

The wrapper copies both LiveX source plugins to `/opt/oncall/plugins`. The
report plugin's local `node_modules` links to the same base's `/app` package for
public OpenClaw SDK exports and `/app/node_modules/zod` for its declared runtime
dependency. No separate dependency install or version substitution occurs.
The build checks SDK export resolution and the exact declared Zod version; a
base missing these assets fails the build. Keep the base and wrapper on the
same reviewed source commit, including the report-profile SDK and registry.

Never build from the working tree or include `.env`, private settings, generated
runtime files, or local credentials in the context. Review the archive's tracked
contents first. For release builds, both base images must be digest pinned and
architecture-compatible Debian images; the resulting image is released by immutable digest too. Debian
apt packages can change between builds: digest-pin the **result**, retain it for
rollback, and record source/base/SDK digests in your private release record.
Publishing is a separately authorized operator action; no push is implied here.

The SDK source path is verified in Google's [stable image Dockerfile](https://github.com/GoogleCloudPlatform/cloud-sdk-docker/blob/master/stable/Dockerfile)
(`COPY /usr/lib/google-cloud-sdk`); verify the chosen digest retains that layout.
The full SDK is copied because paging imports `googlecloudsdk`, not just a CLI
shim. The Dockerfile makes the public runtime files readable by uid 1000, even
when archive extraction uses a restrictive umask. The build validates the library and exports only the oncall skill profile
plus its referenced shared dependencies. `/opt/oncall-skills/skills-lock.json`
and `/opt/skills.sha256` record its bytes. Compare the previous release's selected
skill bytes and manifest with this image **before** approving path mapping to
image skills. A source revision change is not an automatic skill upgrade approval.

**Optional local build check:** A private Docker Bake file can pass the base
build result to the wrapper through `contexts = { forkbase = "target:base" }`
and `FORK_IMAGE = "forkbase"`. Keep `SDK_IMAGE` digest pinned and select
`codex,slack` in the base target. This builds both reviewed Dockerfiles in one
graph without publishing an intermediate image. Record the source archive hash,
SDK digest, build metadata, base/runtime image IDs, and smoke-test results.
These local images are build evidence, not published releases. Do not pass a local
image ID to `prepare.py`; installation requires the reviewed runtime
`name@sha256:digest` reference. See [Docker Bake target contexts](https://docs.docker.com/build/bake/contexts/).

## Prepare and install (Gateway stays stopped)

After obtaining the reviewed runtime digest, put it in settings and prepare:

```sh
python3 deploy/gcp-vm/prepare.py --source "$PRIVATE_ROOT/snapshot.json" \
  --settings "$PRIVATE_ROOT/settings.json" --output "$PRIVATE_ROOT/prepared"
```

The output must not exist. It is private mode 0700; files are 0600. No existing
state is overwritten or published. Review `prepared/openclaw.json` and the source
hash/path map in `prepared/release.json`. On the VM, choose an absolute private
release directory and create the mounted directories as uid/gid 1000:

```sh
export RELEASE_DIR='<absolute-vm-release-directory>'
export STATE_DIR="$RELEASE_DIR/state"
export SDK_STATE_DIR="$RELEASE_DIR/gcloud"
export REPOS_DIR='<absolute-reviewed-repository-snapshot-parent>'
export RUNTIME_ENV_FILE='<absolute-private-runtime-env-file>'
export OPENCLAW_IMAGE='<released-runtime-image>@sha256:<digest>'
export COMPOSE_FILE='<absolute-reviewed-package-path>/compose.yaml'
sudo install -d -m 0700 -o 1000 -g 1000 "$STATE_DIR" "$SDK_STATE_DIR"
sudo install -m 0600 -o 1000 -g 1000 '<transferred-prepared-openclaw.json>' "$STATE_DIR/openclaw.json"
sudo install -d -m 0700 -o 1000 -g 1000 "$STATE_DIR/workspace"
sudo install -m 0600 -o 1000 -g 1000 '<reviewed-archive>/livex-agents/workspaces/oncall/AGENTS.md' "$STATE_DIR/workspace/AGENTS.md"
```

Compare the previous approved workspace instructions before installing the archived
AGENTS.md; do not silently replace customized operational instructions.

Keep these nonsecret Compose variables in a private release env file or export
them for every command; use `docker compose --env-file <release-env> ...` when
loading from a file. Provision the separate mode-0600 runtime env file via your
secret manager/operator workflow. It supplies the env names referenced by the
snapshot (Gateway token, separately provisioned Slack bot/app tokens). No secret
values belong in Compose, the build, settings, examples, or Git. Restrict runtime
environment overrides: do not supply credential-file overrides or user gcloud
credentials. SDK state starts empty and remains writable for gcloud metadata
account cache/config. `/repos` is one read-only parent mount; provision each exact
reviewed checkout at the mapped path/pin. Use self-contained clones with their Git
objects, not relocated worktree pointers. Make them readable and owned by uid 1000
so Git's ownership check passes; the container mount remains read-only. Verify
that each approved commit exists with `git -C <path> cat-file -e '<commit>^{commit}'`.

```sh
docker compose run --rm --no-deps cli config validate
docker compose run --rm --no-deps cli models auth login --provider openai --method device-code --agent oncall
docker compose run --rm --no-deps cli exec-policy show --agent oncall
docker compose run --rm --no-deps cli approvals get
docker compose run --rm --no-deps --entrypoint node cli \
  /opt/oncall/preflight.mjs --config /home/node/.openclaw/openclaw.json --check
```

CLI has its own bridge networking and no dependency on Gateway: these commands
work while Gateway is stopped. Device-code login is a one-time interactive login
as service uid 1000; full OpenClaw state (SQLite, agent auth, sessions, workspace
artifacts) persists under the state directory. A fresh VM has fresh history unless
a stopped-state migration is separately approved. Host exec approvals live in
SQLite, not just JSON; restored state may impose `deny`. Inspect the selected
state's effective policy before the pilot. Fresh host defaults may be full/off;
review changes explicitly, never silently select YOLO. Tool allowlists do not
bound native shell commands to the GCP wrapper. The production read-only boundary
is attached-SA IAM plus `/repos:ro`; Codex sandbox still permits workspace writes.

Fix the plugin's configured project and exact attached SA email. Do not run
`gcloud auth login`, activate a keyfile, or mount a laptop gcloud directory.
Grant only the read role required for selected logs (normally Logs Viewer;
private logs require a separately reviewed role). API enablement, VM access
scope, metadata reachability from Docker, attached identity, IAM and outbound
Google/OpenAI/Slack connectivity remain live validation requirements. `--check`
performs network token/log-read checks without login; it is **not offline proof**.

## Authorized cutover and private access

Only after explicit cutover authorization, stop the old Gateway first. Maintain
exactly one active Slack Gateway. Verify source/target account routing and caller
restrictions, repository pins, effective exec policy, and fresh-session skills
before the pilot; do not test by sending unsolicited Slack messages.

```sh
docker compose up -d gateway
docker compose ps
curl -fsS http://127.0.0.1:18791/healthz
```

Startup runs existing networked `preflight.mjs --check` then the native Gateway.
Only host `127.0.0.1:18791` is published; no Docker socket is mounted. Container
`lan` is required for bridge forwarding. Keep the cloud firewall SSH-only.
From an authorized workstation, use explicit target inputs:

```sh
export PROJECT='<project-id>' ZONE='<zone>' INSTANCE='<instance-name>'
gcloud compute ssh "$INSTANCE" --project "$PROJECT" --zone "$ZONE" -- \
  -N -L 18791:127.0.0.1:18791
```

Open `http://127.0.0.1:18791`; retain Gateway token/device approval protections.
Health only proves listening. Native config validation, metadata preflight,
model login, skill discovery and an explicitly authorized pilot remain required.

## Update and rollback

Before update, record the current digest/config/skill manifest and stop Gateway.
Back up the **entire stopped state** and SDK state into protected storage:

```sh
docker compose stop gateway
sudo tar --numeric-owner -cpf "$RELEASE_DIR/stopped-backup.tar" \
  -C "$RELEASE_DIR" state gcloud
sudo chmod 0600 "$RELEASE_DIR/stopped-backup.tar"
```

Use timestamped fresh release/backup directories in practice. Build and review
new archived bytes/digests, prepare to a new directory, compare skills/config,
then explicitly install approved config into stopped state. Change
`OPENCLAW_IMAGE` to the reviewed new digest; repeat stopped-state validation and
policy checks, then manually `docker compose up -d gateway` when authorized.

For rollback, stop the new Gateway; preserve its state for diagnosis. Point
`STATE_DIR` and `SDK_STATE_DIR` at a **new** protected directory restored from
the matching stopped backup, restore the matching config/Compose release,
and select the previous immutable image digest. For example:

```sh
docker compose stop gateway
export RESTORE_DIR='<new-empty-absolute-restore-directory>'
sudo install -d -m 0700 "$RESTORE_DIR"
sudo tar --numeric-owner -xpf "$RELEASE_DIR/stopped-backup.tar" -C "$RESTORE_DIR"
export STATE_DIR="$RESTORE_DIR/state" SDK_STATE_DIR="$RESTORE_DIR/gcloud"
export OPENCLAW_IMAGE='<previous-runtime-image>@sha256:<digest>'
docker compose run --rm --no-deps cli config validate
# Repeat effective-policy and network preflight checks above before authorized start.
docker compose up -d gateway
```

Image rollback alone is insufficient after state/schema changes. Backups contain
plaintext OAuth material and must be handled as credentials. Never concurrently
run old/new releases against one state directory or Slack account.

## Offline checks and deployment acceptance

```sh
python3 -B -m unittest discover -s deploy/gcp-vm -p 'test_*.py'
python3 -B -m unittest discover -s livex-agents/plugins/livex-gcp-readonly -p 'test_logging_page.py'
sh -n deploy/gcp-vm/start.sh
```

The package tests preserve both plugin load paths and the report selection,
check source entrypoints, and exercise the image's dependency-linkage command
against temporary base-package fixtures (including incompatible-base failures).
These checks do not build an image or exercise a VM. Before cutover, verify the
built image, Linux Codex binary, native plugin loading and skill discovery. Then
run the metadata read check and an authorized Slack pilot: a new alert selects
`oncall`, an allowed caller receives a response, an unauthorized caller cannot
read GCP logs, and a follow-up resumes the same investigation after restart.
Compare routing, streaming, disabled background services, repository pins, model,
permissions, and instruction/skill hashes with the reviewed source snapshot.

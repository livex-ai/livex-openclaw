# LiveX agent layout

This package keeps agent role instructions in separate workspaces:

```text
livex-agents/
├── workspaces/oncall/       Existing configured investigation role
├── workspaces/debugger/     Inactive diagnosis-role instructions
├── workspaces/qa/           Inactive verification-role instructions
├── plugins/                Shared evidence-tool implementations
├── config/                 Source configuration templates
├── scripts/                Configuration and startup helpers
└── tests/role-replays.md    Offline specialist-role packets
```

The template registers only `oncall` and selects `workspaces/oncall`. The
[debugger](workspaces/debugger/AGENTS.md) and [QA](workspaces/qa/AGENTS.md)
instructions are inactive sources: they add no registrations, tools, callers,
schedules, automatic handoffs or runner access. Their [offline replay
packets](tests/role-replays.md) do not establish live activation or execution.
This repository relocation does not reconfigure or restart any deployment.

## Existing deployment source-path cutover

Keep the previous checkout available until a separately authorized deployment
switch is verified. Updating an existing checkout in place can remove `oncall/`
while a running Gateway still holds those source paths.

1. Record the current workspace, plugin load paths, startup/helper paths and local
   settings. Preserve the configured agent/account IDs, bindings, credentials,
   selected skill release and state directory. Ignored `oncall/config/local.json`
   is local operator work; do not discard it with the old source directory.
2. Prepare a narrow patch pointing the oncall workspace at the new checkout's
   `livex-agents/workspaces/oncall` and replacing only the corresponding plugin
   path with `livex-agents/plugins/livex-gcp-readonly`. Preserve every unrelated
   entry in `plugins.load.paths`; that array is replaced as a whole by a patch.
   Update operator launchers and helper references to the new checkout. Recreate
   local settings under `livex-agents/config/local.json` with the same approved
   values and reviewed path changes; no new credentials are required.
3. Validate the narrow patch with the existing configured CLI's dry-run and
   configuration validation. Do not apply the full profile to perform this
   relocation: it also replaces bindings, tool settings and other arrays.
4. During a separately authorized stopped-Gateway switch, apply the reviewed
   paths and use the existing startup procedure. Verify the intended agent,
   skills and evidence-tool source before retiring the previous checkout.

For rollback, stop the Gateway through its owning operator workflow, restore the
recorded workspace/plugin/launcher/local-setting paths and start from the retained
previous checkout. Keep credentials, skill selection, bindings and state unchanged.
These are manual operator steps; this source relocation executes none of them.

The optional [investigation catalog](investigation-memory.md) adds scoped memory
retrieval and completed-record publication when separately enabled. It is off by
default. No escalation writes or QA runner integration are included. Keep existing
cron state unchanged.

# Shared skill source

The four oncall skills and their supporting files are maintained in
[agent-skills/](../agent-skills/README.md). The oncall template loads that source
through `skills.load.extraDirs`; the existing oncall skill list stays the same.
Configuration rendering verifies the central manifest before publication.

For an existing deployment, use the central library migration instructions.
Do not apply the full template just to change a skill path. Preserve and compare
old workspace copies before removing precedence conflicts. No running Gateway
or personal Desktop skill is changed by this source migration.

# Oncall agent configuration

This package configures one native OpenClaw agent named `oncall`. OpenClaw routes
Slack channel mentions to it and keeps its thread history in the native session
store. Native Codex App Server runs the triage or investigation. No second agent
loop is added.

The profile enables the read-only log and repository plugin. Logs use one
configured project and caller. Repository access stays disabled until an operator
adds approved repository bindings. The profile exposes bounded evidence reads and
qualified bot review reactions; separate message sends and generic shell execution
are not in the agent tool allowlist. The Codex harness requires its execution
policy for startup. That setting does not grant production writes.

## Investigation concurrency

The dedicated oncall profile sets `agents.defaults.maxConcurrent` to `5`. This
sets the shared main-lane capacity: up to five independent Slack thread
investigations can run at once; additional requests queue. Runs in the same
session/thread remain serialized. This is a Gateway-wide default, so applying the
profile to a mixed Gateway also affects other agents using the main lane.

More concurrent investigations increase model, Cloud Logging, and host load.
Provider/account quotas and other runtime limits still apply. This setting does
not fix queued delivery-capability expiry or excessive pagination reaching an
investigation's execution deadline.

Changing this template does not update an existing deployment. Preserve a private
configuration backup and, during a separately authorized configuration change,
use the configured CLI to update only this path rather than applying the full
profile. Set `OPENCLAW_COMMAND` to the existing configured CLI executable or
wrapper before running these commands:

```sh
"$OPENCLAW_COMMAND" config get agents.defaults.maxConcurrent
"$OPENCLAW_COMMAND" config set agents.defaults.maxConcurrent 5 --strict-json --dry-run
"$OPENCLAW_COMMAND" config set agents.defaults.maxConcurrent 5 --strict-json
"$OPENCLAW_COMMAND" config validate
"$OPENCLAW_COMMAND" gateway call diagnostics.lanes --params '{}' --json
```

With the default hybrid reload mode, this single-path change hot reloads without
a Gateway restart and can immediately admit waiting work. Verify that the main
lane reports `maxConcurrent: 5`; explicit reload-off settings or unrelated
configuration changes need their own operator handling.

## Prepare local settings

Copy `config/local.example.json` to the ignored `config/local.json`. Set the five
absolute paths for your host. Set `gcloudAccount`, `project`, and `slackSenderId`
to the approved existing identity and scope. Do not place tokens in this file.
`openclawCommand` must name the configured OpenClaw executable or wrapper for the
intended state directory. The renderer neither creates nor copies credentials.

The existing Gateway must already have a usable Codex model/authentication setup
and Slack Socket Mode credentials. The profile inherits authentication from the
`main` agent. Agent workspaces and histories are separate, but credentials and
filesystem access can remain shared. An agent is logical separation, not a host
security boundary.

## Review and apply

Run from the checkout root:

```sh
python3 -B livex-agents/scripts/config.py render --output livex-agents/generated/openclaw.patch.json
livex-agents/scripts/validate-config.sh
livex-agents/scripts/apply-config.sh
```

The two shell scripts render the template again. They do not apply edits made to
`generated/openclaw.patch.json`. For an edited patch, use the configured CLI
wrapper directly instead of those scripts:

```sh
OPENCLAW_COMMAND='/absolute/path/to/configured-openclaw-wrapper'
"$OPENCLAW_COMMAND" config patch --file livex-agents/generated/openclaw.patch.json --dry-run --json
"$OPENCLAW_COMMAND" config patch --file livex-agents/generated/openclaw.patch.json
```

Use the same executable as `openclawCommand` in local settings. Review the
rendered patch before apply. It is a dedicated oncall Gateway profile.
OpenClaw merges objects, replaces arrays, and deletes paths with `null`. In
particular, `bindings`, `plugins.allow`, and `plugins.load.paths` are replaced.
Preserve any required unrelated entries in the reviewed configuration before
using this profile on a mixed Gateway. Global defaults and tools are also part
of the profile. Do not apply it blindly to an unrelated installation.

The scripts call the native `config patch` command. Validation runs first. Native
OpenClaw owns state admission, secret resolution, backups, and publication. The
scripts do not read the credential store, start the Gateway, or send a Slack
message. Follow the CLI's state-ownership and restart instructions after apply.

Slack routing uses the `default` account and every channel accessible to that
app. Each request requires an explicit mention from the configured caller. This
does not join channels or grant access to private channels. Direct messages and
bot triggers are disabled. Progress uses the native transport with one compact
progress surface. Native task cards, individual tool-call rows, commentary and
narration are disabled. Review markers follow the shared skill's provenance,
outcome and opt-out rules; a checkmark means reviewed—no new action. Recovery and
incident closure require their separate evidence.

## Verification

```sh
python3 -B -m unittest discover -s livex-agents/scripts -p test_config.py
node --import ./scripts/tsx.mjs livex-agents/scripts/test_config_native.mts
```

These tests cover rendering, fixed identity inputs, credential-free publication,
and validation before apply. Native configuration validation also requires the
installed plugins and the intended local state. Offline tests do not establish
live Slack delivery or production access.

## Rollback

Before apply, keep a protected copy of the current configuration using the native
OpenClaw backup workflow. Restore that reviewed configuration through OpenClaw's
supported configuration commands. Restore original bindings and plugin lists
when they were replaced. Do not delete authentication, sessions, or plugin state.
Restart only when the operator authorizes it and the CLI requires it.

## GCP VM deployment

Use the [VM deployment package](../deploy/gcp-vm/README.md) for a private container
runtime, attached Google service account, agent-scoped Codex sign-in, configuration
checks, and state-aware rollback. Deployment is a separate operator action.

## Agent-owned report formatting

The tracked template loads `plugins/livex-oncall-reports` and explicitly assigns `oncall` to its `compact-v1` profile. This supplies its typed report schema and both current deterministic renderers; unconfigured agents retain ordinary output. Slack delivery and the existing catalog publication lifecycle remain shared. Configuration and local checks are documented in [the reporting plugin](plugins/livex-oncall-reports/README.md). Applying this template to a running operator installation remains a separate reviewed action.

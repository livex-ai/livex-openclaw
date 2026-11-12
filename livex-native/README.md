# LiveX on stock OpenClaw

This folder runs **LiveX Debugger** on unmodified OpenClaw.

| Part | Path | What it is |
| --- | --- | --- |
| Evidence plugin | `plugins/livex-gcp-readonly/` | Bounded Cloud Logging reads and source reads at approved commits |
| Debugger workspace | `agents/debugger/` | Agent instructions and workspace skills |
| Config fragment | `config/openclaw.fragment.json5` | Codex runtime, Debugger, Slack policy and the default channel route |
| Deployment | `deploy/` | Isolated DEV staging and test VM deployment with readiness and rollback |

## Setup

Use the OpenClaw CLI on Node 24.16+ and a running Gateway. Configure `gcloud`
with read access to the intended project.

1. Run `livex-native/scripts/setup.sh` to inspect the commands. Add `--apply`
   to install Codex, link the evidence plugin, and add `debugger` with its
   workspace. Sign in for that agent with
   `openclaw models auth login --provider openai --agent debugger`.
2. For local OnCall setup, create its workspace and install its skills
   using the steps below before merging the fragment. For Debugger-only local
   setup, omit the `agents.entries.oncall` entry. Merge the selected config
   from `config/openclaw.fragment.json5` into `~/.openclaw/openclaw.json`.
   Set the Slack bot and app tokens plus `GCLOUD_*`, `CLOUDSDK_CONFIG`,
   `GCP_PROJECT`, `SLACK_SENDER_ID` and `PYTHON_PATH` for the Gateway.
3. The fragment sets `debugger` as `agents.defaults.systemAgent` and the
   default Slack channel route. It requires a mention from `SLACK_SENDER_ID`.
   Channel-specific bindings can override the wildcard. In the Control UI,
   check the Codex and evidence plugins, then open **LiveX Debugger**. In an
   agent chat, `/status` shows the Codex runtime.

### Upgrade the earlier two-agent demo

The DEV/test installer replaces the earlier managed OnCall default with the
Debugger default. It preserves operator-managed routes and persisted agent data.
For a manual config merge, review the old `oncall` entry and remove its
previously shipped Slack wildcard (`default` account, channel peer `*`) before
activating the new Debugger wildcard. Keep existing OnCall registrations and
agent data so explicit jobs, channels, and sessions can still use them. A
fresh install of the base Debugger PR creates only Debugger. Sign in and verify a Debugger turn before
switching live Slack traffic.

## Debugger flow

An authorized Slack mention loads `investigate-alerts` and reads the alert root
and relevant thread replies. Debugger scopes the workload, UTC window and
correlation IDs, then reads Cloud Logging or approved source as needed. If the
alert count disagrees with the logs, Debugger checks request outcomes across
severity levels before assigning priority. It replies in the same thread with
impact, priority or `Unknown`, evidence and a next action. Deeper investigations
use `debug` and `systematic-debugging`.

The Slack `message` tool can read messages and reactions. The evidence tools
are available only to a Slack turn from the configured sender in an allowed
channel. For a Control UI chat, use evidence supplied by the user. The skill
reports unavailable evidence and external case updates explicitly.

## Opt in to LiveX OnCall

`oncall` is **LiveX OnCall**, a separate workspace for explicitly assigned
alert triage and operational follow-up. Select it directly in the Control UI
or uncomment the exact-channel binding in the fragment and replace
`C0ONCALL` with the Slack channel ID. If that channel already has an exact
binding, replace it explicitly to select OnCall. Other Slack mentions and
the system default go to Debugger. Remove the exact-channel binding to return
that channel to Debugger.

The DEV/test installer registers this workspace and copies the native skill
files maintained in Debugger. An existing operator-managed `oncall` agent
requires an ownership decision before this install can replace its config.

For local setup, check `openclaw agents list` before merging the fragment. Use
an existing `oncall` entry only if it belongs to this native workspace. On a
clean local setup, run the following from the repository root:

```sh
native_dir="$(pwd)/livex-native"
openclaw agents add oncall --workspace "$native_dir/agents/oncall" --model openai/gpt-6-astra --non-interactive
for skill in investigate-alerts debug systematic-debugging verification-before-completion; do
  openclaw skills install "$native_dir/agents/debugger/skills/$skill" --agent oncall
done
openclaw models auth login --provider openai --agent oncall
```

The local install puts each skill and its supporting files inside the OnCall
workspace. A Slack turn still needs the configured sender and channel to use
the LiveX evidence tools. Follow-up ownership and any later checks must be
established in the thread or in authorized evidence.

## Stage on DEV or deploy to a test VM

`deploy/deploy.sh FULL_SHA` runs the official OpenClaw image with a readiness gate
and rollback. With `LIVEX_ON_DEV_VM=1`, it stages a separate Gateway on port
18789 with Slack disabled. The existing DEV bot keeps serving. Use a dedicated
test VM and its own app for Slack verification. See [deploy instructions](deploy/README.md).

The pinned OpenClaw 2026.10.5 image uses bounded, unpaged GCP log reads. Paging
and recovery are available on hosts that expose the V2 state API.

## Execution boundary

`agents.entries.<id>.tools.allow` governs OpenClaw-managed tools only.
Session permission modes and tool rules describe OpenClaw tools, and native
harnesses keep their own tool surface (`docs/gateway/permission-modes.md:19`).
Codex's native shell therefore still exists. With `tools.exec.mode: "ask"`, the
effective Codex policy is `sandbox: "read-only"`, `approvalPolicy: "on-request"`
and `approvalsReviewer: "user"`. Writes are blocked, and any request to step
outside the sandbox goes to a human
(`extensions/codex/src/app-server/config.test.ts:141-153`). `"deny"` and
`"allowlist"` fail Codex preflight, and `"auto"` hands approvals to model review.

The read-only sandbox blocks writes and network access but does not confine
reads to the workspace. The "don't read credentials" rule in `AGENTS.md` is
therefore advisory. Point `CLOUDSDK_CONFIG` at a directory that holds only a
narrowly scoped, read-only credential. A host exec-approvals file with a `deny`
or `allowlist` floor also makes Codex refuse turns
(`extensions/codex/src/app-server/config.test.ts:854-935`); check it with
`openclaw approvals get --gateway`.

## Install mode

The script uses a linked install because OpenClaw loads a plugin's TypeScript
entry (`index.ts`) only from source checkouts and linked or local paths. An
`npm-pack:` install needs compiled JavaScript (`dist/index.js`). Add a build step
before you package the plugin that way.

## Where data lives

The paths below are under `~/.openclaw`, the default state directory.

| Path | Contents |
| --- | --- |
| `openclaw.json` | Config: plugins, models, agents, channels |
| `state/openclaw.sqlite` | Shared state: plugin state (including this plugin's log-page cache), shared auth store, pairing |
| `agents/<id>/agent/openclaw-agent.sqlite` | The agent's sessions, transcripts and agent-local credentials |
| `agents/<id>/sessions/` | Legacy JSONL sessions only; `openclaw doctor --fix` imports them into SQLite |
| `agents/<id>/agent/codex-home/` | The Codex app-server home for that agent (`homeScope: "agent"`) |
| workspace dirs | Default `workspace/` for `main`. `debugger` uses `livex-native/agents/debugger`. OpenClaw writes per-install files there (`SOUL.md` on `agents add`, later `IDENTITY.md`, `memory/` ...); `agents/debugger/.gitignore` keeps them out of git |
| `skills/` | Shared skills for all agents. Per-agent skills live in `<workspace>/skills/` |
| `credentials/` | Channel credential files, such as WhatsApp auth. Many older files here are migrated into SQLite by `openclaw doctor --fix` |

## Add the next plugin or agent

- **Plugin:** copy `plugins/livex-gcp-readonly/` and give it a new
  `openclaw.plugin.json` `id`, a new `contracts.tools` list and a new
  `configSchema`. Then change `index.ts` to register your tools, and update the
  `files` list in `package.json`. Link it with
  `openclaw plugins install -l <dir> --force`, add the id to `plugins.allow`, and
  add the tool names to the agent's `tools.allow`.
- **Agent:** use `agents/debugger/` as a workspace example. Add the new agent
  entry and list only the skills and tools its role needs. Use an exact Slack
  channel binding for a role that should receive a specific channel.

## Compared with PR #1

PR #1 added `livex-agents/` and `agent-skills/`, and patched OpenClaw core in
121 files (about 8.1k lines) under `src/`, `extensions/` and `packages/`.

**Kept here:** the read-only GCP log and repository plugin with its tests, the
alert triage and diagnosis instructions, the four Debugger skills, and Codex as
the runtime. The plugin's `delegated-context.test.mjs` is intentionally omitted because it imports
OpenClaw core `src/`.

**Policy changes from PR head:**

| Setting | PR head | Here |
| --- | --- | --- |
| Codex `appServer.sandbox` | `workspace-write` | `read-only` |
| Codex `appServer.approvalPolicy` | `on-request` | `on-request` (same) |
| Effective Codex approvals reviewer | `auto_review` | `user`, a human, set by exec mode `ask` |
| Slack `message` actions | `read`, `react`, `reactions` | `read`, `reactions` |
| Slack agent `tools.profile` | `full` | `full` (same) |
| Slack agent `tools.exec.mode` | `auto` | `ask` |
| Global `tools.exec.mode` | `deny` | `ask`. `deny` fails Codex preflight for any agent without its own exec mode, such as `main` (`extensions/codex/src/app-server/config-options.ts:148-152`); an agent's own mode replaces the global one (`config-exec-approvals.ts:33-41`) |
| `agents.defaults.authInheritance` | `main` | not set. It is an upgrade-only credential-store owner that falls back to the legacy data owner, else `main` (`src/agents/legacy-inherited-auth-dir.ts:9-14`) |
| Heartbeats | default (every `30m`, to `systemAgent`) | same. With `systemAgent: debugger`, Debugger receives the configured heartbeat. Set `agents.defaults.heartbeat.every: "0m"` to turn them off |
| Shared skills (`skills.load.extraDirs`) | `${SHARED_SKILLS_ROOT}` | not set; skills live in each agent's workspace |
| `debugger` `tools.exec.mode` | `deny` (PR example) | `ask`; `deny` fails Codex preflight |
| `debugger` `permissionModeDefault` | `read-only` | dropped; not in main's config schema |
| `debugger` `tools.profile` | `full` | `full` (same) |

### Parity with PR #1

The deployed non-core config is ported, so the Slack bot behaves like PR #1's
"LiveX Debugger" except where it needs core code.

| PR #1 behavior | Here |
| --- | --- |
| Slack config: mention required, one allowed user, DMs off, no ack or typing reactions, thread replies, task-card progress | ✓ `channels.slack`, `messages` |
| Default Slack route and system agent | Both use `debugger` |
| Agent names and identity ("LiveX Debugger", "LiveX Reporting · Debugger") | ✓ |
| Global tool floor: minimal profile, elevated off | ✓ |
| Codex as runtime, same `appServer` home scope | ✓, but sandbox `read-only` and exec `ask` (PR #1: `workspace-write` and `auto`) |
| `react` message action | ✗ dropped on purpose; only `read` and `reactions` |
| Shared-skills directory | ✗ replaced by per-agent workspace skills |
| Report cards, priority colors, Resolved badge | ✗ needs core (Slack block patches) |
| In-place report edits, amendments, linked sync | ✗ needs core |
| Investigation memory and trends | ✗ needs core (`slack_investigation_record`) |
| Read-only default for reply sessions (`permissionModeDefault`) | ✗ not in main's schema |
| Slack usage footer | Off by default |
| Queued-turn channel identity | ✗ needs core |
| Delegated requester context for sub-agents | ✗ needs core (`delegated-context`) |

**Dropped:**

| Dropped | How it could come back |
| --- | --- |
| Slack report cards and in-place report edits (the `livex-oncall-reports` plugin, plus Slack block and edit patches in `extensions/slack`) | A channel-reply plugin that renders cards through the Slack plugin's public send API. In-place edits need an upstream "edit own reply" hook in the Slack plugin |
| Investigation memory and catalog (`livex-investigations`, `slack_investigation_record`, `investigations.md`) | A tool plugin that stores records in plugin state (`openKeyedStoreV2`) and exposes lookup and record tools. Pre-turn history injection needs an upstream context hook |
| VM deploy pipeline (`deploy/gcp-vm/`) | Replaced by the much smaller `deploy/` here (test VM, official image, no source build). A production pipeline can live in an ops repo |
| About 8k lines of core patches (memory-core, Slack dispatch, agent tool context, Codex usage projection, session lineage) | Upstream PRs, one generic hook per need. One example is `runtime.agent.session.withDescendantSessionRead`, which the plugin's `child` recovery uses when the host provides it |

Without that hook, `/livex-gcp-recover child ...` is refused with a clear
message. Recovery in the same thread still works.

## Checks

From `plugins/livex-gcp-readonly/`, on Node 24 or later (Node 20 cannot load the
`.ts` operation module):

```sh
node --test *.test.mjs
python3 -B -m unittest -v test_logging_page.py
```

The Gateway itself needs Node 24.16+ or 26.1+; older Node 24 builds are
refused at startup (`node:sqlite` TEXT truncation, nodejs/node#61954).

### Verify on a throwaway Gateway

Run the setup and deployment checks on an isolated state directory and port.
Use `openclaw config validate`, `openclaw agents bindings`, and
`openclaw skills check --agent debugger` to confirm the default route and four
skills. Verify model sign-in for `debugger` before attempting a Slack smoke.
An authorized Slack test should show a scoped GCP read and a threaded reply
from Debugger. Verify the tool trace for an all-severity request-outcome check
when an alert count disagrees with the logs.

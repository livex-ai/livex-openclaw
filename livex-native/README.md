# LiveX on stock OpenClaw

This folder shows LiveX running on unmodified OpenClaw. It has three parts:

| Part | Path | What it is |
| --- | --- | --- |
| Tool plugin | `plugins/livex-gcp-readonly/` | `livex_gcp_logs_read` (Cloud Logging) and `livex_repository_read` (pinned source), both read-only |
| Agent workspaces | `agents/oncall/`, `agents/debugger/` | Each has `AGENTS.md` instructions plus its skills in `skills/` |
| Config fragment | `config/openclaw.fragment.json5` | Enables the plugins, makes Codex the runtime for `openai/*` models, defines the `oncall` and `debugger` agents |

## Agents

| Agent | Role | Skills | OpenClaw tools (`tools.allow`) |
| --- | --- | --- | --- |
| `oncall` (LiveX On-call) | Triage Slack alerts: urgency, error summaries, trends, investigations | `investigate-alerts`, `debug`, `systematic-debugging`, `verification-before-completion` | `read`, `skills_read`, `message` (actions `read`, `reactions`), `livex_gcp_logs_read`, `livex_repository_read` |
| `debugger` (LiveX Debugger) | Deep diagnosis of one issue: cause, deployed revision, next action | `debug`, `systematic-debugging`, `verification-before-completion` | `read`, `skills_read`, `livex_gcp_logs_read`, `livex_repository_read` |

Both run on Codex with `tools.exec.mode: "ask"`, `elevated` off, and
`fs.workspaceOnly`. The fragment sets `agents.ownership: "explicit"`, which a
roster of more than one agent needs.

`scripts/setup.sh` ties them together. Nothing outside this folder changes.

## 5-minute flow

You need the `openclaw` CLI (Node 24+) with a running local Gateway, and
`gcloud` signed in to an account that can read the project's logs.

1. **Run the setup script.** It prints the commands first:

   ```sh
   livex-native/scripts/setup.sh           # dry run, prints commands
   livex-native/scripts/setup.sh --apply   # runs them
   ```

   It installs `@openclaw/codex`, links the LiveX plugin
   (`openclaw plugins install -l`), and runs `openclaw agents add` for `oncall`
   and `debugger`. Then
   sign in yourself, because the login is interactive:
   `openclaw models auth login --provider openai`.
2. **Merge the config.** Copy the keys from `config/openclaw.fragment.json5` into
   `~/.openclaw/openclaw.json`, and set the `GCLOUD_*`,
   `CLOUDSDK_CONFIG`, `GCP_PROJECT`, `SLACK_SENDER_ID` and `PYTHON_PATH`
   variables for the Gateway. The script never restarts the Gateway; config
   changes apply on the next hot reload.
3. **Route Slack.** `agents add` pins the previous sole agent (often `main`) as
   `agents.defaults.systemAgent.agentId`, and unbound Slack traffic goes there.
   Send Slack to `oncall` with `openclaw agents bind --agent oncall --bind slack`
   (the default Slack account; `slack:*` covers every account). To give
   `debugger` one dedicated Slack channel, add a peer binding to
   `openclaw.json`, as in the commented example at the end of the fragment:
   `{ agentId: "debugger", match: { channel: "slack", peer: { kind: "channel", id: "C…" } } }`.
   A peer binding wins over the Slack-wide binding
   (`src/routing/resolve-route.ts:334-350`), so only that channel goes to
   `debugger`.
4. **Control UI, Plugins.** Check that `codex` and `livex-gcp-readonly` are
   enabled, and fill in any plugin config fields that are missing.
5. **Control UI, Agents.** Open `oncall` or `debugger`. You can also choose
   **New agent** and point it at `livex-native/agents/<id>`.
6. **Control UI, Automations.** Add a schedule that sends `oncall` a prompt.
   Scheduled runs have no Slack requester, and the GCP tools are offered only
   to a Slack turn from `allowedSenderId` in an allowed channel, so scheduled
   runs cannot use them on stock main. Use schedules for non-GCP tasks, or add
   an automation-caller option to the plugin config later.
7. **Verify.** In a chat with the agent, `/status` shows `Runtime: OpenAI Codex`.
   If the chat already has a session, run `/new` first.

## How to use the debugger

- Open `debugger` from the Control UI **Agents** page and chat with it, or give
  it one dedicated Slack channel with a peer binding (step 3). Do not run
  `agents bind --agent debugger --bind slack`. That binds the whole Slack
  account, not one channel (`docs/cli/agents.md:228-234`), and would send every
  alert to `debugger`.
- Thread replies keep the parent channel as the routing peer, so they follow
  the same binding. A runtime conversation binding on a thread (for example a
  focused session) overrides config bindings
  (`extensions/slack/src/monitor/message-handler/prepare-routing.ts:89-104`).
- Both LiveX tools answer only Slack turns from `allowedSenderId` in an allowed
  channel (`plugins/livex-gcp-readonly/core.mjs:594-601`, `repository.mjs:152-159`).
  A debugger chat in the Control UI therefore gets no GCP or repository
  evidence. Use it from its dedicated Slack channel for real diagnosis.
- Nothing hands work from `oncall` to `debugger` automatically. Copy the alert
  thread or identifiers into the debugger conversation yourself. Native
  `subagents` delegation would be a separate change.

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
| workspace dirs | Default `workspace/` for `main`. `oncall` uses `livex-native/agents/oncall`. OpenClaw writes per-install files there (`SOUL.md` on `agents add`, later `IDENTITY.md`, `memory/` ...); `agents/oncall/.gitignore` keeps them out of git |
| `skills/` | Shared skills for all agents. Per-agent skills live in `<workspace>/skills/` |
| `credentials/` | Channel credential files, such as WhatsApp auth. Many older files here are migrated into SQLite by `openclaw doctor --fix` |

## Add the next plugin or agent

- **Plugin:** copy `plugins/livex-gcp-readonly/` and give it a new
  `openclaw.plugin.json` `id`, a new `contracts.tools` list and a new
  `configSchema`. Then change `index.ts` to register your tools, and update the
  `files` list in `package.json`. Link it with
  `openclaw plugins install -l <dir> --force`, add the id to `plugins.allow`, and
  add the tool names to the agent's `tools.allow`.
- **Agent:** `agents/debugger/` is the worked example. It was made by copying
  `agents/oncall/` (including `.gitignore`), rewriting `AGENTS.md`, and keeping
  only the skills it needs. Its fragment entry is `agents.entries.debugger`, and
  `setup.sh` adds it to `AGENT_IDS`. For a new agent, do the same: copy a
  workspace, add an `agents.entries.<id>` block without `workspace`, add the id
  to `AGENT_IDS`, and run `setup.sh --apply` (or
  `openclaw agents add <id> --workspace <dir> --model openai/gpt-6-astra --non-interactive`).

## Compared with PR #1

PR #1 added `livex-agents/` and `agent-skills/`, and patched OpenClaw core in
121 files (about 8.1k lines) under `src/`, `extensions/` and `packages/`.

**Kept here:** the read-only GCP log and repository plugin with its tests, the
on-call triage instructions, the debugger role (active here; inactive in PR #1),
the four skills, and Codex as the runtime. The
plugin's `delegated-context.test.mjs` is intentionally omitted because it imports
OpenClaw core `src/`.

**Policy changes from PR head:**

| Setting | PR head | Here |
| --- | --- | --- |
| Codex `appServer.sandbox` | `workspace-write` | `read-only` |
| Codex `appServer.approvalPolicy` | `on-request` | `on-request` (same) |
| Effective Codex approvals reviewer | `auto_review` | `user`, a human, set by exec mode `ask` |
| `oncall` `message` actions | `read`, `react`, `reactions` | `read`, `reactions` |
| `oncall` `tools.profile` | `full` | not set; the exact `allow` list applies |
| `oncall` `tools.exec.mode` | `auto` | `ask` |
| `debugger` `tools.exec.mode` | `deny` (PR example) | `ask`; `deny` fails Codex preflight |
| `debugger` `permissionModeDefault` | `read-only` | dropped; not in main's config schema |
| `debugger` `tools.profile` | `full` | not set; the exact `allow` list applies |

**Dropped:**

| Dropped | How it could come back |
| --- | --- |
| Slack report cards and in-place report edits (the `livex-oncall-reports` plugin, plus Slack block and edit patches in `extensions/slack`) | A channel-reply plugin that renders cards through the Slack plugin's public send API. In-place edits need an upstream "edit own reply" hook in the Slack plugin |
| Investigation memory and catalog (`livex-investigations`, `slack_investigation_record`, `investigations.md`) | A tool plugin that stores records in plugin state (`openKeyedStoreV2`) and exposes lookup and record tools. Pre-turn history injection needs an upstream context hook |
| VM deploy pipeline (`deploy/gcp-vm/`) | A separate ops repo or a Claw bundle; it never needed to live in this tree |
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

### Smoke test on a throwaway Gateway

Run twice (oncall alone, then both agents with Slack routing) against an isolated `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` on
a non-default port (Node 24.22.2), following the 5-minute flow. The build was
OpenClaw 2026.10.5 at `d18c1dc` with local PR #1-style core changes, not a
clean `main` build, so it proves the flow and config shape rather than the
no-core-patch claim:

| Step | Result |
| --- | --- |
| `plugins install -l <plugin dir> --force` | Linked; held disabled until configured |
| `agents add oncall ...`, then `agents add debugger ...` on a fresh state | Both created; a `main` agent was created too, with `ownership: "explicit"` and `systemAgent: main`. Unbound Slack traffic would go to `main`, hence step 3 |
| Merge fragment, `config validate` | Valid; applied by hot reload, no restart; both `agents add` workspaces kept |
| `agents bind --agent oncall --bind slack`, plus the debugger peer binding | Valid; `agents bindings` lists both |
| Route probe with the real router (`resolveAgentRoute`) | Debugger channel and its threads go to `debugger` (`binding.peer`); other channels and DMs go to `oncall` (`binding.account`) |
| `plugins enable livex-gcp-readonly` / `codex` | Both loaded and activated, no diagnostics; both LiveX tools registered |
| `skills check --agent oncall` / `--agent debugger` | Four and three skills ready and visible; others excluded by each allowlist |
| One turn each for `oncall` and `debugger`, without OpenAI sign-in | Ran through the Codex app-server, passed exec `ask` preflight, stopped at `401 Unauthorized` |
| Workspaces after the turns | `SOUL.md`, `IDENTITY.md` and `USER.md` written into both; all gitignored |

Not covered: a signed-in model reply, real GCP calls, Slack delivery.

# Oncall agent configuration

This package configures one native OpenClaw agent named `oncall`. OpenClaw routes
Slack channel mentions to it and keeps its thread history in the native session
store. Native Codex App Server runs the investigation. No second agent loop is
added.

The profile enables the read-only log and repository plugin. Logs use one
configured project and caller. Repository access stays disabled until an operator
adds approved repository bindings. The profile exposes read tools only; generic
shell execution is not in the agent tool allowlist. The Codex harness requires
its execution policy for startup. That setting does not grant production writes.

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
python3 -B oncall/scripts/config.py render --output oncall/generated/openclaw.patch.json
oncall/scripts/validate-config.sh
oncall/scripts/apply-config.sh
```

The two shell scripts render the template again. They do not apply edits made to
`generated/openclaw.patch.json`. For an edited patch, use the configured CLI
wrapper directly instead of those scripts:

```sh
OPENCLAW_COMMAND='/absolute/path/to/configured-openclaw-wrapper'
"$OPENCLAW_COMMAND" config patch --file oncall/generated/openclaw.patch.json --dry-run --json
"$OPENCLAW_COMMAND" config patch --file oncall/generated/openclaw.patch.json
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
bot triggers are disabled. Progress uses native Slack task cards. Individual
tool-call rows are disabled to keep the card compact.

## Verification

```sh
python3 -B -m unittest discover -s oncall/scripts -p test_config.py
node --import ./scripts/tsx.mjs oncall/scripts/test_config_native.mts
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

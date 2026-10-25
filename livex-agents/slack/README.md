# Dedicated oncall Slack app

These files prepare a separate Slack app for the existing `oncall` agent.
They do not create an app, install credentials, apply configuration, or restart the Gateway.

## Create the app

1. Create a Slack app from `app-manifest.json` in your workspace.
2. Generate an app-level token with `connections:write`.
3. Install the app to obtain its Bot User OAuth Token.
4. Invite the bot to each channel it must serve.

The manifest requests mentions, public and private channel history, channel information, user information, and message replies.
It does not request DMs, slash commands, reactions, or user-token access.
A wildcard policy covers channels available to this app. It does not join channels or grant access to other private channels.

Change both manifest display names to rename the bot. Change the account name in the cutover template if needed.
Keep the account ID and agent ID `oncall`. Routing uses those IDs.

## Store credentials locally

Use `slack-oncall.example.json` as the file shape. Fill its values only in your private state directory:

```text
${OPENCLAW_STATE_DIR}/secrets/slack-oncall.json
```

Use the new app token for `appToken` and its bot token for `botToken`.
Keep the directory private with mode `700`. Give the file mode `600` and ownership by the Gateway user.
Use a regular file. Do not put tokens in this repository, chat, or command arguments.
Do not overwrite an existing credential file without checking its owner and use.

The patch uses OpenClaw file SecretRefs. `/appToken` and `/botToken` select the fields.
Keep `${OPENCLAW_STATE_DIR}` literal in the provider path. The Gateway resolves it from its environment.
The empty example values are not usable credentials.

## Prepare the manual cutover

First configure the native oncall agent with the current default Slack account. See [oncall setup](../README.md).
Set `OPENCLAW_COMMAND`, `OPENCLAW_STATE_DIR`, and, if needed, `OPENCLAW_CONFIG_PATH` as described in the [startup guide](../scripts/local-gcloud-startup/README.md).

The preparation helper supports the initial single-account setup:

- No named Slack accounts or `defaultAccount` override.
- No `slack-oncall` secret provider.
- One binding from Slack account `default`, channel peer `*`, to agent `oncall`.
- One authorized caller, shared by Slack and the GCP reader configuration.
- One enabled wildcard channel policy. Channel-specific overrides require manual reconciliation.

Other bindings are retained. Additional routes for the default Slack account require manual reconciliation before that account is disabled.
If the setup has changed, the helper stops for manual review.
It reads the configuration but does not resolve secrets or copy token values.
It creates two private patch files and refuses to overwrite an existing output directory.

Stop the Gateway in its owning terminal. Keep it stopped during preparation, review, and application.
From the repository root, run:

```sh
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
CUTOVER_DIR="$OPENCLAW_STATE_DIR/slack-oncall-cutover"
python3 -B livex-agents/slack/prepare-cutover.py \
  --config "$OPENCLAW_CONFIG_PATH" --output-dir "$CUTOVER_DIR"
```

Use a new output directory if that path already exists. Review both generated patches against the current configuration.
The source JSON templates show the intended changes. Do not apply them directly: their binding arrays contain only the example binding.
The helper fills the caller ID and copies unrelated bindings into the generated patches.

Apply the reviewed cutover:

```sh
"$OPENCLAW_COMMAND" config patch --file "$CUTOVER_DIR/account-cutover.patch.json" --dry-run --json
# Continue only after a successful dry run and review.
"$OPENCLAW_COMMAND" config patch --file "$CUTOVER_DIR/account-cutover.patch.json"
"$OPENCLAW_COMMAND" config validate --json
# Continue only when validation reports valid: true.
./livex-agents/scripts/local-gcloud-startup/start-gateway.sh
```

Verify an authorized mention and a follow-up in a joined channel. Check that both select agent `oncall` and account `oncall`.
Keep the old app installed until verification is complete.

The new account requires explicit mentions and the existing authorized caller.
DMs, implicit mentions, bot callers, introductions, and reactions remain disabled.
The patch disables the old default account. It preserves the old root credentials and conversation history.
It does not change the GCP project, caller checks, repository access, or agent tools.

## Roll back

Stop the Gateway. Review the generated rollback against the current configuration.
If bindings changed after cutover, reconcile them first. The rollback contains the bindings from preparation time.

```sh
"$OPENCLAW_COMMAND" config patch --file "$CUTOVER_DIR/rollback-account-cutover.patch.json" --dry-run --json
# Continue only after a successful dry run and review.
"$OPENCLAW_COMMAND" config patch --file "$CUTOVER_DIR/rollback-account-cutover.patch.json"
"$OPENCLAW_COMMAND" config validate --json
# Continue only when validation reports valid: true.
./livex-agents/scripts/local-gcloud-startup/start-gateway.sh
```

Rollback restores the default-account binding and removes the new account settings and secret provider.
The preserved root credentials become active again. Empty parent objects can remain.
The new Slack app and its private credential file remain installed but inactive in OpenClaw.
No history is moved or deleted. Do not revoke the old credentials while rollback is required.

Named accounts inherit root Slack settings. The oncall account overrides both tokens with file SecretRefs.
Its empty `userToken` prevents inheritance of a root user token. Its channel policy stays limited to the configured caller.
Account separation does not isolate the Gateway process or its filesystem credentials.

## Validation

Run the offline preparation tests:

```sh
python3 -B -m unittest discover -s livex-agents/slack -p 'test_*.py'
node --import ./scripts/tsx.mjs livex-agents/scripts/test_config_native.mts --slack-cutover
```

The tests check binding preservation, rollback, caller restrictions, token references, and private output permissions.
They do not create a Slack app or prove live message delivery.

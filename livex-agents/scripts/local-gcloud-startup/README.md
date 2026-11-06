# Local Gateway startup

This helper checks Google authentication and Cloud Logging access before it starts the Gateway.
It uses the installed `livex-gcp-readonly` configuration. It does not install the agent or create credentials.

First complete the [oncall configuration](../../README.md). Configure model authentication and Slack credentials separately.
Use Node.js supported by this OpenClaw checkout. Install `lsof` and make it available on `PATH`.

Set the paths for your installation:

```sh
export OPENCLAW_COMMAND='/absolute/path/to/openclaw-local.sh'
export OPENCLAW_STATE_DIR='/absolute/path/to/private-state'
export LIVEX_NODE='/absolute/path/to/node'
```

`OPENCLAW_COMMAND` must be an executable CLI or wrapper. It must use the same state and configuration as this helper.
This is the same command as `openclawCommand` in your local settings file.
`LIVEX_NODE` is optional when the correct `node` executable is on `PATH`.
The configuration defaults to `$OPENCLAW_STATE_DIR/openclaw.json`.
Set `OPENCLAW_CONFIG_PATH` to an absolute path only if your installation uses another file.

From the repository root, check access without starting the Gateway:

```sh
./livex-agents/scripts/local-gcloud-startup/start-gateway.sh --check
```

Then start it in the foreground:

```sh
./livex-agents/scripts/local-gcloud-startup/start-gateway.sh
```

The helper keeps port `18791`, loopback binding, token authentication, and Tailscale disabled.
If that port already has a listener, startup stops before authentication. The existing process remains unchanged.
Press **Ctrl-C** in the owning terminal to stop the Gateway.

The check discards token output. It reads at most one log entry using a random insert ID.
The configured account and project are explicit on each command. No log content is printed.
Network or permission failures stop startup. They do not start a sign-in loop.

If Google credentials need renewal, normal interactive startup opens the account-specific sign-in flow.
It uses `--no-activate` and does not update Application Default Credentials.
The `--check` mode and noninteractive runs never start sign-in.
The operator must complete consent. The script cannot grant IAM permissions.

Tests use synthetic commands and temporary state:

```sh
node --test livex-agents/scripts/local-gcloud-startup/preflight.test.mjs
```

No live Slack delivery or production log access is covered by those tests.

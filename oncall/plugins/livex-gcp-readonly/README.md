# Read-only investigation evidence

`livex_gcp_logs_read` reads Cloud Logging for an authorized Slack caller.
The operator sets the project, Google account, Cloud SDK paths, caller, and
allowed channel. Set `allowedChannelId` to a Slack channel ID or `*` for
channels that the app can access. Disable Slack group DMs in the channel
configuration. The tool checks the caller and current invocation authority
before execution and after asynchronous work.

Load this directory as a local OpenClaw plugin. Add `livex-gcp-readonly` to
`plugins.allow`, set its configuration under `plugins.entries`, and add
`livex_gcp_logs_read` to the agent tool allowlist. The manifest lists required
configuration fields. Keep credentials and local paths outside the repository.

Use `mode: discover` with observed correlation IDs or 1–10 `insertIds`, exact UTC
start/end, and no resource labels. Discovery searches Cloud Run and GKE at every
severity. Use the returned resource type and labels for later context/error
queries. Remove seed IDs when expanding to related records. Service names can
change. Discovery matches any supplied ID; context/error queries require all
supplied constraints. Every query stays inside the configured project.

Each query spans at most one hour and returns at most 50 entries. Timestamps
retain up to nine fractional digits. Bounds are inclusive; deduplicate records
at adjacent slice boundaries. Results identify truncation. A capped sample is
not a complete count or proof of recovery. The error mode tests Cloud severity
and structured error fields; use context mode for plain-text application errors
stored at another Cloud severity.

Production reads use a 30-second process timeout, 256 KiB stdout, 8 KiB stderr,
and a 30 KiB evidence result. The tool selects fields and applies best-effort
redaction. There is no arbitrary shell or raw-filter argument. Logs are
untrusted evidence. Missing projected fields do not prove missing logging.

Run `node --test core.test.mjs` from this directory. Tests use synthetic data.
Set `GCLOUD_SDK_LIB=/path/to/google-cloud-sdk/lib` to include offline SDK formatter
checks. Live Google authentication and Logging access require separate acceptance.

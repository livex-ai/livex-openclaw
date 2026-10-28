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

The paged reader keeps the authenticated SDK transport and decodes its raw JSON
response locally, avoiding protobuf decoder failures on boolean arrays in arbitrary
log payloads. Failed reads expose only reviewed stage/class labels and HTTP status,
never SDK exception bodies.

Run `node --test core.test.mjs` from this directory. Tests use synthetic data.
Set `GCLOUD_SDK_LIB=/path/to/google-cloud-sdk/lib` to include offline SDK formatter
checks. Live Google authentication and Logging access require separate acceptance.

## Resume a log query

Set `paging.enabled` to `true` and configure its absolute `pythonPath` and
`sdkRoot`. The tool calls one fixed Python helper through the installed Cloud
SDK. It uses the configured account. It does not copy or expose tokens.
With paging disabled, the bounded gcloud reader remains available.

Follow `nextCursor` with `{ "cursor": "..." }` alone, even after an empty page.
Buffered rows are returned before the next cloud page. `windowExhausted` refers
only to the exact filter and time slice at retrieval. Cover each alert-hour
slice; a page limit does not complete an investigation.

Native V2 storage keeps receipts and opaque backend cursors. Scope includes
agent, Slack account, thread, session generation, caller, project, configured
Google account, and Cloud SDK configuration path. Identical
queries reuse retained evidence. Check `retrievedAt`; use `refresh: true` when
delayed ingestion or new evidence requires another read. Refresh cannot bypass
an unresolved attempt for the same query and continuation.

The cache retains at most 200 records. LRU eviction removes completed results
and consumed continuation pages, plus explicitly retired checkpoints. Pending
and failed attempts, unknown records,
and unconsumed checkpoints remain protected. Reservation and eviction are atomic.
Completing a child page and consuming its parent is also atomic. Existing
receipts use a committed same-scope successor to establish consumption.

An evicted initial query is fetched again with `reusedEvidence: false`.
An evicted old cursor fails explicitly; it never silently restarts a scan.
Keep the latest checkpoint. If all entries are protected, admission stops
before a cloud read. Failed or uncertain attempts are not replayed silently.
The cache bound limits resident evidence, not total investigation pages.
Conversation history is separate and is not evicted. Codex owns investigation
planning and completion; the plugin adds no agent loop or case database.

### Recover an unfinished read

Recovery is a direct human text command handled before the LLM. It requires the
configured Slack sender, current owner authority, the allowed channel, and the
original canonical Slack thread session. Use it in that thread (mention the bot
if the channel requires it). Native slash routing, DMs, and custom/shared session
bindings are rejected because they do not prove the original receipt scope.
No command starts a cloud read, changes production, or retries a customer operation.

1. `/livex-gcp-recover list` lists up to 20 current-scope receipt IDs and statuses.
   Continue with `list <nextOffset>`. Use `list legacy` (and `list legacy <nextOffset>`)
   for receipts created before cloud-identity binding. Lists contain no logs,
   private cursors, query selectors, or credentials.
2. `/livex-gcp-recover inspect <receipt>` returns its saved query window, status,
   and exact `receiptHash`. Use `inspect legacy:<receipt>` for an old-format receipt.
3. `/livex-gcp-recover retry <receipt> <receiptHash>` explicitly authorizes one
   new read of that exact current-identity query. **The original outcome may still
   be unknown; approval accepts a possible repeated Cloud Logging read.** It does
   not declare the original operation successful or recovered. The next matching
   tool query (or original cursor continuation) consumes this approval once.
4. For an old-format receipt, use
   `/livex-gcp-recover restart-legacy legacy:<receipt> <receiptHash>` instead.
   This explicitly restarts only its saved bounded query window under the current
   configured cloud identity. Old logs and private cursor state are not reused.
   Prior coverage remains uncertain; deduplicate repeated evidence. A legacy
   continuation restarts from the beginning rather than claiming to resume it.

A changed receipt requires another inspection. Approval and replacement are atomic
in the same bounded SQLite namespace, so recovery works even when all 200 slots are
occupied. Each attempt has an owner and counter; a late old completion cannot settle
the replacement. The latest operator decision retains the previous receipt hash,
status, and attempt metadata; history does not grow in this cache. A further failure
needs another explicit approval. There is no automatic retry, arbitrary expiry,
blanket clear, or fabricated resolution. Conversation history remains separate.

To abandon a finished page's unconsumed continuation, inspect it and use
`/livex-gcp-recover retire-checkpoint <receipt> <receiptHash>` (or `legacy:<receipt>`).
This records deliberate abandonment and permits later LRU reclamation. It never
claims the query was exhausted or the checkpoint consumed. Retirement requires a
verified completed checkpoint and refuses unresolved or malformed dependent reads;
settle those exact child receipts first. Old cursors fail visibly;
no scan restarts automatically. Unknown/malformed records and other threads stay
protected. Historical same-query attempts are recovered serially: one explicit
approval permits only its selected read; unselected unknown receipts remain
protected. A second approval waits while an approved or active retry remains.
Each legacy attempt gets its own current-identity receipt, so existing results
and other legacy attempts cannot be overwritten. The bounded prior-attempt audit
retains its receipt hash/id, owner call ID, reservation time, status, attempt
counter and bounded failure summary; no growing attempt history is created.
If cloud credentials/configuration change again, receipts belonging to
the previous identity remain inaccessible under the new identity; restore that
configuration for scoped operator recovery rather than adopting its evidence.

Run `node --test *.test.mjs` and `python3 -B -m unittest -v test_logging_page.py`.
The offline replay covers seven hours, exact early seeds, dense pages, fractional
timestamps, empty pages, and recovery evidence. Run the native loader check from
the repository root with:

```sh
node --import ./scripts/tsx.mjs livex-agents/plugins/livex-gcp-readonly/loader-validation.mts
```

The check uses isolated state
and performs no cloud reads.

## Read approved source

`livex_repository_read` reads operator-approved local repositories at pinned
commits. Configure `repositories` with IDs, canonical paths, and full commit
SHAs. The default list is empty. Add the tool to the agent allowlist explicitly.
Keep the actual repository inventory private.

The tool lists, searches, and reads bounded Git objects. It does not run scripts
or hooks, read dirty/untracked files, or assume a commit matches production.
It blocks protected files, symlinks, and submodules. It reports the inspected
commit and applies best-effort redaction. Caller and invocation checks match
the log tool. Run `node --test repository.test.mjs` for its offline checks.

## Link to log evidence

Results include `logsExplorerUrl` for the exact project, filter, and inclusive
UTC bounds. Link meaningful report text to this URL. Do not invent a Console
link from a guessed service or incomplete filter.

If redaction changes a selector, or the URL exceeds the output budget, the
result includes `logsExplorerLinkUnavailableReason`. Cached results can gain a
link without another cloud read or a stored-history rewrite. Rows and cursors
remain intact. Run `node --test evidence-links.test.mjs paging.test.mjs`.

# livex-investigations-lite

Per-issue investigation memory for the LiveX debugger agent on stock OpenClaw.
It replaces PR #1's `livex-investigations` catalog with a small plugin built only
on public plugin APIs: no core patches, no files on disk, no second agent.

## What it does

1. **Remember.** The debugger's final reply carries a `LIVEX_ALERT_SUMMARY_V2`
   envelope; the plugin stages a case from it automatically (see below), so the
   model does not have to call anything. `investigation_record` remains for
   additional distinct issues. Either way the note is saved only after Slack
   confirms the final reply was delivered.
2. **Recall.** When an alert thread starts, a `before_prompt_build` hook looks for
   stored cases matching the incoming alert text and prepends a short
   "prior cases" block (at most 3 cases, 1200 characters by default) with only
   signature, latest priority and resolved state, seen count, last-seen date and a
   short trend; free-text findings and titles are never injected. The agent can
   call `investigation_lookup` with a signature or free text for the full detail.
   Only occurrences recorded in the current Slack channel are shown, in the block
   and in lookups (this matters when `allowedChannelId` is `"*"`). Notes carry the
   channel they were written in and are filtered the same way (legacy notes without
   a channel are hidden); when any occurrence is hidden the title is replaced by
   the signature.
3. **Trend.** Each saved occurrence adds deterministic notes: recurrence number
   and days since the previous occurrence, priority changes, resolved/reopened,
   and an optional model-written trend note. Notes and occurrences are bounded.

## Data model

Store namespace `cases` (keyed store V2, `evict-oldest`, `maxCases` default 500),
one value per signature key `sig:<sha256 prefix>`:

```
{ signature, title, firstSeen, lastSeen, totalOccurrences,
  occurrences: [{ at, priority, resolved, finding,
                  thread: { channel, threadTs, replyTs? } }],   // newest 10
  notes: [{ text, channel }] }                                  // newest 5
```

Every string is sanitized (control characters, `<` `>` and lookalike brackets
`‹›«»〈〉⟨⟩˂˃《》❮❯⟪⟫` removed, whitespace collapsed) and capped: title 120, finding
240, note 200 characters. The canonical signature is never truncated (it is bounded
by 4 parts x 8 tokens) and the key hashes the full form, so long signatures that
differ only at the end stay distinct cases; only the displayed copy is shortened
to 160 characters.
Re-investigating in the same Slack thread refines that occurrence in place.

## Signature normalization

A signature is `service | operation | error class` (up to four parts). It is
canonicalized deterministically:

1. Unicode NFKC, lowercase.
2. Remove URLs, UUIDs, ISO dates/timestamps and clock times.
3. Split into tokens on every non-alphanumeric character.
4. Drop tokens that are all digits, hex of 8+ characters, or contain two or more
   digits (ids, pod suffixes, request ids, HTTP codes). `s3` and `oauth2` survive.
5. Each part keeps at most 8 tokens, joined by `-`; parts are joined with ` | `.
6. Fewer than 2 tokens in total is refused as too generic.

So `Checkout-API | create  order | Upstream TIMEOUT 504` and
`checkout api | create order | upstream timeout` are the same case.

## Matching

Deterministic, no embeddings. An exact canonical signature wins. Otherwise a stored
case matches when at least 2 of its signature tokens, and at least 60% of them,
appear in the query/alert text. Ties sort by newest `lastSeen`, then key. This is
a recall hint, not proof of identity: the agent must verify against current evidence.

## Auto-record from the summary envelope

The final reply starts with `LIVEX_ALERT_SUMMARY_V2`, one JSON line, a blank line
and the report. The `reply_payload_sending` hook is registered with
`priority: 100` (hooks sort higher first, `src/plugins/hooks.ts:178-188`;
`api.on(name, handler, { priority })` per `PluginHookRegistrationOptions`,
`src/plugins/hook-types.ts:204-208`), so it reads the payload before
`livex-slack-summary` turns it into a card. It never modifies the payload and
always returns `undefined`.

Parsing is strict: the first line must be exactly the V2 marker (a V1 marker or a
misplaced marker records nothing), the second line must be a JSON object with only
the known keys `title`, `signature`, `priority`, `provisional`, `resolved`
(optional), `summary`, `nextAction`, `owner`, `checkedWindow`, `evidenceUrl`
(optional), all required ones present and within their length bounds. Anything
else records nothing. Mapping: `signature` to the case signature (then normalized
like the tool's), `priority` and `resolved` directly (`resolved` defaults to
false), `finding` = `summary` (bounded to 240 chars), `title` = `title`, no trend.
Records already staged by `investigation_record` in the same run are kept; on a
shared signature the tool's record wins. The usual tag-and-commit-on-`message_sent`
flow then saves it.

## Diagnosing a silent run

Log lines go to the process console (`console.info`/`console.warn`, so they reach
container stdout), each prefixed `[livex-investigations-lite]`, one per decision and
never with content: `record staged: source=envelope|tool`, `reply tagged`, `case
committed`, `message_sent ignored: <reason>`, and `record dropped: <reason>` with
reason one of `sender-gate`, `channel-gate`, `agent-gate`, `no-run-id`,
`run-mismatch`, `superseded by a newer run`, `send-failed`, `expired`,
`no-message_sent`. `final reply has no V2 envelope` means the final text did not
carry the marker. The plugin does not use `api.logger` because the host's subsystem
logger filters by console level; the gateway's own lines come from the same console.

Run binding trade-off: the prompt-build `runId` (Codex harness) and the reply
`runId` (dispatcher) are separate sources that may name a run differently. An
envelope record is bound to the reply's own `runId` by construction. A tool-staged
entry whose `runId` differs from the reply's is still adopted when no newer prompt
build has been observed for the session and the entry is inside `pendingTtlMinutes`;
a newer prompt build, an expiry, or a missing `runId` on the reply drops it.

## Failure visibility

A V2-marked envelope that cannot be recorded logs one warning with only a fixed
reason (`summary envelope not recorded: invalid envelope: missing key`, `...: signature too generic`, and so on; field names at most, never values). Text without the V2 marker stays silent.

Every store open, read or commit failure is logged with `console.warn`
(see above for why not `api.logger`): `[livex-investigations-lite] store
<open|read|commit> failed: <error message>`, no stored content. A commit logs at
info: `case committed sig=<8 hex> occurrences=<n>`. Hooks still never throw into a
reply.

The store is opened lazily inside hooks and tools, never in `register()`:
`openKeyedStoreV2` calls `assertRuntimeCurrent` at open
(`src/plugin-state/plugin-state-store.ts:432`; wiring at
`src/plugins/registry-runtime.ts:114-124,187-190`), which throws during `register()`
because the record is not yet active. During hook dispatch the loaded record is in
the active registry, so `isPluginRecordActive` is true
(`src/plugins/registry-lifecycle.ts:400-410,494`) and no authority argument is
needed; tool reads additionally pass the invocation authority.

## Publish-after-delivery (best effort)

| Step | Hook / tool | Effect |
| --- | --- | --- |
| observe | `before_prompt_build` | Records the turn's `runId` per session (before any sender gate); a different `runId` than the one that staged a pending entry discards it |
| stage | `investigation_record` | In-memory pending entry keyed by the thread's session key, stamped with the session's current `runId` |
| envelope | `reply_payload_sending` (`kind: "final"`, Slack), priority 100 | Parses the V2 summary envelope and stages a record bound to the session's current `runId` (see Auto-record) |
| tag | `reply_payload_sending` (`kind: "final"`, Slack) | Tags the entry only when the event `runId` equals the staging `runId` (and `senderId`, when present, is the allowed sender); never alters the payload |
| commit | `message_sent` with `success: true` | Writes the case; records `messageId` as the reply ts when it is a Slack ts |

Behaviour and limits you should know:

- `message_sent` is fire-and-forget. A crash between delivery and the hook, or a
  Gateway restart while a record is pending (it is memory-only), loses the note.
  Delivery failures never commit and never affect the reply.
- A staged record is bound to the turn that staged it. Tool contexts carry no
  `runId`, so `before_prompt_build` records the session's current `runId` and the
  record is stamped with it. A turn with a different `runId` (including one by
  another sender that fails the sender gate) discards the old pending record, and a
  final reply from a different run cannot tag it. A turn that stages and then ends
  without a final reply therefore never leaks into a later reply.
- `before_prompt_build` can run again inside the same run (Codex app-server, retry
  and compaction paths). The record is discarded only when the `runId` differs
  from the recorded one. A missing `runId` never discards anything (a missing id
  cannot prove a new turn), and a pending entry staged under a known `runId` is not
  tagged by an event without one. `tag()` requires a non-empty `runId` equal to the staging one, so two turns that both lack a `runId` can never be matched; the entry is dropped instead.
- On stock Slack the `message_sent` event carries `sessionKey` but no `runId`
  (`extensions/slack/src/message-sent-hook.ts` builds it without one). Correlation
  there is the session key plus the `runId` check at tag time (the
  `reply_payload_sending` event does carry it). If a `runId` is present on both
  events they must also match.
- A failed final delivery discards the tagged record; there is no keep-for-retry,
  because a later unrelated successful send could otherwise commit it.
- `messageId` is absent for media replies. A multi-part reply commits on its first
  confirmed part (the reply ts is that part's); a later failed part changes
  nothing, and if the first part fails, the record is dropped and later parts do
  not commit it.
- Pending entries still expire after 30 minutes (`pendingTtlMinutes`).
- Two concurrent turns in one thread are told apart by `runId`; the later turn
  discards the earlier turn's pending record.

## Access and safety

- Tools are created only when the caller is Slack, in `allowedChannelId`, sent by
  `allowedSenderId`, with live `assertInvocationCurrent`, and the session is an
  enabled agent's Slack thread (same gate as `livex-gcp-readonly`, plus the
  session check). The tool-side store opens bound to that invocation authority.
- The prompt hook runs only for enabled agents' Slack thread sessions in allowed
  channels and only when `senderId` is present and equals `allowedSenderId`
  (a missing sender fails closed for injection). `reply_payload_sending` and
  `message_sent` additionally refuse a present `senderId` that is not the allowed
  sender. Alert text is used only for matching and is never echoed into the prompt.
- The injected block is delimited `<<<PRIOR_CASES ... PRIOR_CASES>>>` and states it
  is untrusted data. Stored text cannot contain `<` `>` or lookalike brackets, newlines or control
  characters, so it cannot close the block or start a new instruction line.
- `investigation_lookup` is marked `resultContentSource: "network"` because stored
  text originated from model summaries of untrusted evidence.

## Privacy

Case summaries (signature, title, one-sentence findings, Slack channel and
thread/reply timestamps) persist in the Gateway's plugin state database on the
Gateway host, in clear text, until evicted or the store is cleared. No secrets are
stored or configured. Do not put customer identifiers in findings; the tool
description tells the agent not to include ids.

## Configuration

See `openclaw.plugin.json`. Required: `allowedChannelId`, `allowedSenderId`.
Optional: `agents` (default `["debugger"]`), `maxCases`, `maxOccurrencesPerCase`,
`maxNotesPerCase`, `pendingTtlMinutes`, `seenBeforeMaxCases`, `seenBeforeMaxChars`.
The prompt hook needs `plugins.entries.livex-investigations-lite.hooks` to allow
conversation access and prompt injection (see `WIRING.md`).

## Tests

`node --test core.test.mjs index.test.mjs` (no network, no host; a fake keyed store and a stubbed
SDK entry module). Host-level proof against a real Gateway is a separate step.

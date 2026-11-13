# livex-investigations-lite

Per-issue investigation memory for the LiveX debugger agent on stock OpenClaw.
It replaces PR #1's `livex-investigations` catalog with a small plugin built only
on public plugin APIs: no core patches, no files on disk, no second agent.

## What it does

1. **Remember.** After the debugger finishes an alert thread it stages a short
   case note with `investigation_record`. The note is saved only after Slack
   confirms the final reply was delivered.
2. **Recall.** When an alert thread starts, a `before_prompt_build` hook looks for
   stored cases matching the incoming alert text and prepends a short
   "prior cases" block (at most 3 cases, 1200 characters by default). The agent
   can also call `investigation_lookup` with a signature or free text.
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
  notes: [string] }                                             // newest 5
```

Every string is sanitized (control characters and `<` `>` removed, whitespace
collapsed) and capped: signature 160, title 120, finding 240, note 200 characters.
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

## Publish-after-delivery (best effort)

| Step | Hook / tool | Effect |
| --- | --- | --- |
| stage | `investigation_record` | In-memory pending entry keyed by the thread's session key |
| tag | `reply_payload_sending` (`kind: "final"`, Slack) | Marks the entry as belonging to the final reply; never alters the payload |
| commit | `message_sent` with `success: true` | Writes the case; records `messageId` as the reply ts when it is a Slack ts |

Behaviour and limits you should know:

- `message_sent` is fire-and-forget. A crash between delivery and the hook, or a
  Gateway restart while a record is pending (it is memory-only), loses the note.
  Delivery failures never commit and never affect the reply.
- On stock Slack the `message_sent` event carries `sessionKey` but no `runId`
  (`extensions/slack/src/message-sent-hook.ts` builds it without one), so
  correlation is by thread session key. If a `runId` is present on both events they
  must match. A new turn in the thread discards any still-pending record.
- `messageId` is absent for media replies, and a multi-part reply commits on its
  first confirmed part; the reply ts may then be that first part's.
- Pending entries expire after 30 minutes (`pendingTtlMinutes`). A failed delivery
  keeps the entry until then so a retried delivery can still confirm it.
- Two concurrent turns in one thread are not distinguished.

## Access and safety

- Tools are created only when the caller is Slack, in `allowedChannelId`, sent by
  `allowedSenderId`, with live `assertInvocationCurrent`, and the session is an
  enabled agent's Slack thread (same gate as `livex-gcp-readonly`, plus the
  session check). The tool-side store opens bound to that invocation authority.
- The prompt hook runs only for enabled agents' Slack thread sessions in allowed
  channels (and for the allowed sender when the host supplies one). Alert text is
  used only for matching and is never echoed into the prompt.
- The injected block is delimited `<<<PRIOR_CASES ... PRIOR_CASES>>>` and states it
  is untrusted data. Stored text cannot contain `<` or `>`, newlines or control
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

`node --test *.test.mjs` (no network, no host; a fake keyed store and a stubbed
SDK entry module). Host-level proof against a real Gateway is a separate step.

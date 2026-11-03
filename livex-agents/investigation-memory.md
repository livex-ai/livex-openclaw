# Local investigation memory and catalog

This optional capability belongs to the LiveX investigations plugin and uses
the existing Slack transport and native memory owner. It does not create a second investigator. It is disabled unless an operator
selects the agent explicitly, grants its named catalog tool, and reviews activation.
Creating a catalog file alone does not enable indexing or Slack access.

## Storage and flow

The canonical human-readable file is `<agentDir>/investigations.md`, outside Git.
For the isolated local oncall runtime, `agentDir` resolves under
`$OPENCLAW_STATE_DIR/agents/oncall/agent`. The derived native search index shares
that directory's `openclaw-agent.sqlite` with sessions and other durable state.
Never delete that database or its WAL/SHM sidecars to reset memory.

The catalog retains the tracker fields Task, Status, What we did last (dated
history), Waiting on, PRs, Slack threads, Jira tickets and Last updated, plus Issue
ID and Issue signature. Link arrays stay separate; the first verified investigation
link remains canonical. Last updated uses America/Los_Angeles with an offset and
changes only for a substantive update. Further observations remain in dated history.

1. The investigations plugin reads and validates the catalog during admitted Slack
   reply-turn preparation, before the investigator runs.
2. Native keyword memory finds candidates from this file only. The catalog owner
   verifies exact signatures, scope, links and meaningful deltas. Search similarity
   and a missing candidate cannot establish incident identity or complete history.
3. `slack_investigation_record` provides bounded lookup and stages validated
   per-issue facts with the exact final reply text. It cannot send or write directly.
4. Slack confirms the accepted final payload and authenticated permalink. The
   investigations plugin then locks, rereads, merges and atomically replaces the catalog.
   Progress, partial/uncertain delivery and another turn's final cannot publish.

Timestamp-only recurrence means persistence. Different signatures remain independent.
Historical ownership or holds require current evidence before reuse as a present
decision. Missing/corrupt/oversized history and failed persistence are visible;
explicit requests still receive a report. A successful Slack send and disk write
are separate effects: an unconfirmed write preserves the prior record and exposes
the gap rather than promising exactly-once publication across both systems.

## Proposed opt-in configuration

Review a diff against the existing resolved configuration; do not replace it with
this fragment. Replace the example absolute path with the selected agent's actual
`agentDir/investigations.md`. No live configuration is changed by this source file.

```json5
{
  plugins: {
    // Add livex-investigations and memory-core to the existing allow list.
    // Retain all current load paths; add the reviewed investigations plugin path.
    slots: { memory: "memory-core" },
    entries: {
      "livex-investigations": {
        enabled: true,
        config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
      },
      "memory-core": { enabled: true, config: { dreaming: { enabled: false } } },
    },
  },
  agents: {
    entries: {
      oncall: {
        // Add slack_investigation_record to the existing tools.allow list.
        memory: {
          search: {
            enabled: true,
            includeWorkspace: false,
            extraPaths: ["/absolute/operator/state/agents/oncall/agent/investigations.md"],
            sources: ["memory"],
            rememberAcrossConversations: false,
            experimental: { sessionMemory: false },
            provider: "none",
          },
        },
      },
    },
  },
}
```

`extraPaths` inherits additively: global and agent entries must resolve only to the
approved catalog. The adapter refuses broad workspace indexing, other extra paths,
transcripts, other memory owners and remote embedding providers. General
`memory_search`, `memory_get`, `intent` and `active-memory` need no new tool grants.
`includeWorkspace: false` affects memory indexing/search/get/watch; ordinary agent
instruction/bootstrap files have their existing independent loading policy.

The parser accepts an explicitly initialized empty version-1 catalog. A missing
file is uninitialized, never automatically replaced with an empty one. It contains
no historical investigations until reviewed records are imported or future
completed reports are recorded. Historical import is separate approval and work.
Bounds are 2 MiB, 2,000 issues and 100 dated entries per issue. Reaching a bound
is visible and preserves retained data; this feature performs no automatic purge.
Known credential patterns are rejected using the existing SDK redactor. That is
not a guarantee that arbitrary prose is safe; record concise sanitized facts only.

Existing installations using `plugins.entries.slack.config.investigationCatalog`
must use the [source-only discovery and Doctor migration](plugins/livex-investigations/README.md#upgrade-from-the-slack-owned-catalog).
The catalog bytes, path and tool name do not change.

## Activation prerequisites and rollback

Activation is a separately reviewed operator step. Do not start a second gateway
or a memory CLI against live state while the existing gateway owns it.

1. Finish candidate build, focused tests and review. Resolve any independently
   recorded startup/managed-preferences failure through its existing owner.
2. Review the candidate checkout and exact configuration diff. Preserve the active
   checkout, its uncommitted logging fix, pinned skills, configuration and launcher.
   If a candidate checkout is selected, its workspace instructions must be selected
   deliberately; retain or port the unrelated logging fix before switching its
   evidence-plugin source path. This feature does not perform that cutover.
3. Back up the configuration and catalog using the deployment's existing safe
   procedure. Stop the current gateway through its operator owner before changing
   the checkout/configuration or running a command that can open the same database.
4. Select the reviewed code and configuration. Validate it using the existing local
   launcher only after that launcher points to the reviewed candidate. A changed
   memory scope intentionally pauses an old broad index until an explicit rebuild.
5. With the gateway stopped and provider `none` verified, the existing CLI supports
   `openclaw memory index --agent oncall --force` and
   `openclaw memory status --index --agent oncall`. Use the deployment's isolated
   environment/launcher, not an ambient home. These are operator instructions;
   they were not run against live state during implementation.
6. Start exactly one gateway through the normal operator owner, then perform the
   separately approved controlled verification. Use a fresh investigation session
   so stable historical prompts are not silently rewritten.

For rollback, stop the candidate gateway first, restore the prior configuration
and launcher/code selection, and start one prior gateway. Preserve the catalog
and agent database. Disabling the optional catalog tool prevents new writes;
disabling the memory owner stops indexing. Do not remove retained investigation
records or reset conversation storage as a rollback shortcut.

## Compact report form

The `prepare_update` action accepts a bounded typed `report` with `title`, `priority`,
`summary`, `nextAction`, and `evidence` (`links`, optional `checkedWindow`/`note`).
The host validates and renders Title/Priority, Next action, Summary and Evidence;
there are no expanded repetitive Finding/Impact/Owner/Uncertainty sections. Optional
Known issue/Blocked/Resolved badges need supporting catalog/fact evidence. Model
priority never establishes verified-critical styling. Missing ownership, impact or
evidence remains unknown; supplied URLs must be grounded in the typed findings.

Legacy finalText input is an acknowledgement, never parsed for report content.
The host derives a compact report from the typed completed findings, so Markers
and Limits prose cannot break rendering. Return the current preparation's exact
canonical finalText; unrelated, silent, error or independent replies are not replaced.
Later invalid preparation clears the older stage. The catalog's ten fields, scope,
retention and confirmed-delivery write rules are unchanged. New instructions must
be selected deliberately on activation; stable existing session prompts are not
rewritten. No rollout is performed by these source changes.

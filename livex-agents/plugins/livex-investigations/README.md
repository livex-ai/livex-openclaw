# LiveX investigations

This plugin owns the LiveX investigation workflow: admission context, catalog lookup, staged findings, report preparation and catalog publication. Slack supplies admitted transport facts and confirmed delivery through the generic reply-turn contract. The agent-owned report plugin supplies the selected report format. No LiveX policy is registered on unconfigured agents.

The optional catalog remains disabled by default. Enable `plugins.entries.livex-investigations.config.investigationCatalog` with an explicit `agentId` to select its owner. The stable `slack_investigation_record` tool must also be granted by the existing tool policy. Records remain at `<agentDir>/investigations.md`; migration neither moves nor rewrites catalog or native SQLite bytes. See [investigation memory](../../investigation-memory.md) for native search restrictions, limits and activation prerequisites.

## Upgrade from the Slack-owned catalog

The new Slack schema rejects `plugins.entries.slack.config.investigationCatalog`. Doctor owns the one-time move to `plugins.entries.livex-investigations.config.investigationCatalog`; normal reads and Gateway startup do not rewrite configuration. Doctor cannot discover an external plugin absent from the old installation's load paths, so first prepare an explicit source-only discovery candidate with the reviewed checkout:

```sh
node --import ./scripts/tsx.mjs livex-agents/plugins/livex-investigations/prepare-upgrade.mts \
  --source /absolute/review/old-snapshot.json \
  --output /absolute/review/new-discovery-candidate.json
```

The command reads only the supplied source, appends this plugin's absolute path to the existing load paths and creates a new file with mode `0600`. It refuses an existing output, including the source itself. It does not infer a live configuration path, run Doctor, start a Gateway, modify catalog data or contact Slack.

An enabled legacy catalog with an existing nonempty plugin allowlist requires an explicit grant to the new owner. Review that change and add `--allow-plugin` to append only `livex-investigations`; this option is accepted only for an explicitly enabled legacy catalog. It never removes a deny entry or overrides an explicitly disabled destination. With no prior catalog selection, the bootstrap leaves it unconfigured.

Use the candidate OpenClaw Doctor in a separately prepared isolated review environment with the candidate configuration, then validate and review its resulting diff. The native acceptance command below exercises that same manifest discovery and setup migration against temporary synthetic state without invoking any Gateway. Do not point review commands at the running Gateway's configuration or state.

The setup migration:

- Moves only the legacy catalog settings and preserves explicit enabled/disabled choices, agent selection, unrelated plugin settings, load paths and arrays.
- Preserves equivalent tool access by appending `slack_investigation_record` to exact `slack` plugin-group allow/alsoAllow policies and to deny policies whose anchored `*` patterns match the former `slack` owner, including agent, provider, sandbox, subagent and Slack sender/channel/account scopes. Wildcard grants are not expanded. Unrelated policies stay unchanged.
- Refuses conflicting destination settings, invalid source settings and blocked activation before publishing any migration. Doctor retains the original configuration and reports a warning on failure.
- Is idempotent and leaves the canonical catalog path and file bytes unchanged. It does not silently enable native memory indexing or grant unrelated tools.

After isolated acceptance, deployment remains a separate operator decision. Retain the old source snapshot and matching code for rollback. Restore those together while the Gateway is stopped through its normal owner; retain catalog and native conversation state. Do not reverse the configuration key under the new strict Slack schema or run two Gateways against the same state.

## Source validation

From the repository root, with the reviewed Node toolchain and dependencies already available:

```sh
node --import ./scripts/tsx.mjs livex-agents/scripts/test_investigation_upgrade_native.mts
node scripts/run-vitest.mjs run --config test/vitest/vitest.livex-investigations.config.ts --maxWorkers=1
python3 -B -m unittest discover -s livex-agents/scripts -p 'test_config.py'
python3 -B -m unittest discover -s deploy/gcp-vm -p 'test_prepare.py'
```

The native fixture uses the actual bootstrap CLI, manifest loader, setup entry, Doctor compatibility sequence and strict configuration validator. It checks conflicting and disabled settings, policy and catalog-path preservation, idempotence, private output, refusal to overwrite and exact source-byte preservation. Container package fixtures exercise the Dockerfile's dependency links and reject an incompatible base without building or deploying an image.

### Follow up in an investigation thread

Ask for status to get an ordinary answer from the known evidence. Ask for a
deeper investigation to use the existing oncall skills. For explicit changes,
mention the bot in the original thread. Examples include “I’ll own this; make
it Medium” and “set next action to check retry logs only after approval.”
The model proposes the fields together. A scoped writer verifies the current
request, canonical case, Slack authorship and edited card. Unclear values or
unsupported wording require clarification. Ownership is accepted by the sender.

A queued update can show a short request acknowledgment before verification.
It does not assert success. The original report and case history are the
records of the verified change. An ambiguous target, stale case, or conflicting
replay cannot authorize an edit. Existing catalogs remain readable. Before
downgrading to a build without the optional priority fact, retain a compatible
catalog backup.

### Remember a trend comparison

In a bound case thread, a trend question can get one plain reply and a dated
observation in the existing case. Begin the comparison for that issue, then
exhaust the authorized errors-mode log queries for two disjoint, equal-duration
UTC windows. The plugin counts projected entries that contain the saved
operation and error on the matching service, using complete pages from the
same run and filter. An unsupported selector, incomplete read, or missing
case association leaves the comparison unsaved. Counts describe matching
log entries. They do not measure failed customers, rate or recovery.

After verified delivery the catalog appends both windows, counts, evidence
links and retrieval times. Scoped lookup exposes the most recent measured
window even after other case updates. No new investigation report or case is
created. Retain a catalog backup before a downgrade to a reader that predates
trend history.

# LiveX oncall report profiles

This code plugin owns the compact report form, evidence/ownership display checks, deterministic Slack projection, delivery-notice projection and legacy oncall card parser. It has no message-sending, catalog-writing or scheduling capability.

The tracked oncall configuration loads this directory and selects `compact-v1` for `oncall` through `plugins.entries.livex-oncall-reports.config.agentProfiles`. The manifest declares startup activation so an explicitly admitted plugin registers before Slack prepares a turn. Empty assignments register no profile. Unknown profiles and duplicate agent/channel claims are configuration errors. The model cannot choose a profile or a host module path.

The host binds the selected profile to prepared work. Queued replies and delivery warnings retain that selection. Slack still validates outgoing blocks/fallback, handles previews/readback/threading and returns receipts; its existing investigation owner saves the catalog only after confirmed complete visible delivery and a verified permalink. Catalog schema, file location, matching, locking and lifetime are unchanged.

The compact layout remains Title, Priority, Next action, Summary and Evidence. Both current card forms omit the decorative divider while retaining the attachment accent. The legacy parser preserves its existing LiveX bot/team/oncall/thread gates; ordinary prose and unconfigured agents keep their existing path. This extraction does not change acknowledgement routing.

## Local verification

From the repository root, use the qualified toolchain and repository wrappers:

```sh
node scripts/run-vitest.mjs run --config test/vitest/vitest.livex-oncall-reports.config.ts --maxWorkers=1
node scripts/run-tsgo.mjs -p livex-agents/plugins/livex-oncall-reports/tsconfig.json
```

Activation is a separate operator-reviewed change: load the matching host build and this plugin together, validate a backed-up configuration, then use the normal gateway lifecycle. Existing operator configuration, running gateways and Slack history are never modified by these sources or tests. Rollback restores the previous code/config pair; the catalog needs no migration. An enabled catalog without its required report profile reports a preparation error and never claims a successful save.

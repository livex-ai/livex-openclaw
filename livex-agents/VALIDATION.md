# Validation scope

The feature PRs record their focused test commands and results. A local test run
is evidence for that revision only. The scripts in this package do not activate
an installation or prove live Slack delivery.

Before deployment, render the supplied example, validate the intended native
configuration, and check caller restrictions, channel routing, tool discovery,
new-thread history, and same-thread follow-ups. Use an authorized synthetic
alert for live checks. Confirm that credentials and unrelated configuration are
preserved. Do not reuse production logs as public fixtures.

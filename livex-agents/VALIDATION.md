# Validation scope

The feature PRs record their focused test commands and results. A local test run
is evidence for that revision only. The scripts in this package do not activate
an installation or prove live Slack delivery.

Before deployment, render the supplied example, validate the intended native
configuration, and check caller restrictions, channel routing, tool discovery,
new-thread history, and same-thread follow-ups. Use an authorized synthetic
alert for live checks. Confirm that credentials and unrelated configuration are
preserved. Do not reuse production logs as public fixtures.

## Native agent packaging and inactive examples

Run the configuration, library and release tests independently from the checkout
root:

```sh
python3 -B -m unittest discover -s livex-agents/scripts -p 'test_*.py'
python3 -B -m unittest discover -s agent-skills/tests -p 'test_*.py'
python3 -B -m unittest discover -s deploy/gcp-vm -p 'test_*.py'
node --import ./scripts/tsx.mjs livex-agents/scripts/test_config_native.mts
```

The Python configuration checks render without a legacy prompt file, confirm that
only Oncall is registered, and check the inactive Debugger/Verifier fragments and
their selected skill bundles. Library tests exercise explicit and named-profile
exports, empty selection, invalid selection, hashes, dependencies and destination
preservation. These checks do not establish native schema validity or runtime
tool availability; use the native validator with installed dependencies for that
boundary and record any unavailable check explicitly.

Debugger and Verifier remain examples until separately reviewed and added to the
tracked template. Before activation, validate the resulting native configuration,
review inherited model/authentication and caller/plugin admission, and verify the
actual workspace, winning skills and available tools in a fresh isolated session.
The Verifier example has no runner: a request for fresh test execution is blocked,
not passed. Existing QA role instructions remain inactive.

Release tests cover offline packaging and activation behavior. Real Docker,
Gateway, VM and Slack checks require their own environment and authorization;
Python success must not be presented as live deployment proof.

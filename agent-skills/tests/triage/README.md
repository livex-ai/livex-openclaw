# Triage integration replay

Run `fixtures.json` offline with a fresh agent given only the exported oncall
skills and candidate workspace instructions. Treat all actions/results as
synthetic. Save output before comparing the rubric. Never contact production.

Acceptance: tracked accepted work needs no new action while health stays failing;
explicit full work continues both categories, hours and empty-page cursors;
newer holds override queued checks; a denied fresh read preserves unknown health
and exact blocker; original-operation recovery can reconcile only proven bot
outcomes, preserving human markers. Completed reports use the canonical header
and separate bold Finding, Action, Owner, Evidence fields. Missing Notion is a
recorded capability gap, never fabricated persistence or permission to add tools.

The older `report-format/` fixtures record the superseded October21 layout;
retain them as history, not the acceptance format for this source revision.

# Oncall skills

The oncall workspace contains four selected skills:

- `investigate-alerts`: scope, coverage, findings, and response rules.
- `debug`: discovery, correlation, source inspection, and recovery checks.
- `systematic-debugging`: hypothesis and evidence discipline.
- `verification-before-completion`: checks before final claims.

The first two skills are adapted for this agent's read-only tools. The selected
Superpowers 6.4.2 files retain their MIT licences and supporting files. Workspace
instructions define their production-read application. Desktop startup hooks and
the rest of the Superpowers bundle are not installed.

`../../skills/sources.json` records provenance and installed hashes. The renderer
verifies each main skill and its supporting files. Update the manifest after a
reviewed edit. Upstream hashes remain separate from installed adaptation hashes.

To add a skill, place its complete reviewed folder here and add its frontmatter
name to `agents.entries.oncall.skills`. Add its files and hashes to the manifest.
A skill does not grant tools or credentials. Review any new capability separately.
Do not place credentials, customer logs, or conversation history in this folder.

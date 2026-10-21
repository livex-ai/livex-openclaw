# Shared skill maintenance

Keep reusable skill content in this folder. Consumer workspaces contain their
role instructions and select a reviewed profile; they are not authoring copies.

Preserve runtime-specific tool and authorization contracts. Moving a skill does
not authorize changing its behavior. Keep upstream licenses, supporting files,
source versions, and current hashes. Store only material suitable for this public
repository. Never include credentials, personal account instructions, private
logs, service checkout paths, or incident histories.

Use the standard library scripts and tests described in README.md. Update
sources.json after an intentional file change. Validate complete directories,
not only SKILL.md. Test instruction changes with affected synthetic scenarios
and a fresh agent; structural checks do not prove model behavior or live access.

Export to a new revision directory. Do not replace an existing consumer copy,
change running agent configuration, or restart a Gateway as a side effect of
publishing skills. Report required consumer activation separately.

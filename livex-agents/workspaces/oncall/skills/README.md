# Shared skills

The canonical skill files now live in [agent-skills](../../../../agent-skills/README.md).
The oncall template loads that shared directory and selects its four existing
skill names. Keep this directory free of same-named skill copies: workspace
copies override the shared source. Agent instructions remain in `../AGENTS.md`.

Existing deployments need an explicit source-path cutover and fresh-session
discovery check. This repository change does not restart or reconfigure them.

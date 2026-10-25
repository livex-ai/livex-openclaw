# Shared agent skills

This folder is the source of truth for reviewed skills in this repository.
Agents consume a selected profile from a pinned Git commit. Edit skills here;
do not edit installed copies. A skill update does not grant tools or permissions.

## Profiles

| Profile     | Skills                                                                                  | Required environment                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oncall`    | `investigate-alerts`, `debug`, `systematic-debugging`, `verification-before-completion` | OpenClaw skill loading, authorized Slack reads, `livex_gcp_logs_read`, and `livex_repository_read`; retain the oncall agent's role and access controls. |
| `debugging` | `systematic-debugging`, `verification-before-completion`                                | An agent with appropriate evidence and validation tools. Production actions still require authorization.                                                |

The oncall instructions retain their existing OpenClaw tool contract. They do
not become a Desktop `gcloud` workflow by moving here. Personal Desktop skills,
credentials, service checkout paths, incident histories, and customer logs are
not part of this public library. Add a reviewed portable profile when those
workflows are ready. The two Superpowers skills are pinned to version 6.4.2.

## Pull only this folder

Use Python 3.10 or later. Use an existing clone, or make a sparse clone. Replace `REVIEWED_COMMIT` with
the full commit ID you reviewed; do not run that placeholder literally.

```sh
git clone --filter=blob:none --no-checkout https://github.com/livex-ai/livex-openclaw.git livex-skills
cd livex-skills
git sparse-checkout init --cone
git sparse-checkout set agent-skills
git checkout --detach REVIEWED_COMMIT
python3 -B agent-skills/scripts/library.py validate
```

Export one profile to a new directory. Keep the `skills/`, `tests/`, and lock
file together so reference links continue to resolve.

```sh
SKILL_REVISION=$(git rev-parse HEAD)
python3 -B agent-skills/scripts/library.py export \
  --profile oncall \
  --target "$HOME/.local/share/livex-skills/$SKILL_REVISION-oncall"
```

The exporter checks source hashes and writes an installed lock with the source
commit, whether the library has uncommitted changes, and exported file hashes. It refuses an existing destination. It does
not execute bundled helpers, install dependencies, change configuration, or
contact a provider. A source outside Git is recorded without a commit; use a
clean pinned checkout for a release.

## Connect an agent

For OpenClaw, point `skills.load.extraDirs` at the exported `skills/` directory
and select the exact names in `agents.entries.<agent-id>.skills`. Keep the
agent's tools, caller checks, production restrictions, and instructions in its
existing configuration and workspace. The repository's [integration template](../livex-agents/config/openclaw.template.json)
selects the [oncall workspace](../livex-agents/workspaces/oncall/AGENTS.md) and uses
this shared source directly; it is suitable for a checkout pinned to a commit.

`extraDirs` is Gateway-wide. Before using it on a Gateway with other agents,
review each agent and set an explicit skill selection. An unrestricted agent
can discover every skill in the shared directory. Do not silently change an
existing agent's selection. Per-agent selections control skill exposure, not
filesystem or credential isolation.

Existing `<workspace>/skills/<name>` copies override `extraDirs`. Before a
cutover, back up those copies, compare their hashes, and remove only confirmed
superseded copies. Then verify the winning source with the runtime's skill
listing and a fresh session. Adding `extraDirs` alone does not prove migration.
Do not apply the full oncall template over an existing deployment just to change
the skill path. Prepare a narrow path/selection patch for that deployment.

For Desktop Codex, export the `debugging` profile and create discovery links for
the selected folders under `~/.agents/skills`. Verify each target is unused
before creating a link; do not overwrite an existing personal skill. Other
agents can use their own loader with the same exported skill directories.

Pulling files does not prove runtime discovery or successful tool access.
Check the selected skill names, source paths, revision, and required tools in a
fresh session before accepting a new version.

## Update and rollback

Fetch the next reviewed commit, check it out, validate it, and export to a new
revision directory. Select that directory only between investigations. Retain
the prior export so rollback is a path change. Do not automatically pull a moving
branch during a turn. Do not edit or delete an active release directory.

## Maintain

1. Change the skill in `skills/<name>/` and retain its supporting files.
2. Record source/version/license and update the current SHA-256 entries in
   `sources.json`. `importedSha256` is provenance, not the current checksum.
3. Add the skill to a profile in `profiles.json` only after review.
4. Run the checks below. For instruction changes, also run affected offline
   behavioral fixtures with a fresh agent and record the limitations.
5. Publish the reviewed commit. Consumers then pull that exact revision.

```sh
python3 -B agent-skills/scripts/library.py validate
python3 -B -m unittest discover -s agent-skills/tests -p 'test_*.py'
python3 -B -m unittest discover -s livex-agents/scripts -p 'test_*.py'
```

The initial centralization at `bdfee0ba` preserved the existing oncall skill
files. Later instruction changes are recorded in `sources.json`. The oncall
workflow follows the pinned canonical investigation source: triage first, preserve
requested deeper work, and report outcome/priority/disposition with separate bold
Finding, Action, Owner and Evidence fields. Lifecycle and review markers stay
separate from health and incident closure. Notion and follow-up remain capability
and authorization gated. The source hash records the actual canonical input; the
repository adaptation preserves this runtime's tool and identity boundaries. This is an instruction contract; it is not a deterministic
formatter or proof of live Slack rendering.

## Licenses

Repository-owned material follows the repository license. Each Superpowers
skill contains its upstream MIT license. The investigation skill retains the
Anthropic Apache-2.0 license, pinned source reference, and modification notice.

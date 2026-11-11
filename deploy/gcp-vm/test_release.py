import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from activate_image import activate
from agent_bundle import BUNDLED as AGENT_BUNDLE, workspace
from release_inputs import release_arguments, select_image, with_concurrency
from vm_prompt import BUNDLED, NAME, WORKSPACE, sha

SHA = "a" * 40
OLD = "sha256:" + "b" * 64
NEW = "sha256:" + "c" * 64
PROGRESS = {
    "mode": "off", "nativeTransport": True,
    "progress": {
        "style": "card", "nativeTaskCards": True, "toolProgress": False,
        "commandText": "status", "commentary": False, "narration": False,
    },
}


class ReleaseTest(unittest.TestCase):
    def test_concurrency_overlay_is_narrow_and_idempotent(self):
        same = b'{ "agents": {"defaults": {"maxConcurrent":5}}, "other": 123 }'
        self.assertEqual(with_concurrency(same, 5), same)
        self.assertEqual(
            json.loads(with_concurrency(b'{"other":123}', 3)),
            {"other": 123, "agents": {"defaults": {"maxConcurrent": 3}}},
        )
        for invalid in (True, "5", 0, -1, None):
            with self.assertRaises(ValueError):
                with_concurrency(same, invalid)
        with self.assertRaises(ValueError):
            with_concurrency(b'{"duplicate":1,"duplicate":2}', 5)

    def test_rejects_ref_or_tag(self):
        for args in (["main", OLD], [SHA, "latest"]):
            with self.assertRaises(ValueError):
                release_arguments(args)

    def test_selector_is_unique_and_preserves_other_bytes(self):
        original = f"# release\r\nOPENCLAW_IMAGE={OLD}\r\nREPOS_DIR=/repos\n".encode()
        self.assertEqual(
            select_image(original, OLD, NEW),
            original.replace(OLD.encode(), NEW.encode()),
        )
        for invalid in (original + original, original.replace(OLD.encode(), b"latest")):
            with self.assertRaises(ValueError):
                select_image(invalid, OLD, NEW)

    def exercise(
        self, failure=None, *, multi=False, existing_debugger=False, progress=False,
        secondary_id="debugger",
    ):
        coordinator = secondary_id == "oncall-coordinator"
        secondary_name = "LiveX Oncall" if coordinator else "Debugger"
        secondary_skills = [] if coordinator else ["debug"]
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            old_prompt = b"previously deployed VM prompt"
            old_source = "e" * 40
            new_prompt = b"reviewed merged VM prompt"
            secondary_prompt = b"Read-only scoped secondary agent instructions"
            old_secondary_prompt = b"Previous reviewed secondary agent instructions"
            bundle = {
                "version": 1,
                "agents": {
                    "oncall": {
                        "config": {
                            "name": "Oncall",
                            "workspace": WORKSPACE,
                            "skills": ["investigate-alerts"],
                            "subagents": {"allowAgents": [secondary_id]},
                            "model": "repository-default",
                            "tools": {"allow": ["read"]},
                        },
                        "prompt": new_prompt.decode(),
                        "sha256": sha(new_prompt),
                    },
                    secondary_id: {
                        "config": {
                            "name": secondary_name,
                            "workspace": workspace(secondary_id),
                            "skills": secondary_skills,
                            "permissionModeDefault": "read-only",
                            "tools": {"allow": ["read"]},
                        },
                        "prompt": secondary_prompt.decode(),
                        "sha256": sha(secondary_prompt),
                    },
                },
                "skills": [*secondary_skills, "investigate-alerts"],
            }
            bundle_bytes = json.dumps(bundle).encode()
            candidate = {
                "source": SHA,
                "previousImage": OLD,
                "image": NEW,
                "maxConcurrent": 7,
                "oncallPromptSha256": sha(new_prompt),
            }
            if progress:
                candidate["slackProgress"] = None if failure == "progress-null" else PROGRESS
            if multi and failure != "legacy-downgrade":
                candidate.update(
                    agentBundleSha256=sha(bundle_bytes),
                    agentPromptSha256={"oncall": sha(new_prompt), secondary_id: sha(secondary_prompt)},
                )
            prev = root / "releases" / old_source
            prev.mkdir(parents=True)
            previous_receipt = {
                "image": OLD,
                "source": old_source,
                "oncallPromptSha256": sha(old_prompt),
            }
            if existing_debugger:
                previous_receipt["agentPromptSha256"] = {
                    "oncall": sha(old_prompt), secondary_id: sha(old_secondary_prompt)
                }
            (prev / "image-receipt.json").write_text(json.dumps(previous_receipt))
            release = root / "releases" / SHA
            release.mkdir(parents=True)
            (release / "image-receipt.json").write_text(
                json.dumps(candidate)
            )
            (root / "backups").mkdir()
            (root / "gcloud").mkdir()
            (root / "state/workspace").mkdir(parents=True)
            protected = [
                "openclaw.sh",
                "start-gateway.sh",
                "runtime.env",
                "compose.yaml",
            ]
            for name in protected:
                (root / name).write_text("existing operator policy")
            mounted = root / "state/workspace/AGENTS.md"
            initial = b"unexpected local edit" if failure == "drift" else old_prompt
            mounted.write_bytes(initial)
            mounted.chmod(0o640)
            secondary = root / f"state/workspaces/{secondary_id}/AGENTS.md"
            if multi:
                secondary.parent.mkdir(parents=True)
                (secondary.parent / "notes.md").write_text("operator notebook")
                if existing_debugger:
                    secondary.write_bytes(old_secondary_prompt)
                    secondary.chmod(0o640)
                if failure == "agent-collision":
                    secondary.write_bytes(b"unmanaged agent instructions")
            config = root / "state/openclaw.json"
            original = {
                "agents": {
                    "defaults": {"maxConcurrent": 1},
                    "entries": {
                        "oncall": {
                            "permissionModeDefault": "read-only",
                            "tools": {"message": {"actions": {"allow": ["read"]}}},
                        }
                    },
                },
                "channels": {"slack": {"ackReaction": "", "typingReaction": ""}},
            }
            if progress:
                original["channels"]["slack"].update(
                    requireMention=True, dmPolicy="disabled", allowFrom=["U_TEST"],
                    streaming={"mode": "progress", "nativeTransport": True,
                               "block": {"enabled": False},
                               "progress": {"style": "compact", "nativeTaskCards": False,
                                            "toolProgress": True, "label": "Investigating"}},
                    accounts={"default": {
                        "botToken": {"source": "env", "provider": "default", "id": "SLACK_BOT_TOKEN"},
                        "streaming": {"progress": {"label": "Operator label"}},
                    }},
                )
                if failure == "progress-override":
                    original["channels"]["slack"]["accounts"]["default"]["streaming"]["mode"] = "progress"
            if multi:
                original["agents"]["entries"]["oncall"].update(
                    model="vm-selected-model",
                    workspace=WORKSPACE,
                    sandbox={"mode": "all"},
                )
                original["agents"]["entries"]["unrelated"] = {
                    "name": "Operator agent", "workspace": "/operator-workspace"
                }
                original["skills"] = {"load": {"extraDirs": ["/operator-skills"]}}
                if existing_debugger:
                    original["agents"]["entries"][secondary_id] = {
                        "name": "Old Debugger", "workspace": workspace(secondary_id),
                        "model": "vm-debugger-model", "permissionModeDefault": "read-only",
                        "tools": {"allow": ["read", "web_search"]},
                    }
                if failure == "config-collision":
                    original["agents"]["entries"][secondary_id] = {"name": "Unmanaged"}
            original_bytes = json.dumps(original).encode()
            config.write_bytes(original_bytes)
            selector = root / "release.env"
            selector.write_text(f"OPENCLAW_IMAGE={OLD}\nREPOS_DIR=/repos\n")
            old_content = selector.read_bytes()
            state = {"image": OLD, "running": True}
            real_run = subprocess.run
            real_write = pathlib.Path.write_text

            def write(path, *args, **kwargs):
                if (
                    failure == "receipt"
                    and path.name == "receipt.json"
                    and not state["running"]
                ):
                    raise OSError("simulated receipt disk full")
                return real_write(path, *args, **kwargs)

            def run(cmd, **kwargs):
                output = ""
                code = 0
                if cmd[0] == "tar":
                    return real_run(cmd, **kwargs)
                if cmd[1] == "inspect":
                    shadow = []
                    if failure in ("agent-mount", "agent-mount-parent", "agent-mount-file"):
                        destination = {
                            "agent-mount": workspace(secondary_id),
                            "agent-mount-parent": "/home/node/.openclaw/workspaces",
                            "agent-mount-file": workspace(secondary_id) + "/AGENTS.md",
                        }.get(failure)
                        shadow = [{"Type": "bind", "Source": "/operator-data", "Destination": destination}]
                    output = json.dumps(
                        [
                            {
                                "Image": state["image"],
                                "Mounts": [
                                    {
                                        "Type": "bind",
                                        "Source": str(
                                            root
                                            / (
                                                "different"
                                                if failure == "mount"
                                                else "state"
                                            )
                                        ),
                                        "Destination": "/home/node/.openclaw",
                                    }
                                ] + shadow,
                                "Config": {
                                    "Labels": {
                                        "org.opencontainers.image.revision": old_source
                                    }
                                },
                                "State": {
                                    "Running": state["running"],
                                    "Health": {"Status": "healthy"},
                                    "StartedAt": "now",
                                },
                            }
                        ]
                    )
                elif "agents.files.get" in cmd:
                    params = json.loads(cmd[cmd.index("--params") + 1])
                    agent_id = params.get("agentId")
                    data = (mounted if agent_id == "oncall" else secondary).read_bytes()
                    active_workspace = "/other" if failure == "workspace" else workspace(agent_id)
                    if state["image"] == NEW and (
                        failure == "live-hash"
                        or (failure == "agent-live-hash" and agent_id == secondary_id)
                    ):
                        data = b"different active prompt"
                    output = json.dumps(
                        {
                            "agentId": agent_id,
                            "workspace": active_workspace,
                            "file": {
                                "path": active_workspace + "/" + NAME,
                                "missing": False,
                                "name": NAME,
                                "hash": sha(data),
                                "content": data.decode(),
                            },
                        }
                    )
                elif "config.get" in cmd:
                    active_config = json.loads(config.read_bytes())
                    pending = failure == "config-not-applied" and state["image"] == NEW
                    if failure == "agent-config-mismatch" and state["image"] == NEW:
                        active_config["agents"]["entries"][secondary_id]["skills"] = []
                    if failure == "progress-readback" and state["image"] == NEW:
                        active_config["channels"]["slack"]["streaming"]["mode"] = "progress"
                    output = json.dumps({
                        "valid": True,
                        "path": "/home/node/.openclaw/openclaw.json",
                        "sourceConfig": active_config,
                        "configRevisionHash": "installed-config-hash",
                        "appliedConfigHash": "old-config-hash" if pending else "installed-config-hash",
                    })
                elif "diagnostics.lanes" in cmd:
                    if failure in ("reset-selector", "foreign-prompt"):
                        selector.write_bytes(old_content)
                        if failure == "foreign-prompt":
                            mounted.write_bytes(b"operator edit")
                        raise RuntimeError("simulated concurrent selector reset")
                    actual = json.loads(config.read_bytes())["agents"]["defaults"][
                        "maxConcurrent"
                    ]
                    output = json.dumps(
                        {
                            "lanes": [
                                {
                                    "lane": "main",
                                    "maxConcurrent": 1 if failure == "lane" else actual,
                                }
                            ]
                        }
                    )
                elif "sessions.list" in cmd:
                    count = int(failure == "busy")
                    output = json.dumps(
                        {"sessions": ["active"] if count else [], "totalCount": count}
                    )
                elif "stop" in cmd:
                    self.assertNotIn(failure, (
                        "drift", "bundle", "workspace", "mount", "agent-collision", "config-collision",
                        "agent-mount", "agent-mount-parent", "agent-mount-file", "legacy-downgrade", "progress-override", "progress-null"
                    ))
                    state["running"] = False
                elif "up" in cmd:
                    selected_new = NEW in selector.read_text()
                    self.assertEqual(
                        mounted.read_bytes(), new_prompt if selected_new else old_prompt
                    )
                    if multi:
                        if selected_new:
                            self.assertEqual(secondary.read_bytes(), secondary_prompt)
                        elif existing_debugger:
                            self.assertEqual(secondary.read_bytes(), old_secondary_prompt)
                        else:
                            self.assertFalse(secondary.exists())
                    state.update(
                        running=True,
                        image=selector.read_text().splitlines()[0].split("=")[1],
                    )
                elif cmd[1] == "logs":
                    output = "socket mode connected"
                elif "run" in cmd:
                    is_seed = any("initializeOncallCatalog();" in arg for arg in cmd)
                    if is_seed:
                        self.assertTrue(
                            list((root / "backups").glob("*/installation.tar.gz"))
                        )
                        self.assertFalse(state["running"])
                    if coordinator and "models" in cmd and secondary_id in cmd:
                        return subprocess.CompletedProcess(cmd, 2, "shared OAuth expiring", "")
                    code = int(
                        (failure == "preflight" and "validate" in cmd)
                        or (failure == "seed" and is_seed)
                        or (failure == "agent-model" and "--agent" in cmd and secondary_id in cmd)
                    )
                else:
                    self.fail(f"Unexpected subprocess {cmd}")
                return subprocess.CompletedProcess(cmd, code, output, "")

            def output(cmd, **kwargs):
                if cmd[0] == "du":
                    return "2000 state\n"
                if cmd[:2] == ["docker", "run"]:
                    self.assertEqual(cmd[-2], NEW)
                    self.assertNotIn("-v", cmd)
                    if cmd[-1] == AGENT_BUNDLE:
                        self.assertTrue(multi)
                        return bundle_bytes
                    self.assertEqual(cmd[-1], BUNDLED)
                    return b"bad bundle" if failure == "bundle" else new_prompt
                self.assertEqual(cmd, ["docker", "image", "inspect", NEW])
                return json.dumps(
                    [
                        {
                            "Config": {
                                "User": "1000:1000",
                                "Labels": {
                                    "livex.node.version": "24.16.0",
                                    "org.opencontainers.image.revision": SHA,
                                },
                            }
                        }
                    ]
                )

            with (
                patch("subprocess.run", side_effect=run),
                patch("subprocess.check_output", side_effect=output),
                patch.object(pathlib.Path, "write_text", write),
                patch("shutil.disk_usage") as disk,
            ):
                disk.return_value.free = 10 * 1024**3
                if failure:
                    with self.assertRaises((OSError, RuntimeError, ValueError)):
                        activate(root, SHA, OLD)
                else:
                    activate(root, SHA, OLD)
            if failure == "foreign-prompt":
                self.assertFalse(state["running"])
                self.assertEqual(mounted.read_bytes(), b"operator edit")
                receipt = json.loads(
                    next(release.glob("activation-*/receipt.json")).read_bytes()
                )
                self.assertEqual(receipt["status"], "failed")
                self.assertIn("externally", receipt["rollbackFailure"])
                return
            if failure:
                self.assertEqual(config.read_bytes(), original_bytes)
            else:
                original["agents"]["defaults"]["maxConcurrent"] = 7
                if progress:
                    streaming = original.get("channels").get("slack").get("streaming")
                    streaming.update(mode="off", nativeTransport=True)
                    streaming.get("progress").update(PROGRESS.get("progress"))
                if multi:
                    original["agents"]["entries"]["oncall"].update(
                        name="Oncall", skills=["investigate-alerts"],
                        subagents={"allowAgents": [secondary_id]},
                    )
                    if existing_debugger:
                        original["agents"]["entries"][secondary_id].update(
                            name=secondary_name, skills=secondary_skills,
                        )
                    else:
                        original["agents"]["entries"][secondary_id] = bundle["agents"][secondary_id]["config"]
                    original["skills"]["load"]["extraDirs"].append("/opt/oncall-skills/skills")
                self.assertEqual(json.loads(config.read_bytes()), original)
            expected = OLD if failure else NEW
            self.assertEqual(state, {"image": expected, "running": True})
            self.assertEqual(
                selector.read_bytes(),
                old_content.replace(OLD.encode(), expected.encode()),
            )
            for name in protected:
                self.assertEqual((root / name).read_text(), "existing operator policy")
            self.assertEqual(mounted.read_bytes(), initial if failure else new_prompt)
            self.assertEqual(mounted.stat().st_mode & 0o777, 0o640)
            if multi:
                self.assertEqual((secondary.parent / "notes.md").read_text(), "operator notebook")
                if failure == "agent-collision":
                    self.assertEqual(secondary.read_bytes(), b"unmanaged agent instructions")
                elif failure:
                    if existing_debugger:
                        self.assertEqual(secondary.read_bytes(), old_secondary_prompt)
                    else:
                        self.assertFalse(secondary.exists())
                else:
                    self.assertEqual(secondary.read_bytes(), secondary_prompt)
                    self.assertEqual(secondary.stat().st_mode & 0o777, 0o640 if existing_debugger else 0o600)
            if failure not in (
                "busy", "drift", "bundle", "workspace", "mount", "agent-collision", "config-collision",
                        "agent-mount", "agent-mount-parent", "agent-mount-file", "legacy-downgrade", "progress-override", "progress-null"
            ):
                receipt = json.loads(
                    next(release.glob("activation-*/receipt.json")).read_text()
                )
                proof = receipt["rollback"] if failure else receipt["readiness"]
                self.assertEqual(
                    proof["activePromptSha256"],
                    sha(old_prompt if failure else new_prompt),
                )
                self.assertEqual(
                    receipt["status"], "rolled_back" if failure else "running_verified"
                )
                if progress and not failure:
                    self.assertEqual(proof.get("slackProgress"), PROGRESS)
                    self.assertEqual(proof.get("appliedConfigHash"), "installed-config-hash")
                if multi:
                    expected_hashes = {"oncall": sha(old_prompt)} if failure else {
                        "oncall": sha(new_prompt), secondary_id: sha(secondary_prompt)
                    }
                    if failure and existing_debugger:
                        expected_hashes[secondary_id] = sha(old_secondary_prompt)
                    self.assertEqual(proof["agentPromptSha256"], expected_hashes)
                    self.assertEqual(proof["appliedConfigHash"], "installed-config-hash")
                    model_checks = {
                        check["name"] for check in receipt["checks"]
                        if check["name"].startswith("models-")
                    }
                    if failure not in ("preflight", "receipt"):
                        expected_model_checks = {"models-oncall"}
                        if not coordinator:
                            expected_model_checks.add(f"models-{secondary_id}")
                        self.assertEqual(model_checks, expected_model_checks)

    def test_script_only_coordinator_installs_without_model_credentials(self):
        self.exercise(multi=True, secondary_id="oncall-coordinator")

    def test_cutover_and_recovery(self):
        for failure in (
            None,
            "drift",
            "bundle",
            "workspace",
            "mount",
            "busy",
            "preflight",
            "receipt",
            "lane",
            "seed",
            "live-hash",
            "reset-selector",
            "foreign-prompt",
        ):
            with self.subTest(failure=failure):
                self.exercise(failure)

    def test_multi_agent_activation_preserves_overrides_and_rolls_back_together(self):
        for failure in (
            None,
            "preflight",
            "agent-model",
            "agent-live-hash",
            "agent-collision",
            "config-collision",
            "agent-config-mismatch",
            "config-not-applied",
            "agent-mount",
            "agent-mount-parent",
            "agent-mount-file",
        ):
            with self.subTest(failure=failure):
                self.exercise(failure, multi=True)

    def test_legacy_candidate_cannot_silently_drop_managed_agent_support(self):
        self.exercise("legacy-downgrade", multi=True, existing_debugger=True)

    def test_existing_managed_agent_update_and_rollback_preserve_vm_overrides(self):
        for failure in (None, "agent-live-hash"):
            with self.subTest(failure=failure):
                self.exercise(failure, multi=True, existing_debugger=True)

    def test_progress_activation_preserves_policies_and_rolls_back_on_failed_readback(self):
        for failure in (None, "progress-readback", "config-not-applied", "preflight", "progress-override", "progress-null"):
            with self.subTest(failure=failure):
                self.exercise(failure, multi=True, progress=True)


class CheckpointTests(unittest.TestCase):
    def test_requires_successful_exact_base_export(self):
        from release_inputs import verify_base_checkpoint

        command = ["docker", "buildx", "build", "-t", "base:" + SHA]
        receipt = {"name": "base", "exit": 0, "command": command}
        log = f"#33 exporting manifest list {NEW} 0.0s done\n"
        verify_base_checkpoint([receipt], command, NEW, log)
        for receipts, expected, image, transcript in [
            ([], command, NEW, log),
            ([receipt, receipt], command, NEW, log),
            ([dict(receipt, exit=1)], command, NEW, log),
            ([receipt], ["other"], NEW, log),
            ([receipt], command, OLD, log),
            ([receipt], command, NEW, f"RUN echo {NEW}"),
        ]:
            with self.assertRaises(ValueError):
                verify_base_checkpoint(receipts, expected, image, transcript)

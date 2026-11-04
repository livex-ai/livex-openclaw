import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from activate_image import activate
from release_inputs import release_arguments, select_image, with_concurrency
from vm_prompt import BUNDLED, NAME, WORKSPACE, sha

SHA = "a" * 40
OLD = "sha256:" + "b" * 64
NEW = "sha256:" + "c" * 64


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

    def exercise(self, failure=None):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            old_prompt = b"previously deployed VM prompt"
            old_source = "e" * 40
            new_prompt = b"reviewed merged VM prompt"
            prev = root / "releases" / old_source
            prev.mkdir(parents=True)
            (prev / "image-receipt.json").write_text(
                json.dumps(
                    {
                        "image": OLD,
                        "source": old_source,
                        "oncallPromptSha256": sha(old_prompt),
                    }
                )
            )
            release = root / "releases" / SHA
            release.mkdir(parents=True)
            (release / "image-receipt.json").write_text(
                json.dumps(
                    {
                        "source": SHA,
                        "previousImage": OLD,
                        "image": NEW,
                        "maxConcurrent": 7,
                        "oncallPromptSha256": sha(new_prompt),
                    }
                )
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
                                ],
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
                    data = mounted.read_bytes()
                    active_workspace = "/other" if failure == "workspace" else WORKSPACE
                    if failure == "live-hash" and state["image"] == NEW:
                        data = b"different active prompt"
                    output = json.dumps(
                        {
                            "agentId": "oncall",
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
                    self.assertNotIn(failure, ("drift", "bundle", "workspace", "mount"))
                    state["running"] = False
                elif "up" in cmd:
                    selected_new = NEW in selector.read_text()
                    self.assertEqual(
                        mounted.read_bytes(), new_prompt if selected_new else old_prompt
                    )
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
                    code = int(
                        (failure == "preflight" and "validate" in cmd)
                        or (failure == "seed" and is_seed)
                    )
                else:
                    self.fail(f"Unexpected subprocess {cmd}")
                return subprocess.CompletedProcess(cmd, code, output, "")

            def output(cmd, **kwargs):
                if cmd[0] == "du":
                    return "2000 state\n"
                if cmd[:2] == ["docker", "run"]:
                    self.assertEqual(cmd[-2:], [NEW, BUNDLED])
                    self.assertNotIn("-v", cmd)
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
                    with self.assertRaises((OSError, RuntimeError)):
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
            if failure not in ("busy", "drift", "bundle", "workspace", "mount"):
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

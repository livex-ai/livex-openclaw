import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from activate_image import activate
from release_inputs import release_arguments, select_image

SHA = "a" * 40
OLD = "sha256:" + "b" * 64
NEW = "sha256:" + "c" * 64


class ReleaseTest(unittest.TestCase):
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
            release = root / "releases" / SHA
            release.mkdir(parents=True)
            (release / "image-receipt.json").write_text(
                json.dumps({"source": SHA, "previousImage": OLD, "image": NEW})
            )
            (root / "backups").mkdir()
            (root / "gcloud").mkdir()
            (root / "state/workspace").mkdir(parents=True)
            protected = [
                "state/workspace/AGENTS.md",
                "state/openclaw.json",
                "openclaw.sh",
                "start-gateway.sh",
                "runtime.env",
                "compose.yaml",
            ]
            for name in protected:
                (root / name).write_text("existing operator policy")
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
                                "State": {
                                    "Running": state["running"],
                                    "Health": {"Status": "healthy"},
                                    "StartedAt": "now",
                                },
                            }
                        ]
                    )
                elif "sessions.list" in cmd:
                    count = int(failure == "busy")
                    output = json.dumps(
                        {"sessions": ["active"] if count else [], "totalCount": count}
                    )
                elif "stop" in cmd:
                    state["running"] = False
                elif "up" in cmd:
                    state.update(
                        running=True,
                        image=selector.read_text().splitlines()[0].split("=")[1],
                    )
                elif cmd[1] == "logs":
                    output = "socket mode connected"
                elif "run" in cmd:
                    code = int(failure == "preflight" and "validate" in cmd)
                else:
                    self.fail(f"Unexpected subprocess {cmd}")
                return subprocess.CompletedProcess(cmd, code, output, "")

            def output(cmd, **kwargs):
                if cmd[0] == "du":
                    return "2000 state\n"
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
            expected = OLD if failure else NEW
            self.assertEqual(state, {"image": expected, "running": True})
            self.assertEqual(
                selector.read_bytes(),
                old_content.replace(OLD.encode(), expected.encode()),
            )
            for name in protected:
                self.assertEqual((root / name).read_text(), "existing operator policy")
            if failure != "busy":
                receipt = json.loads(
                    next(release.glob("activation-*/receipt.json")).read_text()
                )
                self.assertEqual(
                    receipt["status"], "rolled_back" if failure else "running_verified"
                )

    def test_cutover_and_recovery(self):
        for failure in (None, "busy", "preflight", "receipt"):
            with self.subTest(failure=failure):
                self.exercise(failure)

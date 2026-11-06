"""Exercise old/new source builds through the managed build script, without Docker."""

import contextlib
import hashlib
import io
import json
import os
import pathlib
import runpy
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from agent_bundle import BUNDLED

SCRIPT = pathlib.Path(__file__).with_name("build_candidate.py")
SOURCE = "a" * 40
OLD = "sha256:" + "b" * 64
IMAGE = "sha256:" + "c" * 64
PROMPT = b"Reviewed synthetic prompt"


class BuildCandidateTests(unittest.TestCase):
    def exercise(self, bundled, resume, *, invalid_progress=False):
        with tempfile.TemporaryDirectory() as temporary:
            base = pathlib.Path(temporary)
            upload = base / "upload"
            upload.mkdir()
            script = upload / SCRIPT.name
            shutil.copyfile(SCRIPT, script)
            source = base / "source"
            (source / "deploy/gcp-vm").mkdir(parents=True)
            (source / "livex-agents/config").mkdir(parents=True)
            (source / "deploy/gcp-vm/oncall-vm-prompt.sha256").write_text(
                hashlib.sha256(PROMPT).hexdigest() + "  AGENTS.md\n"
            )
            profile = {"agents": {"defaults": {"maxConcurrent": 5}}}
            progress = {
                "mode": "progress", "nativeTransport": True,
                "progress": {"style": "card", "nativeTaskCards": True,
                             "toolProgress": True, "commandText": "status",
                             "commentary": False, "narration": False},
            }
            if bundled:
                profile["channels"] = {"slack": {"streaming": {
                    **progress, "block": {"enabled": False},
                }, "botToken": "synthetic-not-for-receipt"}}
                if invalid_progress:
                    profile.get("channels").get("slack")["streaming"] = None
            (source / "livex-agents/config/openclaw.template.json").write_text(json.dumps(profile))
            if bundled:
                (source / "deploy/gcp-vm/agent_bundle.py").write_text("# Bundled source generation\n")
            archive = upload / "source.tar.gz"
            with tarfile.open(archive, "w:gz") as output:
                output.add(source, arcname=".")
            context = upload / "package-context"
            context.mkdir()
            package = context / "openclaw-current.tgz"
            package.write_bytes(b"synthetic package")
            releases = base / "releases"
            releases.mkdir()
            release = releases / SOURCE
            bundle_bytes = json.dumps({
                "version": 1,
                "agents": {"oncall": {
                    "config": {"workspace": "/home/node/.openclaw/workspace", "skills": []},
                    "prompt": PROMPT.decode(), "sha256": hashlib.sha256(PROMPT).hexdigest(),
                }},
                "skills": [],
            }).encode()
            image_reads = []
            builds = []
            real_run = subprocess.run
            real_path = pathlib.PosixPath

            def resolve_path(*parts):
                if parts == ("/opt/livex-openclaw/releases",):
                    return releases
                return real_path(*parts)

            def run(command, **kwargs):
                if command[0] == "tar":
                    return real_run(command, **kwargs)
                if command[:2] == ["docker", "tag"]:
                    return subprocess.CompletedProcess(command, 0)
                self.assertIn(command[:2], (["docker", "build"], ["docker", "buildx"]))
                builds.append(command)
                kwargs.get("stdout").write(f"#33 exporting manifest list {IMAGE} 0.0s done\n")
                return subprocess.CompletedProcess(command, 0)

            def output(command, **kwargs):
                if command[:3] == ["docker", "image", "inspect"]:
                    if "--format" in command:
                        return (OLD if "node-donor" in command[3] else IMAGE) + "\n"
                    return json.dumps([{"Id": IMAGE, "Config": {
                        "User": "1000:1000", "Labels": {"org.opencontainers.image.revision": SOURCE},
                    }}])
                self.assertEqual(command[:2], ["docker", "run"])
                self.assertEqual(command[-1], BUNDLED)
                image_reads.append(command[-1])
                if not bundled:
                    raise subprocess.CalledProcessError(1, command, stderr="No such file")
                return bundle_bytes

            arguments = [str(script), SOURCE, OLD,
                         hashlib.sha256(archive.read_bytes()).hexdigest(),
                         hashlib.sha256(package.read_bytes()).hexdigest()]

            def execute(*, checkpoint=False, continuing=False):
                previous_umask = os.umask(0o077)
                try:
                    with (patch("pathlib.Path", side_effect=resolve_path),
                          patch("subprocess.run", side_effect=run),
                          patch("subprocess.check_output", side_effect=output),
                          patch("shutil.disk_usage") as disk,
                          patch.object(sys, "argv", arguments + (["--resume-after-base"] if continuing else [])),
                          contextlib.redirect_stdout(io.StringIO())):
                        if checkpoint:
                            disk.side_effect = [SimpleNamespace(free=n * 1024**3) for n in (20, 20, 2)]
                        else:
                            disk.return_value = SimpleNamespace(free=20 * 1024**3)
                        runpy.run_path(str(script), run_name="__main__")
                finally:
                    os.umask(previous_umask)

            if invalid_progress:
                with self.assertRaisesRegex(ValueError, "Slack streaming and progress objects"):
                    execute()
                self.assertFalse((release / "image-receipt.json").exists())
                self.assertEqual(len(builds), 1)  # Reject before building/activating the runtime.
                return
            if resume:
                with self.assertRaisesRegex(RuntimeError, "remaining build disk"):
                    execute(checkpoint=True)
                self.assertFalse((release / "image-receipt.json").exists())
                # Resume must use the re-extracted selected archive, not this interrupted tree.
                marker = release / "build/deploy/gcp-vm/agent_bundle.py"
                if bundled:
                    marker.unlink()
                else:
                    marker.write_text("# unrelated later edit\n")
                (release / "build/livex-agents/config/openclaw.template.json").write_text("{}")
                execute(continuing=True)
            else:
                execute()
            receipt = json.loads((release / "image-receipt.json").read_text())
            self.assertEqual(receipt.get("source"), SOURCE)
            self.assertEqual(receipt.get("image"), IMAGE)
            self.assertEqual(receipt.get("maxConcurrent"), 5)
            self.assertEqual(receipt.get("oncallPromptSha256"), hashlib.sha256(PROMPT).hexdigest())
            self.assertEqual(len(builds), 3)  # The completed base is never rebuilt on resume.
            self.assertEqual(image_reads, [BUNDLED] if bundled else [])
            if bundled:
                self.assertEqual(receipt.get("slackProgress"), progress)
                self.assertNotIn("synthetic-not-for-receipt", json.dumps(receipt))
                self.assertEqual(receipt.get("agentBundleSha256"), hashlib.sha256(bundle_bytes).hexdigest())
                self.assertEqual(receipt.get("agentPromptSha256"), {"oncall": hashlib.sha256(PROMPT).hexdigest()})
            else:
                self.assertNotIn("slackProgress", receipt)
                self.assertNotIn("agentBundleSha256", receipt)
                self.assertNotIn("agentPromptSha256", receipt)

    def test_selected_source_controls_bundle_support_for_fresh_build_and_resume(self):
        for bundled in (False, True):
            for resume in (False, True):
                with self.subTest(bundled=bundled, resume=resume):
                    self.exercise(bundled, resume)

    def test_explicit_null_streaming_cannot_silently_skip_progress_deployment(self):
        self.exercise(True, False, invalid_progress=True)

import json
import os
import pathlib
import subprocess
import tempfile
import unittest

from release_inputs import require_vm_policies, reviewed_prompt_hash
from vm_prompt import (
    LEGACY_SHA,
    LEGACY_SOURCE,
    install_prompt,
    prior_hash,
    read_prompt,
    sha,
)

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent


class PromptTest(unittest.TestCase):
    def test_reviewed_overlay_builds_exact_vm_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            prompt = pathlib.Path(tmp) / "AGENTS.md"
            prompt.write_bytes(
                (ROOT / "livex-agents/workspaces/oncall/AGENTS.md").read_bytes()
            )
            subprocess.run(
                [
                    "git",
                    "apply",
                    "--whitespace=error",
                    str(HERE / "oncall-vm-policy.patch"),
                ],
                cwd=tmp,
                check=True,
            )
            self.assertEqual(
                sha(prompt.read_bytes()),
                reviewed_prompt_hash((HERE / "oncall-vm-prompt.sha256").read_text()),
            )
            for policy in (
                "reactions=off",
                "existing explicit read-only",
                "amend_current_report",
                "begin_trend",
            ):
                self.assertIn(policy, prompt.read_text())

    def test_only_reviewed_legacy_revision_and_image_can_bootstrap(self):
        container = {
            "Image": "old",
            "Config": {"Labels": {"org.opencontainers.image.revision": LEGACY_SOURCE}},
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            release = root / "releases" / LEGACY_SOURCE
            release.mkdir(parents=True)
            receipt = release / "image-receipt.json"
            receipt.write_text(json.dumps({"source": LEGACY_SOURCE, "image": "old"}))
            self.assertEqual(prior_hash(root, container), LEGACY_SHA)
            container["Image"] = "other"
            with self.assertRaises(RuntimeError):
                prior_hash(root, container)
            with self.assertRaises(ValueError):
                reviewed_prompt_hash("arbitrary digest\n")

    def test_refuses_links_and_external_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            parent = root / "state/workspace"
            parent.mkdir(parents=True)
            path = parent / "AGENTS.md"
            target = root / "operator-content"
            target.write_bytes(b"original")
            path.symlink_to(target)
            with self.assertRaises(OSError):
                install_prompt(root, b"original", b"candidate")
            path.unlink()
            os.link(target, path)
            with self.assertRaises(RuntimeError):
                read_prompt(root)
            path.unlink()
            path.write_bytes(b"operator edit")
            with self.assertRaises(RuntimeError):
                install_prompt(root, b"original", b"candidate")
            self.assertEqual(path.read_bytes(), b"operator edit")
            self.assertEqual(target.read_bytes(), b"original")
            parent.rename(root / "moved")
            parent.symlink_to(root / "moved", target_is_directory=True)
            with self.assertRaises(OSError):
                read_prompt(root)

    def test_operational_guards(self):
        agent = {
            "permissionModeDefault": "read-only",
            "tools": {"message": {"actions": {"allow": ["read"]}}},
        }
        slack = {"ackReaction": "", "typingReaction": ""}
        config = {
            "agents": {"entries": {"oncall": agent}},
            "channels": {"slack": slack},
        }
        require_vm_policies(json.dumps(config))
        for mapping, key, value in (
            (agent, "permissionModeDefault", "default"),
            (agent["tools"]["message"]["actions"], "allow", ["read", "react"]),
            (slack, "typingReaction", "eyes"),
            (slack, "accounts", {"other": {"ackReaction": "eyes"}}),
        ):
            with self.subTest(key=key):
                old = mapping.copy()
                mapping[key] = value
                with self.assertRaises(RuntimeError):
                    require_vm_policies(json.dumps(config))
                mapping.clear()
                mapping.update(old)

class AdditionalPromptTests(unittest.TestCase):
    def test_new_agent_install_and_rollback_preserve_unrelated_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'state').mkdir()
            self.assertIsNone(read_prompt(root, 'debugger'))
            install_prompt(root, None, b'checked instructions', 'debugger')
            directory = root / 'state/workspaces/debugger'
            (directory / 'notes.md').write_text('operator notes')
            self.assertEqual(read_prompt(root, 'debugger'), b'checked instructions')
            install_prompt(root, b'checked instructions', None, 'debugger')
            self.assertIsNone(read_prompt(root, 'debugger'))
            self.assertEqual((directory / 'notes.md').read_text(), 'operator notes')

    def test_additional_agent_rejects_symlink_and_foreign_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / 'state/workspaces').mkdir(parents=True)
            outside = root / 'outside'
            outside.mkdir()
            (root / 'state/workspaces/debugger').symlink_to(outside)
            with self.assertRaises(OSError):
                install_prompt(root, None, b'prompt', 'debugger')
            (root / 'state/workspaces/debugger').unlink()
            install_prompt(root, None, b'operator', 'debugger')
            with self.assertRaises(RuntimeError):
                install_prompt(root, None, b'candidate', 'debugger')
            with self.assertRaises(ValueError):
                read_prompt(root, '../outside')

"""Check that oncall reads the central library without relying on old copies."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

CONFIG_PATH = Path(__file__).with_name("config.py")
SPEC = importlib.util.spec_from_file_location("shared_skills_config", CONFIG_PATH)
config = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(config)


class SharedSkillTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.root = self.repo / "livex-agents"
        for name in ("config", "prompts", "skills"):
            (self.root / name).mkdir(parents=True)
        self.library = self.repo / "agent-skills"
        self.skill = self.library / "skills/debug/SKILL.md"
        self.skill.parent.mkdir(parents=True)
        self.skill.write_text("---\nname: debug\ndescription: Use when debugging.\n---\nInspect evidence.\n")
        (self.library / "sources.json").write_text(json.dumps({"skills": [{
            "name": "debug", "path": "skills/debug/SKILL.md",
            "sha256": hashlib.sha256(self.skill.read_bytes()).hexdigest(), "files": []
        }], "sharedFiles": []}))
        (self.library / "profiles.json").write_text(json.dumps({"oncall": ["debug"]}))
        (self.root / "skills/sources.json").write_text('{"skills": []}')
        (self.root / "prompts/investigator.md").write_text("Read-only investigation.")
        self.local = self.root / "config/local.json"
        self.local.write_text(json.dumps({
            "gcloudPath": "/opt/gcloud", "cloudSdkConfig": "/tmp/cloud",
            "openclawCommand": "/opt/openclaw", "gcloudAccount": "reader@example.com",
            "pythonPath": "/usr/bin/python3", "gcloudSdkRoot": "/opt/sdk",
            "project": "example-project", "slackSenderId": "U000000001"
        }))

    def test_render_selects_central_library_without_old_workspace_copies(self):
        (self.root / "config/openclaw.template.json").write_text(json.dumps({
            "skills": {"load": {"extraDirs": ["${SHARED_SKILLS_ROOT}"]}}
        }))
        try:
            rendered, _ = config.render(self.root, self.local)
        except (ValueError, OSError) as error:
            self.fail(f"A valid central library must render: {error}")
        self.assertEqual(rendered["skills"]["load"]["extraDirs"],
                         [str((self.library / "skills").resolve())])

    def test_tampered_central_skill_is_rejected_even_with_legacy_manifest(self):
        (self.root / "config/openclaw.template.json").write_text("{}")
        self.skill.write_text("changed instructions")
        with self.assertRaises((ValueError, OSError)):
            config.render(self.root, self.local)


if __name__ == "__main__":
    unittest.main()

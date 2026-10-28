"""Offline tests for the configuration publication boundary."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("package_config", Path(__file__).with_name("config.py"))
config = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(config)


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve() / "livex-agents"
        self.root.mkdir()
        self.library = self.root.parent / "agent-skills"
        (self.library / "skills").mkdir(parents=True)
        (self.library / "profiles.json").write_text('{}')
        for name in ("config", "skills", "prompts"):
            (self.root / name).mkdir()
        self.write("config/openclaw.template.json", {
            "skills": {"load": {"extraDirs": ["${SHARED_SKILLS_ROOT}"]}},
            "testPath": "${GCLOUD_PATH}", "account": "${GCLOUD_ACCOUNT}",
            "prompt": "${INVESTIGATOR_PROMPT}"})
        self.write("../agent-skills/sources.json", {"skills": [], "sharedFiles": []})
        (self.root / "prompts/investigator.md").write_text('Quoted "text"\nsecond line\n')
        self.local = self.root / "config/local.json"
        self.settings = {"gcloudPath": '/tmp/a path/"gcloud"',
                         "cloudSdkConfig": "/tmp/cloud", "openclawCommand": "/tmp/openclaw wrapper",
                         "gcloudAccount": "oncall-reader@example.com",
                         "pythonPath": "/usr/bin/python3", "gcloudSdkRoot": "/opt/google-cloud-sdk",
                         "project": "example-project", "slackSenderId": "U000000001"}
        self.write("config/local.json", self.settings)

    def write(self, path, value):
        (self.root / path).write_text(json.dumps(value))

    def test_render_preserves_quoted_paths_and_prompt_without_reading_runtime(self):
        rendered, settings = config.render(self.root, self.local)
        self.assertEqual(json.loads(json.dumps(rendered))["testPath"], self.settings["gcloudPath"])
        self.assertEqual(rendered["prompt"], 'Quoted "text"\nsecond line')
        self.assertEqual(rendered["skills"]["load"]["extraDirs"], [str(self.library / "skills")])

    def test_render_substitutes_explicit_gcloud_account(self):
        for account in ("oncall-reader@example.com", "reader@project.iam.gserviceaccount.com",
                        "x" * 242 + "@example.com"):
            with self.subTest(account=account):
                self.write("config/local.json", {**self.settings, "gcloudAccount": account})
                rendered, _ = config.render(self.root, self.local)
                self.assertEqual(rendered["account"], account)

    def test_gcloud_account_is_required(self):
        missing = {key: value for key, value in self.settings.items() if key != "gcloudAccount"}
        self.write("config/local.json", missing)
        with self.assertRaisesRegex(ValueError, "Local settings"):
            config.render(self.root, self.local)

    def test_gcloud_account_format_is_validated(self):
        for account in (None, 42, "", "reader", "reader@example.com extra", "--account=reader@example.com",
                        "reader@example.com\n", "x" * 243 + "@example.com"):
            with self.subTest(account=account):
                self.write("config/local.json", {**self.settings, "gcloudAccount": account})
                with self.assertRaisesRegex(ValueError, "gcloudAccount"):
                    config.render(self.root, self.local)

    def test_package_patch_uses_explicit_identity_and_paging_paths(self):
        template = Path(__file__).resolve().parent.parent / "config/openclaw.template.json"
        self.write("config/openclaw.template.json", json.loads(template.read_text()))
        rendered, _ = config.render(self.root, self.local)
        evidence = rendered["plugins"]["entries"]["livex-gcp-readonly"]["config"]
        self.assertEqual(evidence["gcloudAccount"], self.settings["gcloudAccount"])
        self.assertEqual(evidence["gcloudPath"], self.settings["gcloudPath"])
        self.assertEqual(evidence["cloudSdkConfig"], self.settings["cloudSdkConfig"])
        self.assertEqual(evidence["paging"]["pythonPath"], self.settings["pythonPath"])
        self.assertEqual(evidence["paging"]["sdkRoot"], self.settings["gcloudSdkRoot"])
        self.assertEqual(evidence["project"], self.settings["project"])
        self.assertEqual(evidence["allowedSenderId"], self.settings["slackSenderId"])
        self.assertEqual(rendered["channels"]["slack"]["allowFrom"], [self.settings["slackSenderId"]])
        self.assertEqual(rendered["channels"]["slack"]["channels"]["*"]["users"], [self.settings["slackSenderId"]])
        self.assertNotIn("botToken", json.dumps(rendered))
        self.assertNotIn("appToken", json.dumps(rendered))

    def test_report_profile_is_explicit_for_oncall_only(self):
        root = Path(__file__).resolve().parent.parent
        rendered, _ = config.render(root, root / "config/local.example.json")
        plugins = rendered["plugins"]
        self.assertIn("livex-oncall-reports", plugins["allow"])
        self.assertEqual(plugins["entries"]["livex-oncall-reports"]["config"],
                         {"agentProfiles": {"oncall": "compact-v1"}})
        self.assertIn(str(root / "plugins/livex-oncall-reports"), plugins["load"]["paths"])

    def test_review_profile_limits_message_actions_and_keeps_compact_native_progress(self):
        root = Path(__file__).resolve().parent.parent
        rendered, _ = config.render(root, root / "config/local.example.json")
        tools = rendered["agents"]["entries"]["oncall"]["tools"]
        self.assertEqual(tools["message"]["actions"]["allow"], ["read", "react", "reactions"])
        self.assertEqual(tools["allow"], ["read", "skills_read", "message",
                                          "livex_gcp_logs_read", "livex_repository_read"])
        slack = rendered["channels"]["slack"]
        self.assertTrue(slack["actions"]["reactions"])
        streaming = slack["streaming"]
        self.assertEqual(streaming["mode"], "progress")
        self.assertTrue(streaming["nativeTransport"])
        self.assertEqual(streaming["progress"]["style"], "compact")
        self.assertFalse(streaming["progress"]["nativeTaskCards"])
        for key in ("toolProgress", "commentary", "narration"):
            self.assertFalse(streaming["progress"][key])

    def test_dedicated_app_has_scopes_and_account_gate_for_review_markers(self):
        root = Path(__file__).resolve().parent.parent
        manifest = json.loads((root / "slack/app-manifest.json").read_text())
        scopes = manifest["oauth_config"]["scopes"]["bot"]
        self.assertIn("reactions:read", scopes)
        self.assertIn("reactions:write", scopes)
        cutover = json.loads((root / "slack/account-cutover.patch.json").read_text())
        account = cutover["channels"]["slack"]["accounts"]["oncall"]
        self.assertTrue(account["actions"]["reactions"])
        self.assertEqual(account["reactionNotifications"], "off")
        self.assertEqual(account["botToken"]["source"], "file")
        self.assertEqual(account["appToken"]["source"], "file")

    def test_supplied_example_renders_without_unresolved_values(self):
        root = Path(__file__).resolve().parent.parent
        rendered, _ = config.render(root, root / "config/local.example.json")
        self.assertNotIn("${", json.dumps(rendered))
        self.assertEqual(set(rendered["agents"]["entries"]), {"oncall"})
        workspace = Path(rendered["agents"]["entries"]["oncall"]["workspace"])
        self.assertEqual(workspace, root / "workspaces/oncall")
        self.assertTrue((workspace / "AGENTS.md").is_file())
        plugin = Path(rendered["plugins"]["load"]["paths"][0])
        self.assertEqual(plugin, root / "plugins/livex-gcp-readonly")
        self.assertTrue((plugin / "index.ts").is_file())

    def test_identity_fields_reject_invalid_values(self):
        for key, value in (("project", "other project"), ("project", "--project=x"),
                           ("slackSenderId", "*"), ("slackSenderId", "")):
            with self.subTest(key=key, value=value):
                self.write("config/local.json", {**self.settings, key: value})
                with self.assertRaisesRegex(ValueError, key):
                    config.render(self.root, self.local)

    def test_unresolved_placeholder_fails(self):
        self.write("config/openclaw.template.json", {"path": "${MISSING}"})
        with self.assertRaisesRegex(ValueError, "Unknown placeholder"):
            config.render(self.root, self.local)

    def test_local_settings_do_not_accept_secrets_or_arbitrary_config(self):
        self.write("config/local.json", {**self.settings, "botToken": "synthetic"})
        with self.assertRaisesRegex(ValueError, "Local settings"):
            config.render(self.root, self.local)

    def test_current_shared_skill_hash_is_used_instead_of_import_provenance(self):
        skill = self.library / "skills/debug/SKILL.md"
        skill.parent.mkdir()
        skill.write_text("---\nname: debug\ndescription: Use when debugging.\n---\nInspect evidence.\n")
        self.write("../agent-skills/sources.json", {"skills": [{
            "name": "debug", "path": "skills/debug/SKILL.md",
            "sha256": hashlib.sha256(skill.read_bytes()).hexdigest(),
            "importedSha256": "0" * 64, "files": []}]})
        config.render(self.root, self.local)

    def test_modified_skill_or_support_file_is_rejected(self):
        for relative in ("SKILL.md", "support.md"):
            with self.subTest(relative=relative):
                directory = self.library / "skills/debug"
                directory.mkdir(exist_ok=True)
                main = directory / "SKILL.md"
                main.write_text("---\nname: debug\ndescription: Use when debugging.\n---\nInspect evidence.\n")
                support = directory / "support.md"
                support.write_text("reviewed")
                self.write("../agent-skills/sources.json", {"skills": [{
                    "name": "debug", "path": "skills/debug/SKILL.md",
                    "sha256": hashlib.sha256(main.read_bytes()).hexdigest(),
                    "files": [{"path": "skills/debug/support.md",
                               "sha256": hashlib.sha256(support.read_bytes()).hexdigest()}]}]})
                (directory / relative).write_text("changed")
                with self.assertRaises(ValueError):
                    config.render(self.root, self.local)

    def test_skill_manifest_cannot_read_outside_library(self):
        self.write("../agent-skills/sources.json", {"skills": [{
            "name": "debug", "path": "../external", "sha256": "0" * 64}]})
        with self.assertRaises(ValueError):
            config.render(self.root, self.local)

    @patch.object(config.subprocess, "run")
    def test_validate_only_uses_supported_dry_run(self, run):
        config.publish({"tools": {"profile": "minimal"}}, self.settings, apply=False)
        args = run.call_args.args[0]
        self.assertEqual(args[:4], [self.settings["openclawCommand"], "config", "patch", "--file"])
        self.assertEqual(args[-2:], ["--dry-run", "--json"])
        self.assertTrue(run.call_args.kwargs["check"])
        self.assertEqual(run.call_count, 1)

    @patch.object(config.subprocess, "run")
    def test_failed_validation_prevents_apply(self, run):
        run.side_effect = subprocess.CalledProcessError(1, ["openclaw"])
        with self.assertRaises(subprocess.CalledProcessError):
            config.publish({}, self.settings, apply=True)
        self.assertEqual(run.call_count, 1)

    @patch.object(config.subprocess, "run")
    def test_apply_validates_then_delegates_to_openclaw(self, run):
        config.publish({}, self.settings, apply=True)
        self.assertEqual(run.call_count, 2)
        validation, publication = [call.args[0] for call in run.call_args_list]
        self.assertEqual(validation, publication + ["--dry-run", "--json"])


if __name__ == "__main__":
    unittest.main()

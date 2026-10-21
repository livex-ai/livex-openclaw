"""Offline tests for the configuration publication boundary."""
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
        self.root = Path(self.tmp.name).resolve()
        for name in ("config", "skills", "prompts"):
            (self.root / name).mkdir()
        self.write("config/openclaw.template.json", {
            "skills": {"load": {"extraDirs": ["${PACKAGE_ROOT}/skills/debug"]}},
            "testPath": "${GCLOUD_PATH}", "account": "${GCLOUD_ACCOUNT}",
            "prompt": "${INVESTIGATOR_PROMPT}"})
        self.write("skills/sources.json", {"skills": []})
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
        self.assertEqual(rendered["skills"]["load"]["extraDirs"], [str(self.root / "skills/debug")])

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

    def test_supplied_example_renders_without_unresolved_values(self):
        root = Path(__file__).resolve().parent.parent
        rendered, _ = config.render(root, root / "config/local.example.json")
        self.assertNotIn("${", json.dumps(rendered))

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

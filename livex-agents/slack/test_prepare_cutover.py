import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


DIRECTORY = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("prepare_cutover", DIRECTORY / "prepare-cutover.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def merge_patch(value, patch):
    if not isinstance(patch, dict):
        return copy.deepcopy(patch)
    result = copy.deepcopy(value) if isinstance(value, dict) else {}
    for key, item in patch.items():
        if item is None:
            result.pop(key, None)
        else:
            result[key] = merge_patch(result.get(key), item)
    return result


def fixture():
    return {
        "plugins": {"entries": {"livex-gcp-readonly": {"config": {"allowedSenderId": "U000000001", "project": "example-project"}}}},
        "channels": {"slack": {"enabled": True, "botToken": "TEST_LEGACY_BOT", "appToken": "TEST_LEGACY_APP", "userToken": "TEST_LEGACY_USER", "allowFrom": ["U000000001"], "channels": {"*": {"enabled": True, "users": ["U000000001"]}}}},
        "bindings": [{"agentId": "other", "match": {"channel": "telegram"}}, {"agentId": "oncall", "match": {"channel": "slack", "accountId": "default", "peer": {"kind": "channel", "id": "*"}}}],
        "agents": {"entries": {"oncall": {"workspace": "/example/workspace"}}},
        "secrets": {"providers": {"other": {"source": "env"}}},
    }


class CutoverTests(unittest.TestCase):
    def test_cutover_and_rollback_preserve_unrelated_bindings_and_credentials(self):
        config = fixture()
        before = copy.deepcopy(config)
        cutover, rollback = MODULE.prepare(config)
        self.assertEqual(config, before)
        self.assertNotIn("TEST_LEGACY", json.dumps([cutover, rollback]))
        active = merge_patch(config, cutover)
        self.assertEqual(active["bindings"][0], config["bindings"][0])
        self.assertEqual(active["bindings"][1]["match"]["accountId"], "oncall")
        self.assertEqual(active["plugins"], config["plugins"])
        self.assertEqual(active["agents"], config["agents"])
        slack = active["channels"]["slack"]
        self.assertEqual(slack["botToken"], config["channels"]["slack"]["botToken"])
        self.assertFalse(slack["accounts"]["default"]["enabled"])
        account = slack["accounts"]["oncall"]
        self.assertEqual(account["userToken"], "")
        self.assertEqual(account["allowFrom"], ["U000000001"])
        self.assertEqual(account["channels"]["*"]["users"], ["U000000001"])
        self.assertTrue(account["requireMention"])
        self.assertTrue(account["channels"]["*"]["requireMentionInBotThreads"])
        self.assertEqual(account["dmPolicy"], "disabled")
        self.assertEqual(account["appToken"]["id"], "/appToken")
        self.assertEqual(account["botToken"]["id"], "/botToken")
        self.assertEqual(active["secrets"]["providers"]["slack-oncall"]["path"], "${OPENCLAW_STATE_DIR}/secrets/slack-oncall.json")
        restored = merge_patch(active, rollback)
        restored["channels"]["slack"].pop("accounts")
        self.assertEqual(restored, config)

    def test_existing_accounts_providers_and_changed_callers_require_manual_review(self):
        for mutate in (
            lambda c: c["channels"]["slack"].update(enabled=False),
            lambda c: c["channels"]["slack"].update(accounts={"existing": {"enabled": True}}),
            lambda c: c["channels"]["slack"].update(defaultAccount="existing"),
            lambda c: c["secrets"]["providers"].update({"slack-oncall": {"source": "file"}}),
            lambda c: c["channels"]["slack"].update(allowFrom=["U000000002"]),
            lambda c: c["bindings"].pop(),
        ):
            with self.subTest(mutate=mutate):
                config = fixture()
                mutate(config)
                with self.assertRaises(ValueError):
                    MODULE.prepare(config)

    def test_other_default_account_slack_routes_require_manual_reconciliation(self):
        for account in ("default", None):
            with self.subTest(account=account):
                config = fixture()
                match = {"channel": "slack", "peer": {"kind": "channel", "id": "C000000001"}}
                if account is not None:
                    match["accountId"] = account
                config["bindings"].insert(0, {"agentId": "other", "match": match})
                with self.assertRaisesRegex(ValueError, "additional Slack"):
                    MODULE.prepare(config)

    def test_channel_specific_or_disabled_wildcard_policy_requires_manual_review(self):
        for mutate in (
            lambda c: c["channels"]["slack"]["channels"].update({"C000000001": {"enabled": False}}),
            lambda c: c["channels"]["slack"]["channels"]["*"].update(enabled=False),
        ):
            config = fixture()
            mutate(config)
            with self.assertRaisesRegex(ValueError, "channel policy"):
                MODULE.prepare(config)

    def test_cli_writes_private_artifacts_without_changing_input_or_overwriting(self):
        with tempfile.TemporaryDirectory(prefix="slack cutover ") as directory:
            root = Path(directory)
            config = root / "config.json"
            config.write_text(json.dumps(fixture()))
            original = config.read_bytes()
            output = root / "patches"
            command = [sys.executable, "-B", str(DIRECTORY / "prepare-cutover.py"), "--config", str(config), "--output-dir", str(output)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("TEST_LEGACY", result.stdout + result.stderr)
            self.assertEqual(config.read_bytes(), original)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            files = sorted(output.iterdir())
            self.assertEqual(len(files), 2)
            for file in files:
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()

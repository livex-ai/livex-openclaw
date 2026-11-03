import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import oncall_concurrency as policy


class ConcurrencyTests(unittest.TestCase):
    def test_apply_preserves_policy_and_checks_live_lane(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir()
            (root / "backups").mkdir()
            source = root / "state/openclaw.json"
            original = b'{"agents":{"defaults":{"maxConcurrent":1}},"slack":"existing policy"}\n'
            source.write_bytes(original)
            calls = []

            def cli(*args):
                calls.append(args)
                config = json.loads(source.read_bytes())
                if args[:2] == ("config", "get"):
                    return json.dumps(config["agents"]["defaults"]["maxConcurrent"])
                if args[:2] == ("config", "set"):
                    self.assertEqual(
                        args[:5], ("config", "set", policy.KEY, "5", "--strict-json")
                    )
                    if "--dry-run" not in args:
                        (backup,) = (root / "backups").glob("*/openclaw.json")
                        self.assertEqual(backup.read_bytes(), original)
                        config["agents"]["defaults"]["maxConcurrent"] = 5
                        source.write_text(json.dumps(config))
                    return ""
                self.assertEqual(args, ("config", "validate", "--json"))
                return "{}"

            mounts = json.dumps(
                [
                    {
                        "Destination": "/home/node/.openclaw",
                        "Source": str(root / "state"),
                        "RW": True,
                    }
                ]
            )
            with (
                patch.object(policy, "ROOT", root),
                patch.object(policy, "cli", side_effect=cli),
                patch.object(policy, "main_lane", side_effect=[1, 1, 5]),
                patch("subprocess.check_output", return_value=mounts),
                patch("time.sleep"),
            ):
                policy.apply()
            self.assertEqual(
                json.loads(source.read_bytes())["slack"], "existing policy"
            )
            self.assertIn(
                ("config", "set", policy.KEY, "5", "--strict-json", "--dry-run"), calls
            )

    def test_saved_five_with_stale_live_lane_fails(self):
        with (
            patch.object(policy, "configured", return_value=5),
            patch.object(policy, "main_lane", return_value=1),
            patch.object(policy, "cli") as cli,
            patch("time.sleep"),
        ):
            with self.assertRaisesRegex(SystemExit, "did not reload"):
                policy.apply()
            cli.assert_not_called()

    def test_existing_five_is_idempotent(self):
        with (
            patch.object(policy, "check", return_value=(5, 5)),
            patch.object(policy, "cli") as cli,
        ):
            policy.apply()
            cli.assert_not_called()

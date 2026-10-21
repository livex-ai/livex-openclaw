"""Offline contract tests; no credentials, SDK client, or network are loaded."""
import importlib.util
import json
from pathlib import Path
import contextlib
import io
import os
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


HELPER = Path(__file__).with_name("logging-page.py")
PROJECT = "fixture-prd"
FILTER = ('logName =~ "^projects/fixture-prd/logs/" AND '
          'timestamp>="2026-10-20T16:00:46.073712Z" AND '
          'timestamp<="2026-10-20T17:00:46.073712Z"')


def load_helper():
    spec = importlib.util.spec_from_file_location("logging_page", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def entry(index=0):
    return {
        "logName": "projects/fixture-prd/logs/stdout",
        "timestamp": "2026-10-20T16:01:02.123456789Z",
        "insertId": f"seed-{index}", "severity": "ERROR",
        "resource": {"type": "k8s_container", "labels": {"pod_name": "worker-a"}},
        "trace": "projects/fixture-prd/traces/abc",
        "jsonPayload": {"conversation_id": "case-1", "levelname": "DEBUG", "message": "failed"},
    }


class FakeMessages:
    @staticmethod
    def ListLogEntriesRequest(**kwargs):
        return kwargs

    @staticmethod
    def StandardQueryParameters(**kwargs):
        return kwargs


class FakeClient:
    def __init__(self, response):
        self.response = response
        self.calls = []
        self.entries = self

    def List(self, request, global_params):
        self.calls.append((request, global_params))
        # Cloud Logging jsonPayload is a protobuf Struct: its arbitrary keys
        # cannot be selected as declared API response fields (live HTTP 400).
        if "jsonPayload(" in global_params["fields"]:
            raise ValueError("Invalid response field selection inside jsonPayload")
        return self.response


class LoggingPageTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(HELPER.is_file(), "one-page helper has not been implemented")
        self.helper = load_helper()

    def read(self, response, **options):
        client = FakeClient(response)
        result = self.helper.read_page(
            client, FakeMessages, lambda value: value,
            project=PROJECT, log_filter=FILTER, page_size=50, **options)
        return result, client

    def test_one_api_page_preserves_fractional_timestamp_and_cursor(self):
        result, client = self.read({"entries": [entry()], "nextPageToken": "opaque/+=="},
                                   page_token="previous/+==")
        self.assertEqual(len(client.calls), 1)
        request, params = client.calls[0]
        self.assertEqual(request["resourceNames"], ["projects/fixture-prd"])
        self.assertEqual(request["pageToken"], "previous/+==")
        self.assertEqual(request["pageSize"], 50)
        self.assertEqual(request["orderBy"], "timestamp desc")
        self.assertIn(".073712Z", request["filter"])
        self.assertEqual(result["entries"][0]["timestamp"], entry()["timestamp"])
        self.assertEqual(result["entries"][0]["insertId"], "seed-0")
        self.assertEqual(result["entries"][0]["jsonPayload"]["levelname"], "DEBUG")
        self.assertEqual(result["nextPageToken"], "opaque/+==")
        self.assertFalse(result["projectionTruncated"])
        self.assertIn("nextPageToken", params["fields"])
        self.assertIn("jsonPayload)", params["fields"])
        self.assertNotIn("protoPayload", params["fields"])

    def test_dense_oversized_rows_are_shortened_not_dropped(self):
        rows = [entry(i) for i in range(50)]
        for row in rows:
            row["textPayload"] = "🙃\\\"\n" * 10000
            row["jsonPayload"].update({key: "x" * 20000 for key in
                                       ("message", "error", "stack", "exc_info", "filename")})
            row["jsonPayload"]["private_unapproved"] = "MUST-NOT-RETURN"
            row["protoPayload"] = {"private": "MUST-NOT-RETURN"}
        result, _ = self.read({"entries": rows, "nextPageToken": "next"})
        self.assertEqual(len(result["entries"]), 50)
        self.assertEqual([row["insertId"] for row in result["entries"]],
                         [f"seed-{i}" for i in range(50)])
        self.assertTrue(result["projectionTruncated"])
        self.assertEqual(result["nextPageToken"], "next")
        self.assertLess(len(self.helper.encode_json(result).encode()), 256 * 1024)
        for row in result["entries"]:
            self.assertLessEqual(len(self.helper.encode_json(row).encode()), 4096)
            self.assertEqual(row["jsonPayload"]["conversation_id"], "case-1")
        self.assertNotIn("MUST-NOT-RETURN", json.dumps(result))

    def test_empty_page_retains_continuation(self):
        result, _ = self.read({"entries": [], "nextPageToken": "keep-going"})
        self.assertEqual(result, {"entries": [], "nextPageToken": "keep-going",
                                  "projectionTruncated": False})

    def test_final_page_uses_null_cursor(self):
        result, _ = self.read({"entries": [entry()]})
        self.assertIsNone(result["nextPageToken"])

    def test_oversized_identity_fails_entire_page(self):
        row = entry()
        row["jsonPayload"]["conversation_id"] = "x" * 5000
        with self.assertRaisesRegex(ValueError, "identity"):
            self.read({"entries": [entry(1), row], "nextPageToken": "must-not-advance"})

    def test_foreign_project_row_is_rejected(self):
        row = entry()
        row["logName"] = "projects/foreign-prd/logs/stdout"
        with self.assertRaisesRegex(ValueError, "project"):
            self.read({"entries": [row], "nextPageToken": "must-not-advance"})

    def test_scope_and_page_size_validate_before_api_call(self):
        for log_filter, size in [("severity>=ERROR", 50), (FILTER, 0), (FILTER, 51),
                                 (FILTER, True), (FILTER.replace(PROJECT, "foreign"), 20)]:
            with self.subTest(log_filter=log_filter, size=size):
                client = FakeClient({"entries": []})
                with self.assertRaises(ValueError):
                    self.helper.read_page(client, FakeMessages, lambda value: value,
                                          project=PROJECT, log_filter=log_filter, page_size=size)
                self.assertEqual(client.calls, [])

    def test_import_does_not_load_cloud_sdk(self):
        import sys
        self.assertNotIn("googlecloudsdk.api_lib.util.apis", sys.modules)

    def test_sdk_value_error_never_exposes_exception_body(self):
        self.assert_cli_failure(ValueError("Bearer PRIVATE-SDK-ERROR"),
                                {"error": {"code": "sdk_error"}})

    def test_sdk_http_error_reports_status_without_private_body(self):
        error = RuntimeError("Bearer PRIVATE-SDK-ERROR https://private.example/request")
        error.status_code = 400
        self.assert_cli_failure(error, {"error": {"code": "http_error", "httpStatus": 400}})

    def assert_cli_failure(self, failure, expected):
        import sys
        def rejected_client(*args, **kwargs):
            raise failure
        property_stub = SimpleNamespace(Set=lambda value: None)
        modules = {
            "googlecloudsdk.api_lib.util": SimpleNamespace(apis=SimpleNamespace(
                GetMessagesModule=lambda *args: FakeMessages, GetClientInstance=rejected_client)),
            "googlecloudsdk.core": SimpleNamespace(properties=SimpleNamespace(
                VALUES=SimpleNamespace(core=SimpleNamespace(account=property_stub, project=property_stub)))),
            "apitools.base.py": SimpleNamespace(encoding=SimpleNamespace(MessageToDict=lambda value: value)),
        }
        with tempfile.TemporaryDirectory() as root:
            package = Path(root) / "lib/googlecloudsdk"
            package.mkdir(parents=True)
            (package / "__init__.py").touch()
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.dict(sys.modules, modules), patch.dict(os.environ), patch.object(sys, "path", sys.path.copy()):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    code = self.helper.main(["--sdk-root", root, "--account", "fixture@example.com",
                                             "--project", PROJECT, "--filter", FILTER, "--page-size", "1"])
            self.assertNotEqual(code, 0)
            self.assertEqual(stdout.getvalue(), "")
            self.assertNotIn("PRIVATE-SDK-ERROR", stderr.getvalue())
            self.assertEqual(json.loads(stderr.getvalue()), expected)

    def test_auth_environment_overrides_do_not_change_config_files(self):
        with patch.dict(os.environ, {"CLOUDSDK_CONFIG": "/approved/config", "GOOGLE_APPLICATION_CREDENTIALS": "/wrong/key"}):
            self.helper.configure_sdk_environment("fixture@example.com", PROJECT)
            self.assertEqual(os.environ["CLOUDSDK_CONFIG"], "/approved/config")
            self.assertEqual(os.environ["CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT"], "")
            self.assertEqual(os.environ["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"], "")
            self.assertEqual(os.environ["CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"], "")
            self.assertEqual(os.environ["CLOUDSDK_API_ENDPOINT_OVERRIDES_LOGGING"], "https://logging.googleapis.com/")
            self.assertNotIn("GOOGLE_APPLICATION_CREDENTIALS", os.environ)


if __name__ == "__main__":
    unittest.main()

"""Offline contracts; the optional real SDK client uses a synthetic HTTP transport."""
import importlib.util
import json
from pathlib import Path
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import textwrap
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


def model_request(tools):
    raw = entry()
    raw["resource"]["labels"]["container_name"] = "chat-engine"
    raw["jsonPayload"].update(
        filename="google_vertex_ai.py", funcName="_log_gemini_request",
        message="[DEBUG] Gemini stream_generate_content request:\n" + json.dumps({
            "model": "fixture-model",
            "messages": [{"role": "user", "content": "PRIVATE-PROMPT" + "x" * 2300}],
            "tools_config": {"tools": tools, "tool_choice": "auto"},
        }))
    return raw


def token_request():
    raw = entry()
    raw["logName"] = f"projects/{PROJECT}/logs/requests"
    raw["resource"]["type"] = "http_load_balancer"
    raw["httpRequest"] = {"status": 200, "requestUrl": "PRIVATE-URL",
                          "headers": {"authorization": "PRIVATE-TOKEN"}}
    return raw


def offered_map():
    return {"type": "function", "function": {
        "name": "kiosk_map", "description": "PRIVATE-DESCRIPTION",
        "parameters": {"properties": {
            "operation": {"enum": ["open_map"]},
            "argument": {"default": "PRIVATE-ARGUMENT"},
        }},
    }}


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

    def JsonResponseModel(self):
        return contextlib.nullcontext()

    def List(self, request, global_params):
        self.calls.append((request, global_params))
        # Cloud Logging jsonPayload is a protobuf Struct: its arbitrary keys
        # cannot be selected as declared API response fields (live HTTP 400).
        if "jsonPayload(" in global_params["fields"]:
            raise ValueError("Invalid response field selection inside jsonPayload")
        return json.dumps(self.response)


class LoggingPageTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(HELPER.is_file(), "one-page helper has not been implemented")
        self.helper = load_helper()

    def read(self, response, **options):
        client = FakeClient(response)
        result = self.helper.read_page(
            client, FakeMessages,
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
                    self.helper.read_page(client, FakeMessages,
                                          project=PROJECT, log_filter=log_filter, page_size=size)
                self.assertEqual(client.calls, [])

    def test_projects_only_status_and_tool_offer_before_clipping(self):
        raw = model_request([offered_map()])
        self.assertGreater(raw["jsonPayload"]["message"].index("tools_config"), 2048)
        result, client = self.read({"entries": [raw, token_request(), model_request([])]})
        self.assertIn("httpRequest(status)", client.calls[0][1]["fields"])
        self.assertEqual(result["entries"][0]["toolOffer"],
                         [{"name": "kiosk_map", "operations": ["open_map"]}])
        self.assertEqual(result["entries"][1]["httpRequest"], {"status": 200})
        self.assertEqual(result["entries"][2]["toolOffer"], [])
        self.assertNotIn("PRIVATE-", json.dumps(result))

    def test_unrecognized_or_incomplete_model_request_keeps_tool_offer_unknown(self):
        malformed = model_request([offered_map()])
        malformed["jsonPayload"]["message"] = malformed["jsonPayload"]["message"][:-1]
        oversized = model_request([offered_map()])
        oversized["jsonPayload"]["message"] += " " * 65536
        ambiguous = model_request([offered_map()])
        ambiguous["jsonPayload"]["message"] = ambiguous["jsonPayload"]["message"].replace(
            '"tool_choice": "auto"', '"tool_choice": "auto", "tools": []')
        unrelated = model_request([offered_map()])
        unrelated["resource"]["labels"]["container_name"] = "unrelated"
        invalid_tool = model_request([{"type": "unknown"}])
        invalid_encoding = model_request([offered_map()])
        invalid_encoding["jsonPayload"]["message"] += "\ud800"
        credential_tool = offered_map()
        credential_tool["function"]["name"] = "sk-synthetic_cannot_escape_0000"
        credential_name = model_request([credential_tool])
        credential_tool = offered_map()
        credential_tool["function"]["parameters"]["properties"]["operation"]["enum"] = [
            "xapp-synthetic-cannot-escape",
        ]
        credential_operation = model_request([credential_tool])
        invalid_status = token_request()
        invalid_status["httpRequest"]["status"] = "200"
        result, _ = self.read({"entries": [
            malformed, oversized, ambiguous, unrelated, invalid_tool, invalid_encoding, credential_name,
            credential_operation, invalid_status,
        ]})
        for row in result["entries"]:
            self.assertNotIn("toolOffer", row)
            self.assertNotIn("httpRequest", row)
        self.assertNotIn("PRIVATE-", json.dumps(result))
        self.assertNotIn("cannot", json.dumps(result))

    def test_import_does_not_load_cloud_sdk(self):
        import sys
        self.assertNotIn("googlecloudsdk.api_lib.util.apis", sys.modules)

    @unittest.skipUnless(os.environ.get("GCLOUD_SDK_LIB"), "set GCLOUD_SDK_LIB for the offline SDK contract")
    def test_sdk_scalar_and_boolean_array_responses_preserve_projection_and_cursor(self):
        script = textwrap.dedent('''
            import contextlib, importlib.util, io, json, sys
            from pathlib import Path
            from unittest.mock import patch
            helper_path, sdk_lib, fixture, model, token = sys.argv[1:]
            sys.path[:0] = [sdk_lib, str(Path(sdk_lib) / "third_party")]
            from googlecloudsdk.api_lib.util import apis
            import httplib2
            spec = importlib.util.spec_from_file_location("logging_page", helper_path)
            helper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(helper)
            client_type = apis.GetClientClass("logging", "v2")
            results = []
            for name, args in [
                ("boolean-array", [True, False]), ("scalar", "ignored"), ("kiosk-evidence", None),
            ]:
                row = json.loads(fixture)
                row["jsonPayload"]["args"] = args
                rows = [json.loads(model), json.loads(token)] if name == "kiosk-evidence" else [row]
                body = json.dumps({"entries": rows, "nextPageToken": "retained/+=="})
                class OfflineHttp:
                    calls = 0
                    def request(self, *args, **kwargs):
                        self.calls += 1
                        return httplib2.Response({"status": "200"}), body
                http = OfflineHttp()
                client = client_type(get_credentials=False, http=http)
                stdout, stderr = io.StringIO(), io.StringIO()
                with patch.object(apis, "GetClientInstance", return_value=client):
                    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                        code = helper.main(["--sdk-root", str(Path(sdk_lib).parent),
                            "--account", "fixture@example.com", "--project", "fixture-prd",
                            "--filter", 'logName =~ "^projects/fixture-prd/logs/" AND severity>=ERROR',
                            "--page-size", str(len(rows))])
                results.append({"case": name, "code": code, "calls": http.calls,
                                "stdout": stdout.getvalue(), "stderr": stderr.getvalue()})
            print(json.dumps(results))
        ''')
        with tempfile.TemporaryDirectory() as isolated:
            environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": isolated,
                           "TMPDIR": isolated, "CLOUDSDK_CONFIG": isolated,
                           "CLOUDSDK_CORE_CHECK_GCE_METADATA": "false",
                           "CLOUDSDK_CORE_DISABLE_FILE_LOGGING": "true",
                           "CLOUDSDK_CORE_DISABLE_PROMPTS": "true", "CLOUDSDK_CORE_LOG_HTTP": "false"}
            completed = subprocess.run([sys.executable, "-I", "-B", "-c", script, str(HELPER),
                                        os.environ["GCLOUD_SDK_LIB"], json.dumps(entry()),
                                        json.dumps(model_request([offered_map()])),
                                        json.dumps(token_request())],
                                       env=environment, capture_output=True, text=True, timeout=15)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        for case in json.loads(completed.stdout):
            with self.subTest(case=case["case"]):
                self.assertEqual(case["code"], 0, case["stderr"])
                self.assertEqual(case["calls"], 1)
                result = json.loads(case["stdout"])
                if case["case"] == "kiosk-evidence":
                    offer, token = result["entries"]
                    self.assertEqual(offer["toolOffer"], [{"name": "kiosk_map", "operations": ["open_map"]}])
                    self.assertEqual(token["httpRequest"], {"status": 200})
                    self.assertNotIn("PRIVATE-", case["stdout"])
                else:
                    self.assertEqual(result["entries"], [entry()])
                self.assertEqual(result["nextPageToken"], "retained/+==")
                self.assertEqual(case["stderr"], "")

    def test_invalid_json_and_nonobject_response_cannot_return_a_page(self):
        for response, error in [("PRIVATE-SDK-ERROR", json.JSONDecodeError), ("[]", ValueError)]:
            with self.subTest(response=response):
                client = FakeClient({})
                client.List = lambda *args, **kwargs: response
                with self.assertRaises(error):
                    self.helper.read_page(client, FakeMessages, project=PROJECT,
                                          log_filter=FILTER, page_size=50)

    def test_sdk_value_error_never_exposes_exception_body(self):
        self.assert_cli_failure(ValueError("Bearer PRIVATE-SDK-ERROR"),
                                {"error": {"code": "sdk_error", "stage": "client_setup",
                                           "exceptionClass": "ValueError"}})

    def test_sdk_http_error_reports_status_without_private_body(self):
        error = RuntimeError("Bearer PRIVATE-SDK-ERROR https://private.example/request")
        error.status_code = 400
        self.assert_cli_failure(error, {"error": {"code": "http_error", "httpStatus": 400,
                                                 "stage": "client_setup", "exceptionClass": "RuntimeError"}})

    def test_sdk_unknown_exception_class_is_not_disclosed(self):
        error = type("PRIVATE-SDK-ERROR", (Exception,), {})("Bearer PRIVATE-SDK-ERROR")
        self.assert_cli_failure(error, {"error": {"code": "sdk_error", "stage": "client_setup",
                                                 "exceptionClass": "OtherError"}})

    def test_sdk_read_failure_reports_stage_without_disclosing_payload_or_cursor(self):
        error = json.JSONDecodeError("PRIVATE-SDK-ERROR", "PRIVATE-SDK-ERROR", 0)
        self.assert_cli_failure(error, {"error": {"code": "sdk_error", "stage": "read_page",
                                                 "exceptionClass": "JSONDecodeError"}}, during_read=True)

    def assert_cli_failure(self, failure, expected, during_read=False):
        import sys
        def rejected_client(*args, **kwargs):
            if during_read:
                client = FakeClient({})
                client.List = lambda *args, **kwargs: rejected_read()
                return client
            raise failure
        def rejected_read():
            raise failure
        property_stub = SimpleNamespace(Set=lambda value: None)
        modules = {
            "googlecloudsdk.api_lib.util": SimpleNamespace(apis=SimpleNamespace(
                GetMessagesModule=lambda *args: FakeMessages, GetClientInstance=rejected_client)),
            "googlecloudsdk.core.credentials": SimpleNamespace(creds_context_managers=SimpleNamespace(
                CredentialProvidersManager=contextlib.nullcontext)),
            "googlecloudsdk.core": SimpleNamespace(properties=SimpleNamespace(
                VALUES=SimpleNamespace(core=SimpleNamespace(account=property_stub, project=property_stub)))),
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

    def test_main_credential_providers_cover_client_and_request_and_cleanup(self):
        import sys
        for failure_at in (None, "client", "request"):
            with self.subTest(failure_at=failure_at):
                events = []
                active = False

                @contextlib.contextmanager
                def providers():
                    nonlocal active
                    active = True
                    events.append("enter")
                    try:
                        yield
                    finally:
                        active = False
                        events.append("exit")

                def check(stage):
                    self.assertTrue(active, f"credential provider missing during {stage}")
                    events.append(stage)
                    if failure_at == stage:
                        raise RuntimeError("synthetic SDK failure")

                class Client(FakeClient):
                    def List(client, request, global_params):
                        check("request")
                        return super().List(request, global_params)

                def client_factory(*args, **kwargs):
                    check("client")
                    return Client({"entries": []})

                properties_set = {}
                def prop(name):
                    return SimpleNamespace(Set=lambda value: properties_set.update({name: value}))
                modules = {
                    "googlecloudsdk.api_lib.util": SimpleNamespace(apis=SimpleNamespace(
                        GetMessagesModule=lambda *args: FakeMessages, GetClientInstance=client_factory)),
                    "googlecloudsdk.core.credentials": SimpleNamespace(creds_context_managers=SimpleNamespace(
                        CredentialProvidersManager=providers)),
                    "googlecloudsdk.core": SimpleNamespace(properties=SimpleNamespace(
                        VALUES=SimpleNamespace(core=SimpleNamespace(account=prop("account"), project=prop("project"))))),
                }
                with tempfile.TemporaryDirectory() as root:
                    package = Path(root) / "lib/googlecloudsdk"
                    package.mkdir(parents=True)
                    (package / "__init__.py").touch()
                    argv = ["--sdk-root", root, "--account", "fixture@example.com",
                            "--project", PROJECT, "--filter", FILTER, "--page-size", "1"]
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with patch.dict(sys.modules, modules), patch.dict(os.environ), patch.object(sys, "path", sys.path.copy()):
                        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                            code = self.helper.main(argv)
                            expected_events = ["enter", "client"]
                            if failure_at != "client":
                                expected_events.append("request")
                            expected_events.append("exit")
                            self.assertEqual(events, expected_events)
                            self.assertFalse(active)
                            self.assertEqual(code, 0 if failure_at is None else 1)
                            self.assertEqual(properties_set, {"account": "fixture@example.com", "project": PROJECT})
                            if failure_at:
                                self.assertEqual(stdout.getvalue(), "")
                            else:
                                self.assertEqual(json.loads(stdout.getvalue()), {
                                    "entries": [], "nextPageToken": None, "projectionTruncated": False})
                            events.clear()
                            argv[-1] = "0"
                            self.assertEqual(self.helper.main(argv), 2)
                            self.assertEqual(events, [], "rejected input must never reach SDK providers or API")

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

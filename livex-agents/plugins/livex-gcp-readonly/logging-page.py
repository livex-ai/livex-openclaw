#!/usr/bin/env python3
"""Read one Cloud Logging page through an operator-selected Cloud SDK.

The caller owns authorization, query generation, cancellation and redaction.
This process owns one API read and bounded projection, never pagination state.
SDK/auth imports occur only after CLI validation in main().
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys


MAX_ROW_BYTES = 4096
MAX_IDENTITY_BYTES = 3072
MAX_TOKEN_BYTES = 16384
CORRELATION_FIELDS = ("conversation_id", "job_id", "room_id", "room", "agent_id", "trace_id")
DIAGNOSTIC_FIELDS = ("message", "error", "stack", "filename", "lineno", "funcName", "exc_info")
API_FIELDS = (
    "entries(logName,timestamp,severity,insertId,resource(type,labels),trace,textPayload,"
    "jsonPayload),nextPageToken"
)
# jsonPayload is a protobuf Struct, not a schema of selectable application keys.
# Request the parent; project_entry still filters and bounds what leaves here.


class PageValidationError(ValueError):
    """Only fixed local diagnostics may be printed by the CLI."""


def encode_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def json_size(value):
    return len(encode_json(value).encode("utf-8"))


def validate_token(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str) or json_size(value) > MAX_TOKEN_BYTES:
        raise PageValidationError("Invalid continuation token")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise PageValidationError("Invalid continuation token")
    return value


def validate_query(project, log_filter, page_size, page_token):
    if not isinstance(project, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", project):
        raise PageValidationError("Invalid configured project")
    # Match buildLogFilter's literal escaping; hyphens need no regex escaping.
    escaped_project = re.sub(r"[.*+?^${}()|\[\]\\]", lambda match: "\\" + match[0], project)
    scope = "logName =~ " + encode_json(f"^projects/{escaped_project}/logs/")
    if (not isinstance(log_filter, str) or len(log_filter) > 19000
            or not log_filter.startswith(scope + " AND ")
            or any(ord(char) < 32 for char in log_filter)):
        raise PageValidationError("Query must use the configured project filter prefix")
    if isinstance(page_size, bool) or not isinstance(page_size, int) or not 1 <= page_size <= 50:
        raise PageValidationError("Page size must be between 1 and 50")
    validate_token(page_token)
    # Keep the fixed scope authoritative even if a caller accidentally adds a
    # top-level OR to the generated query. resourceNames is independently fixed.
    return f"({log_filter}) AND {scope}"


def identity_scalar(value):
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        raise PageValidationError("Invalid log identity field")
    return value


def project_entry(raw, project):
    if not isinstance(raw, dict):
        raise PageValidationError("Invalid log entry")
    if not isinstance(raw.get("logName"), str) or not raw["logName"].startswith(f"projects/{project}/logs/"):
        raise PageValidationError("Log entry is outside the configured project")
    if not isinstance(raw.get("timestamp"), str) or not raw["timestamp"]:
        raise PageValidationError("Invalid timestamp identity")
    row = {key: identity_scalar(raw[key]) for key in
           ("logName", "timestamp", "severity", "insertId", "trace") if key in raw}
    resource = raw.get("resource", {})
    labels = resource.get("labels", {}) if isinstance(resource, dict) else None
    if not isinstance(labels, dict):
        raise PageValidationError("Invalid resource identity")
    row["resource"] = {"labels": {key: identity_scalar(value) for key, value in labels.items()}}
    if "type" in resource:
        row["resource"]["type"] = identity_scalar(resource["type"])
    payload = raw.get("jsonPayload", {})
    if not isinstance(payload, dict):
        raise PageValidationError("Invalid log payload")
    row["jsonPayload"] = {key: identity_scalar(payload[key]) for key in
                          (*CORRELATION_FIELDS, "level", "levelname") if key in payload}
    if json_size(row) > MAX_IDENTITY_BYTES:
        raise PageValidationError("Log identity exceeds its bounded projection; no page was emitted")

    diagnostics = [(row, "textPayload", raw["textPayload"])] if "textPayload" in raw else []
    diagnostics += [(row["jsonPayload"], key, payload[key]) for key in DIAGNOSTIC_FIELDS if key in payload]
    # Error objects can carry unrelated customer fields; preserve only the
    # declared diagnostic members before shortening their representation.
    diagnostic_text = []
    for target, key, value in diagnostics:
        if isinstance(value, dict) and key == "error":
            value = {name: value[name] for name in ("name", "message", "code", "stack") if name in value}
        text = value if isinstance(value, str) else encode_json(value)
        diagnostic_text.append((target, key, text))
    field_limit = 2048
    while True:
        truncated = False
        for target, key, value in diagnostic_text:
            truncated |= len(value) > field_limit
            target[key] = value if len(value) <= field_limit else value[:field_limit] + "…"
        if json_size(row) <= MAX_ROW_BYTES:
            return row, truncated
        if field_limit == 0:
            raise PageValidationError("Log identity leaves no bounded diagnostic space")
        field_limit //= 2


def read_page(client, messages, to_dict, *, project, log_filter, page_size, page_token=None):
    guarded_filter = validate_query(project, log_filter, page_size, page_token)
    request = messages.ListLogEntriesRequest(
        resourceNames=[f"projects/{project}"], filter=guarded_filter,
        orderBy="timestamp desc", pageSize=page_size, pageToken=validate_token(page_token))
    response = to_dict(client.entries.List(
        request, global_params=messages.StandardQueryParameters(fields=API_FIELDS)))
    raw_entries = response.get("entries", [])
    if not isinstance(raw_entries, list) or len(raw_entries) > page_size:
        raise PageValidationError("Cloud Logging returned an invalid page size")
    cursor = validate_token(response.get("nextPageToken"))
    entries = []
    truncated = False
    for raw in raw_entries:
        projected, shortened = project_entry(raw, project)
        entries.append(projected)
        truncated |= shortened
    return {"entries": entries, "nextPageToken": cursor, "projectionTruncated": truncated}


def configure_sdk_environment(account, project):
    # Environment overrides also suppress values persisted in gcloud config.
    # The parent supplies only its approved CLOUDSDK_CONFIG and safe base env.
    os.environ.update({
        "CLOUDSDK_CORE_ACCOUNT": account,
        "CLOUDSDK_CORE_PROJECT": project,
        "CLOUDSDK_CORE_DISABLE_PROMPTS": "true",
        "CLOUDSDK_CORE_LOG_HTTP": "false",
        "CLOUDSDK_CORE_DISABLE_FILE_LOGGING": "true",
        "CLOUDSDK_CORE_UNIVERSE_DOMAIN": "googleapis.com",
        "CLOUDSDK_API_ENDPOINT_OVERRIDES_LOGGING": "https://logging.googleapis.com/",
        "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT": "",
        "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE": "",
        "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE": "",
        "CLOUDSDK_AUTH_ACCESS_TOKEN": "",
        "CLOUDSDK_AUTH_DISABLE_CREDENTIALS": "false",
    })
    os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--filter", required=True)
    parser.add_argument("--page-size", type=int, required=True)
    parser.add_argument("--page-token")
    args = parser.parse_args(argv)
    try:
        validate_query(args.project, args.filter, args.page_size, args.page_token)
        if not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]{1,253}", args.account) or len(args.account) > 254:
            raise PageValidationError("Invalid configured account")
        sdk_root = Path(args.sdk_root)
        if not sdk_root.is_absolute() or not (sdk_root / "lib/googlecloudsdk/__init__.py").is_file():
            raise PageValidationError("Invalid operator-configured Cloud SDK root")
        configure_sdk_environment(args.account, args.project)
        sys.path[:0] = [str(sdk_root / "lib"), str(sdk_root / "lib/third_party")]
        from googlecloudsdk.api_lib.util import apis
        from googlecloudsdk.core import properties
        from googlecloudsdk.core.credentials import creds_context_managers
        from apitools.base.py import encoding
        properties.VALUES.core.account.Set(args.account)
        properties.VALUES.core.project.Set(args.project)
        # Match gcloud: register attached-VM credential providers for the read.
        with creds_context_managers.CredentialProvidersManager():
            messages = apis.GetMessagesModule("logging", "v2")
            client = apis.GetClientInstance("logging", "v2", http_timeout_sec=25,
                                           skip_activation_prompt=True)
            result = read_page(client, messages, encoding.MessageToDict,
                               project=args.project, log_filter=args.filter,
                               page_size=args.page_size, page_token=args.page_token)
        # No partial stdout: errors cannot publish a continuation past lost rows.
        sys.stdout.write(encode_json(result) + "\n")
        return 0
    except PageValidationError as error:
        sys.stderr.write(f"Cloud Logging page rejected: {error}\n")
        return 2
    except Exception as error:
        # SDK error bodies can contain URLs, request data or credentials.
        # Only an HTTP status is allowed across this process boundary.
        try:
            status = error.status_code
        except (AttributeError, KeyError, TypeError, ValueError):
            status = None
        diagnostic = {"code": "sdk_error"}
        if type(status) is int and 400 <= status <= 599:
            diagnostic = {"code": "http_error", "httpStatus": status}
        sys.stderr.write(encode_json({"error": diagnostic}) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

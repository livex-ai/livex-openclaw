"""Validate immutable release identifiers before using them in paths or selectors."""

import json
import re


def release_arguments(args):
    if len(args) != 2 or not re.fullmatch("[0-9a-f]{40}", args[0]):
        raise ValueError("Expected a full lowercase Git commit SHA")
    if not re.fullmatch("sha256:[0-9a-f]{64}", args[1]):
        raise ValueError("Expected the immutable running image ID")
    return tuple(args)


def select_image(content, previous, candidate):
    """Change one image assignment and preserve every other byte."""
    pattern = rb"(?m)^OPENCLAW_IMAGE=([^\r\n]+)(?=\r?$)"
    if re.findall(pattern, content) != [previous.encode()]:
        raise ValueError("Unexpected or duplicate OPENCLAW_IMAGE in release.env")
    return re.sub(pattern, b"OPENCLAW_IMAGE=" + candidate.encode(), content)


def verify_base_checkpoint(receipts, command, image_id, log):
    """Only reuse the completed base recorded by this BuildKit invocation."""
    if (
        len(receipts) != 1
        or receipts[0].get("name") != "base"
        or receipts[0].get("exit") != 0
        or receipts[0].get("command") != command
    ):
        raise ValueError("No matching successful base-only receipt")
    if not re.fullmatch("sha256:[0-9a-f]{64}", image_id) or not re.search(
        r"(?m)^#\d+ exporting (?:manifest list|manifest|config) "
        + re.escape(image_id)
        + r"(?: |$)",
        log,
    ):
        raise ValueError("Base image ID does not match the recorded export")


def concurrency_limit(value):
    if type(value) is not int or value < 1:
        raise ValueError(
            "Expected a positive integer for agents.defaults.maxConcurrent"
        )
    return value


def with_concurrency(content, target):
    """Overlay the one Git-owned field onto the installed VM JSON."""
    concurrency_limit(target)

    def unique_object(pairs):
        obj = dict(pairs)
        if len(obj) != len(pairs):
            raise ValueError("Ambiguous duplicate keys in VM config")
        return obj

    config = json.loads(content, object_pairs_hook=unique_object)
    defaults = config.setdefault("agents", {}).setdefault("defaults", {})
    if (
        type(defaults.get("maxConcurrent")) is int
        and defaults["maxConcurrent"] == target
    ):
        return content
    defaults["maxConcurrent"] = target
    return (
        json.dumps(config, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    ).encode()


def reviewed_prompt_hash(manifest):
    match = re.fullmatch(r"([0-9a-f]{64})  AGENTS\.md\n", manifest)
    if not match:
        raise ValueError("Expected a single reviewed oncall prompt digest")
    return match[1]


def slack_progress_settings(streaming):
    """Select only the Git-owned presentation fields, never channel policy or secrets."""
    if not isinstance(streaming, dict) or not isinstance(streaming.get("progress"), dict):
        raise ValueError("Expected explicit Slack streaming and progress objects")
    progress = streaming.get("progress", {})
    settings = {
        "mode": streaming.get("mode"),
        "nativeTransport": streaming.get("nativeTransport"),
        "progress": {key: progress.get(key) for key in (
            "style", "nativeTaskCards", "toolProgress", "commandText", "commentary", "narration"
        )},
    }
    if (settings.get("mode") != "progress"
            or type(settings.get("nativeTransport")) is not bool
            or progress.get("style") not in ("card", "compact")
            or progress.get("commandText") != "status"
            or any(type(progress.get(key)) is not bool for key in (
                "nativeTaskCards", "toolProgress", "commentary", "narration"
            ))):
        raise ValueError("Expected complete Slack progress settings with safe commandText=status")
    return settings


def require_slack_progress(config, target):
    slack = config.get("channels", {}).get("slack", {})
    root = slack.get("streaming", {})
    for account in [slack, *slack.get("accounts", {}).values()]:
        streaming = account.get("streaming", {})
        effective = {**root, **streaming,
                     "progress": {**root.get("progress", {}), **streaming.get("progress", {})}}
        if slack_progress_settings(effective) != target:
            raise ValueError("Slack progress differs from Git settings; reconcile account overrides")


def with_slack_progress(content, target):
    target = slack_progress_settings(target)
    config = json.loads(content)
    streaming = config.setdefault("channels", {}).setdefault("slack", {}).setdefault("streaming", {})
    streaming.update(mode=target.get("mode"), nativeTransport=target.get("nativeTransport"))
    streaming.setdefault("progress", {}).update(target.get("progress"))
    # Account overrides remain operator-owned. A conflicting override must not
    # silently defeat the selected presentation or be overwritten during deploy.
    require_slack_progress(config, target)
    return (json.dumps(config, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()


def require_vm_policies(content):
    config = json.loads(content)
    agent = config["agents"]["entries"]["oncall"]
    actions = agent.get("tools", {}).get("message", {}).get("actions", {})
    slack = config.get("channels", {}).get("slack", {})
    if agent.get("permissionModeDefault") != "read-only" or actions.get("allow") != [
        "read"
    ]:
        raise RuntimeError(
            "Expected the VM read-only session and Slack message policies"
        )
    for account in [slack, *slack.get("accounts", {}).values()]:
        if any(
            account.get(key, slack.get(key)) != ""
            for key in ("ackReaction", "typingReaction")
        ):
            raise RuntimeError(
                "Expected Slack acknowledgement and typing reactions off"
            )

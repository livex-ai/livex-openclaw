"""Validate immutable release identifiers before using them in paths or selectors."""

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

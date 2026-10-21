#!/usr/bin/env python3
"""Prepare local Slack account patches without changing the Gateway."""

import argparse
import copy
import json
import os
from pathlib import Path
import re


def prepare(config):
    slack = config.get("channels", {}).get("slack", {})
    providers = config.get("secrets", {}).get("providers", {})
    if slack.get("enabled") is not True:
        raise ValueError("Enable and verify the default Slack account before cutover.")
    if slack.get("accounts") or slack.get("defaultAccount") or "slack-oncall" in providers:
        raise ValueError("Review the existing named accounts and providers before a manual cutover.")
    sender = config.get("plugins", {}).get("entries", {}).get("livex-gcp-readonly", {}).get("config", {}).get("allowedSenderId")
    if not isinstance(sender, str) or not re.fullmatch(r"[UW][A-Z0-9]{8,}", sender):
        raise ValueError("Configure one explicit Slack caller in the GCP reader first.")
    if slack.get("allowFrom") != [sender] or slack.get("channels", {}).get("*", {}).get("users") != [sender]:
        raise ValueError("The Slack caller rules must match the GCP reader caller before cutover.")
    channel_policy = slack["channels"]
    if set(channel_policy) != {"*"} or channel_policy["*"].get("enabled") is not True:
        raise ValueError("Reconcile the existing channel policy before replacing it with the oncall wildcard policy.")
    bindings = config.get("bindings", [])
    target = {"agentId": "oncall", "match": {"channel": "slack", "accountId": "default", "peer": {"kind": "channel", "id": "*"}}}
    if not isinstance(bindings, list) or bindings.count(target) != 1:
        raise ValueError("Expected one wildcard Slack default-account binding to the oncall agent.")
    for binding in bindings:
        match = binding.get("match", {})
        if binding != target and match.get("channel") == "slack" and match.get("accountId") in (None, "default"):
            raise ValueError("Reconcile additional Slack default-account bindings before disabling that account.")

    directory = Path(__file__).parent
    cutover = json.loads((directory / "account-cutover.patch.json").read_text())
    rollback = json.loads((directory / "rollback-account-cutover.patch.json").read_text())
    account = cutover["channels"]["slack"]["accounts"]["oncall"]
    account["allowFrom"] = [sender]
    account["channels"]["*"]["users"] = [sender]
    cutover["bindings"] = copy.deepcopy(bindings)
    cutover["bindings"][bindings.index(target)]["match"]["accountId"] = "oncall"
    rollback["bindings"] = copy.deepcopy(bindings)
    return cutover, rollback


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text())
        cutover, rollback = prepare(config)
        args.output_dir.mkdir(mode=0o700)
        for name, patch in (("account-cutover.patch.json", cutover), ("rollback-account-cutover.patch.json", rollback)):
            file_path = args.output_dir / name
            descriptor = os.open(file_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as output:
                json.dump(patch, output, indent=2)
                output.write("\n")
    except (OSError, ValueError) as error:
        parser.exit(1, f"Cannot prepare cutover: {error}\n")
    print("Prepared cutover and rollback patches. Review them before applying. Gateway configuration is unchanged.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Render the non-secret pilot patch and use OpenClaw's supported publisher."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
PLACEHOLDER = re.compile(r"\$\{([A-Z_]+)\}")
LOCAL_PATH_KEYS = {"gcloudPath", "cloudSdkConfig", "openclawCommand", "pythonPath", "gcloudSdkRoot"}
LOCAL_KEYS = LOCAL_PATH_KEYS | {"gcloudAccount", "project", "slackSenderId"}
GCLOUD_ACCOUNT = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def render(root, local_path):
    settings = read_json(local_path)
    if not isinstance(settings, dict) or set(settings) != LOCAL_KEYS:
        raise ValueError("Local settings must contain exactly: " + ", ".join(sorted(LOCAL_KEYS)))
    if any(not isinstance(settings[key], str) or not Path(settings[key]).is_absolute()
           for key in LOCAL_PATH_KEYS):
        raise ValueError("Local settings paths must be absolute paths")
    account = settings["gcloudAccount"]
    if not isinstance(account, str) or len(account) > 254 or not GCLOUD_ACCOUNT.fullmatch(account):
        raise ValueError("gcloudAccount must be an email-style account of at most 254 characters")
    project = settings["project"]
    if not isinstance(project, str) or not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise ValueError("project must be a Google Cloud project ID")
    sender = settings["slackSenderId"]
    if not isinstance(sender, str) or not re.fullmatch(r"[UW][A-Z0-9]{8,}", sender):
        raise ValueError("slackSenderId must be one Slack user ID")
    values = {
        "PACKAGE_ROOT": str(root.resolve()),
        "GCLOUD_PATH": settings["gcloudPath"],
        "CLOUDSDK_CONFIG": settings["cloudSdkConfig"],
        "GCLOUD_ACCOUNT": account,
        "PYTHON_PATH": settings["pythonPath"],
        "GCLOUD_SDK_ROOT": settings["gcloudSdkRoot"],
        "GCP_PROJECT": project,
        "SLACK_SENDER_ID": sender,
        "INVESTIGATOR_PROMPT": (root / "prompts/investigator.md").read_text(encoding="utf-8").strip(),
    }

    def substitute(match):
        key = match.group(1)
        if key not in values:
            raise ValueError("Unknown placeholder: " + key)
        return values[key]

    def expand(value):
        if isinstance(value, str):
            return PLACEHOLDER.sub(substitute, value)
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, dict):
            return {key: expand(item) for key, item in value.items()}
        return value

    return expand(read_json(root / "config/openclaw.template.json")), settings


def publish(payload, settings, *, apply):
    # Never read, overwrite, or copy the live config or credential store here.
    # The host CLI owns merging, secret resolution, backups and state ownership.
    with tempfile.TemporaryDirectory(prefix="livex-dog-config-") as directory:
        path = Path(directory) / "openclaw.patch.json"
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        command = [settings["openclawCommand"], "config", "patch", "--file", str(path)]
        subprocess.run(command + ["--dry-run", "--json"], check=True)
        if apply:
            subprocess.run(command, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("render", "validate", "apply"))
    parser.add_argument("--local", type=Path, default=ROOT / "config/local.json")
    parser.add_argument("--output", type=Path, help="Render output path; defaults to stdout")
    args = parser.parse_args()
    if args.output and args.command != "render":
        parser.error("--output is only supported with render")
    try:
        payload, settings = render(ROOT, args.local)
        if args.command == "render":
            content = json.dumps(payload, indent=2) + "\n"
            if args.output:
                # Limit generated artifacts to the ignored output directory.
                output = args.output.resolve()
                if (ROOT / "generated").resolve() not in output.parents:
                    raise ValueError("--output must be inside the package generated/ directory")
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(content, encoding="utf-8")
                print("Rendered " + str(output))
            else:
                print(content, end="")
        else:
            publish(payload, settings, apply=args.command == "apply")
    except subprocess.CalledProcessError as error:
        return error.returncode
    except (OSError, ValueError, KeyError) as error:
        print("Configuration error: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

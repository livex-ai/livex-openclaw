"""Verify or explicitly apply the five-run profile to the installed oncall VM."""

import argparse
import fcntl
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path("/opt/livex-openclaw")
CONTAINER = "livex-openclaw-dev-gateway-1"
KEY = "agents.defaults.maxConcurrent"
TARGET = 5


def cli(*args):
    return subprocess.check_output(
        ["docker", "exec", CONTAINER, "node", "/app/openclaw.mjs", *args],
        text=True,
        timeout=90,
    )


def main_lane():
    reply = json.loads(
        cli("gateway", "call", "diagnostics.lanes", "--params", "{}", "--json")
    )
    (lane,) = [row for row in reply["lanes"] if row["lane"] == "main"]
    return lane["maxConcurrent"]


def configured():
    return json.loads(cli("config", "get", KEY, "--json"))


def check():
    saved, active = configured(), main_lane()
    print(f"{KEY}={saved}, live main lane={active}", flush=True)
    return saved, active


def apply():
    saved, active = check()
    if saved == active == TARGET:
        return
    if saved not in (1, TARGET):
        raise SystemExit(f"Unexpected existing limit {saved}. Review before applying.")
    if saved != TARGET:
        # Back up the exact mount that the native CLI is about to edit.
        mounts = json.loads(
            subprocess.check_output(
                ["docker", "inspect", "--format", "{{json .Mounts}}", CONTAINER],
                text=True,
            )
        )
        if not any(
            m["Destination"] == "/home/node/.openclaw"
            and m["Source"] == str(ROOT / "state")
            and m["RW"]
            for m in mounts
        ):
            raise SystemExit("Unexpected Gateway state mount")
        command = ("config", "set", KEY, str(TARGET), "--strict-json")
        cli(*command, "--dry-run")
        backup = Path(tempfile.mkdtemp(prefix="pre-concurrency-", dir=ROOT / "backups"))
        shutil.copyfile(ROOT / "state/openclaw.json", backup / "openclaw.json")
        print(f"Private config backup: {backup}", flush=True)
        cli(*command)
        cli("config", "validate", "--json")
    if configured() != TARGET:
        raise SystemExit("Saved concurrency did not match the requested value")
    for attempt in range(6):
        if main_lane() == TARGET:
            print("Verified saved concurrency and live main lane are both 5.")
            return
        if attempt < 5:
            time.sleep(2)
    raise SystemExit(
        "Config is saved at 5. Live lane did not reload; inspect Gateway reload settings."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true", help="back up and update the running VM config"
    )
    args = parser.parse_args()
    if args.apply:
        os.umask(0o077)
        with (ROOT / "deploy.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            apply()
    else:
        check()

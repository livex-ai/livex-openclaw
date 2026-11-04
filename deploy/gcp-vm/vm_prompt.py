"""Install only the reviewed oncall prompt in the mounted VM workspace."""

import hashlib
import json
import os
import re
import secrets
import stat
from contextlib import ExitStack, contextmanager

WORKSPACE = "/home/node/.openclaw/workspace"
NAME = "AGENTS.md"
BUNDLED = "/opt/oncall/workspace/" + NAME

# First migration: these running revision and mounted bytes were reviewed together.
LEGACY_SOURCE = "dbfb6fcab75f4abdebefba51305921c53c7cd6f2"
LEGACY_SHA = "e5dc44fbc4b0eee5d707be4b87465ceed61074bffc214cf1fa88c8bb2d625a62"


def sha(content):
    return hashlib.sha256(content).hexdigest()


def prior_hash(root, container):
    revision = container["Config"]["Labels"]["org.opencontainers.image.revision"]
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError("Invalid running source revision")
    previous = json.loads(
        (root / "releases" / revision / "image-receipt.json").read_bytes()
    )
    if previous["source"] != revision or previous["image"] != container["Image"]:
        raise RuntimeError("Previous prompt baseline belongs to a different image")
    if revision == LEGACY_SOURCE and "oncallPromptSha256" not in previous:
        return LEGACY_SHA
    value = previous.get("oncallPromptSha256")
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise RuntimeError("Previous release lacks a reviewed prompt baseline")
    return value


def verify_active(rpc, expected):
    result = rpc(
        "agents.files.get",
        {"agentId": "oncall", "name": NAME},
        {"agentId", "workspace", "file"},
    )
    file = result["file"]
    if (
        result["agentId"] != "oncall"
        or result["workspace"] != WORKSPACE
        or file.get("path") != WORKSPACE + "/" + NAME
        or file.get("missing") is not False
        or file.get("hash") != expected
        or not isinstance(file.get("content"), str)
        or sha(file["content"].encode()) != expected
    ):
        raise RuntimeError("Active oncall workspace prompt hash or path mismatch")
    return expected


@contextmanager
def workspace_fd(root):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    with ExitStack() as stack:
        directory = os.open(root / "state", flags)
        stack.callback(os.close, directory)
        workspace = os.open("workspace", flags, dir_fd=directory)
        stack.callback(os.close, workspace)
        yield workspace


def _read(fd):
    raw = os.open(NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(raw, "rb") as source:
        meta = os.fstat(raw)
        if (
            not stat.S_ISREG(meta.st_mode)
            or meta.st_nlink != 1
            or meta.st_size > 128 * 1024
        ):
            raise RuntimeError("Expected a private regular oncall prompt")
        return source.read(128 * 1024 + 1), meta


def read_prompt(root):
    with workspace_fd(root) as fd:
        return _read(fd)[0]


def install_prompt(root, expected, replacement):
    with workspace_fd(root) as fd:
        current, meta = _read(fd)
        if current != expected:
            raise RuntimeError(
                "Mounted oncall prompt changed externally; reconcile before replacement"
            )
        if current == replacement:
            return
        temp = ".oncall-prompt-" + secrets.token_hex(16)
        raw = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
        try:
            with os.fdopen(raw, "wb") as dest:
                os.fchown(raw, meta.st_uid, meta.st_gid)
                os.fchmod(raw, stat.S_IMODE(meta.st_mode))
                dest.write(replacement)
                dest.flush()
                os.fsync(raw)
            if _read(fd)[0] != expected:
                raise RuntimeError("Oncall prompt changed during installation")
            os.replace(temp, NAME, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            try:
                os.unlink(temp, dir_fd=fd)
            except FileNotFoundError:
                pass

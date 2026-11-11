"""Install reviewed agent prompts inside the mounted VM state."""

import hashlib
import json
import os
import re
import secrets
import stat
from contextlib import ExitStack, contextmanager

from agent_bundle import workspace

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


def verify_active(rpc, expected, agent_id="oncall"):
    expected_workspace = workspace(agent_id)
    result = rpc(
        "agents.files.get",
        {"agentId": agent_id, "name": NAME},
        {"agentId", "workspace", "file"},
    )
    file = result["file"]
    if (
        result["agentId"] != agent_id
        or result["workspace"] != expected_workspace
        or file.get("path") != expected_workspace + "/" + NAME
        or file.get("missing") is not False
        or file.get("hash") != expected
        or not isinstance(file.get("content"), str)
        or sha(file["content"].encode()) != expected
    ):
        raise RuntimeError("Active agent workspace prompt hash or path mismatch")
    return expected


@contextmanager
def workspace_fd(root, agent_id="oncall", create=False):
    if not re.fullmatch(r"[a-z0-9_][a-z0-9_-]{0,63}", agent_id):
        raise ValueError("Invalid managed agent ID")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    with ExitStack() as stack:
        directory = os.open(root / "state", flags)
        stack.callback(os.close, directory)
        owner = os.fstat(directory)
        parts = ["workspace"] if agent_id == "oncall" else ["workspaces", agent_id]
        for part in parts:
            created = False
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=directory)
                    created = True
                except FileExistsError:
                    pass
            child = os.open(part, flags, dir_fd=directory)
            stack.callback(os.close, child)
            if created:
                os.fchown(child, owner.st_uid, owner.st_gid)
                os.fsync(directory)
            directory = child
        yield directory


def _read(fd):
    raw = os.open(NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(raw, "rb") as source:
        meta = os.fstat(raw)
        if (
            not stat.S_ISREG(meta.st_mode)
            or meta.st_nlink != 1
            or meta.st_size > 128 * 1024
        ):
            raise RuntimeError("Expected a private regular agent prompt")
        return source.read(128 * 1024 + 1), meta


def _optional_read(fd):
    try:
        return _read(fd)
    except FileNotFoundError:
        return None, None


def read_prompt(root, agent_id="oncall"):
    try:
        with workspace_fd(root, agent_id) as fd:
            return _optional_read(fd)[0]
    except FileNotFoundError:
        return None


def install_prompt(root, expected, replacement, agent_id="oncall"):
    with workspace_fd(root, agent_id, create=replacement is not None) as fd:
        current, meta = _optional_read(fd)
        if current != expected:
            raise RuntimeError("Mounted agent prompt changed externally; reconcile before replacement")
        if current == replacement:
            return
        if replacement is None:
            os.unlink(NAME, dir_fd=fd)
            os.fsync(fd)
            return
        if meta is None:
            meta = os.fstat(fd)
            mode = 0o600
        else:
            mode = stat.S_IMODE(meta.st_mode)
        temp = ".agent-prompt-" + secrets.token_hex(16)
        raw = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
        try:
            with os.fdopen(raw, "wb") as dest:
                os.fchown(raw, meta.st_uid, meta.st_gid)
                os.fchmod(raw, mode)
                dest.write(replacement)
                dest.flush()
                os.fsync(raw)
            if _optional_read(fd)[0] != expected:
                raise RuntimeError("Agent prompt changed during installation")
            os.replace(temp, NAME, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            try:
                os.unlink(temp, dir_fd=fd)
            except FileNotFoundError:
                pass

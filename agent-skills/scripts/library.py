#!/usr/bin/env python3
"""Validate and copy a pinned skill profile; never activate or execute skills."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit


def _safe_path(root: Path, relative: str) -> Path:
    if (not isinstance(relative, str) or not relative or "\\" in relative
            or "\x00" in relative or relative.startswith("/")
            or any(part in ("", ".", "..") for part in relative.split("/"))):
        raise ValueError(f"unsafe library path: {relative!r}")
    path = root
    for part in PurePosixPath(relative).parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f"symlink is not allowed: {path}")
    if not path.resolve().is_relative_to(root):
        raise ValueError(f"path escapes library: {relative}")
    return path


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _read_json(root: Path, name: str) -> dict:
    value = json.loads(_safe_path(root, name).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{name} must contain an object")
    return value


def _list(value, label: str) -> list:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be a list")
    return value


def _frontmatter(path: Path, name: str) -> None:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "---" or "---" not in lines[1:]:
        raise ValueError(f"missing frontmatter: {path}")
    names = [line[5:].strip() for line in lines[1:lines.index("---", 1)]
             if line.startswith("name:")]
    if len(names) != 1 or names[0] not in {name, f"'{name}'", f'"{name}"'}:
        raise ValueError(f"frontmatter name must match {name}: {path}")


def _markdown_destinations(contents: str):
    # This intentionally checks ordinary inline/reference links, not the full
    # Markdown grammar. Fenced and inline code are illustrative, not dependencies.
    prose = []
    fence = None
    for line in contents.splitlines():
        marker = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if marker:
            run = marker.group(1)
            if fence is None:
                fence = run
            elif run[0] == fence[0] and len(run) >= len(fence):
                fence = None
            continue
        if fence is None:
            prose.append(line)
    text = re.sub(r"(`+).*?\1", "", "\n".join(prose), flags=re.DOTALL)
    pattern = r"\]\(\s*(<[^>]+>|[^\s)]+)|^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)"
    for match in re.finditer(pattern, text, flags=re.MULTILINE):
        yield (match.group(1) or match.group(2)).strip("<>")


def _dependencies(root: Path, relative: str):
    if not relative.lower().endswith(".md"):
        return
    source = root / relative
    for destination in _markdown_destinations(source.read_text(encoding="utf-8")):
        url = urlsplit(destination)
        if url.scheme or url.netloc or not url.path:
            continue
        target = source.parent / unquote(url.path)
        # Inspect the original route before resolve() erases symlink evidence.
        for component in (target, *target.parents):
            if component == root:
                break
            if component.is_symlink():
                raise ValueError(f"symlink in Markdown link: {relative}: {destination}")
        resolved = target.resolve()
        if not resolved.is_relative_to(root):
            raise ValueError(f"Markdown link escapes library: {relative}: {destination}")
        dependency = resolved.relative_to(root).as_posix()
        _safe_path(root, dependency)
        yield dependency


def _check_links(root: Path, files: dict[str, str]) -> None:
    for relative in files:
        for dependency in _dependencies(root, relative):
            if dependency not in files:
                raise ValueError(f"missing Markdown dependency: {relative}: {dependency}")


def _validated(root: Path):
    if root.is_symlink():
        raise ValueError(f"symlink library root is not allowed: {root}")
    root = root.resolve(strict=True)
    manifest = _read_json(root, "sources.json")
    profiles = _read_json(root, "profiles.json")
    skills = {}
    files = {}

    def add_file(record):
        if not isinstance(record, dict):
            raise ValueError("file entries must be objects")
        relative = record.get("path")
        path = _safe_path(root, relative)
        if relative in files:
            raise ValueError(f"duplicate manifest file: {relative}")
        if not path.is_file():
            raise ValueError(f"missing or non-regular file: {relative}")
        actual = _hash(path)
        if record.get("sha256") != actual:
            raise ValueError(f"sha256 mismatch: {relative}")
        files[relative] = actual
        return relative

    for skill in _list(manifest.get("skills"), "skills"):
        if not isinstance(skill, dict):
            raise ValueError("skill entries must be objects")
        name = skill.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
            raise ValueError(f"invalid skill name: {name!r}")
        if name in skills:
            raise ValueError(f"duplicate skill: {name}")
        prefix = f"skills/{name}/"
        if skill.get("path") != prefix + "SKILL.md":
            raise ValueError(f"skill path must match its name: {name}")
        bundle = [add_file(skill)]
        for record in _list(skill.get("files", []), f"{name}.files"):
            relative = add_file(record)
            if not relative.startswith(prefix):
                raise ValueError(f"support file must be inside {prefix}: {relative}")
            bundle.append(relative)
        _frontmatter(root / skill["path"], name)
        skills[name] = bundle

    skill_root = _safe_path(root, "skills")
    actual_files = set()
    for path in skill_root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"symlink is not allowed: {path}")
        if path.is_file():
            actual_files.add(path.relative_to(root).as_posix())
        elif not path.is_dir():
            raise ValueError(f"non-regular bundle entry: {path}")
    if actual_files != set(files):
        raise ValueError(f"skill inventory differs from manifest: {sorted(actual_files ^ set(files))}")

    shared = []
    for record in _list(manifest.get("sharedFiles", []), "sharedFiles"):
        relative = add_file(record)
        if relative.startswith("skills/") or relative in {"sources.json", "profiles.json", "skills-lock.json"}:
            raise ValueError(f"invalid shared-file path: {relative}")
        shared.append(relative)
    for name, selection in profiles.items():
        selected = _list(selection, f"profile {name}")
        if not selected or any(not isinstance(item, str) or item not in skills for item in selected):
            raise ValueError(f"profile {name} must select known skills")
        if len(selected) != len(set(selected)):
            raise ValueError(f"duplicate skill in profile {name}")
    _check_links(root, files)
    return root, profiles, skills, shared, files


def validate(root: Path | str) -> None:
    """Raise ValueError/OSError for invalid manifests, bundles, or dependencies."""
    _validated(Path(root))


def _source_state(root: Path) -> dict:
    state = {"root": str(root), "revision": None, "dirty": None}
    try:
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("GIT_")}
        result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                                capture_output=True, text=True, timeout=10, check=False,
                                env=environment)
        status = subprocess.run(["git", "-C", str(root), "status", "--porcelain",
                                 "--untracked-files=normal", "--", "."],
                                capture_output=True, text=True, timeout=10, check=False,
                                env=environment)
    except (OSError, subprocess.TimeoutExpired):
        return state
    revision = result.stdout.strip()
    if status.returncode == 0:
        state["dirty"] = bool(status.stdout)
        if result.returncode == 0 and re.fullmatch(r"[0-9a-f]{40,64}", revision):
            state["revision"] = revision
    return state


def export_profile(root: Path | str, profile: str, target: Path | str) -> Path:
    """Stage checked copies, then reserve a fresh target. Never replace a target.

    Publication uses exclusive mkdir, not a whole-directory transaction. An I/O
    failure during final moves may leave an incomplete new target for inspection.
    """
    root, profiles, skills, shared, files = _validated(Path(root))
    if profile not in profiles:
        raise ValueError(f"unknown profile: {profile}")
    target = Path(target).expanduser().absolute()
    resolved_target = target.resolve()
    if resolved_target.is_relative_to(root) or root.is_relative_to(resolved_target):
        raise ValueError(f"target overlaps source library: {target}")
    if target.exists() or target.is_symlink():
        raise FileExistsError(f"target already exists: {target}")
    selected = {relative: files[relative] for name in profiles[profile] for relative in skills[name]}
    pending = list(selected)
    for relative in pending:
        for dependency in _dependencies(root, relative):
            if dependency in shared and dependency not in selected:
                selected[dependency] = files[dependency]
                pending.append(dependency)
    _check_links(root, selected)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{target.name}-", dir=target.parent) as temporary:
        staged = Path(temporary)
        for relative, expected in sorted(selected.items()):
            source = _safe_path(root, relative)
            destination = staged / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination, follow_symlinks=False)
            if destination.is_symlink() or _hash(destination) != expected:
                raise ValueError(f"source changed during export: {relative}")
        lock = {"version": 1, "profile": profile, "skills": profiles[profile],
                "source": _source_state(root),
                "files": [{"path": path, "sha256": sha} for path, sha in sorted(selected.items())]}
        (staged / "skills-lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
        target.mkdir()  # Exclusive reservation also refuses a concurrently created target.
        for entry in staged.iterdir():
            entry.rename(target / entry.name)
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("validate", help="verify manifests and complete skill bundles")
    export = commands.add_parser("export", help="copy a profile into a fresh directory")
    export.add_argument("--profile", required=True)
    export.add_argument("--target", required=True)
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    try:
        if args.command == "validate":
            validate(root)
            print("Skill library validated.")
        else:
            target = export_profile(root, args.profile, args.target)
            print(f"Exported {args.profile} to {target}")
    except (ValueError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

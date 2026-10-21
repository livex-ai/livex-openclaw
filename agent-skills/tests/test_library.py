"""Behavior checks for the standalone shared-skill validator/exporter."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "library.py"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "library.py must implement validation and export")
        spec = importlib.util.spec_from_file_location("skill_library", SCRIPT)
        self.library = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.library)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "library"
        self.root.mkdir()
        self.write("skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Example\n---\n[Guide](references/guide.md)\n[Replay](../../tests/replay-template.md)\n")
        self.write("skills/alpha/references/guide.md", "Use the evidence.\n")
        self.write("skills/alpha/LICENSE", "Example license, retained verbatim.\n")
        self.write("skills/alpha/tools/check.sh", "#!/bin/sh\nexit 42\n")
        (self.root / "skills/alpha/tools/check.sh").chmod(0o755)
        self.write("skills/beta/SKILL.md", "---\nname: 'beta'\ndescription: Another example\n---\nReady.\n")
        self.write("tests/replay-template.md", "# Replay\nRecord observed results.\n")
        self.manifest = {"skills": [self.skill_record("alpha"), self.skill_record("beta")],
                         "sharedFiles": [self.record("tests/replay-template.md")]}
        self.save_manifest()
        self.write("profiles.json", json.dumps({"all": ["alpha", "beta"], "focused": ["alpha"]}))

    def write(self, relative, contents):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")

    def record(self, relative):
        return {"path": relative, "sha256": digest(self.root / relative)}

    def skill_record(self, name):
        main = f"skills/{name}/SKILL.md"
        support = sorted(p.relative_to(self.root).as_posix()
                         for p in (self.root / "skills" / name).rglob("*")
                         if p.is_file() and p.name != "SKILL.md")
        return {"name": name, **self.record(main), "importedSha256": "0" * 64,
                "files": [self.record(path) for path in support]}

    def save_manifest(self):
        self.write("sources.json", json.dumps(self.manifest))

    def refresh_alpha(self):
        self.manifest["skills"][0] = self.skill_record("alpha")
        self.save_manifest()

    def test_valid_library_uses_current_hash_not_imported_hash(self):
        self.library.validate(self.root)

    def test_exports_complete_selected_bundle_and_shared_template(self):
        target = self.base / "export"
        self.library.export_profile(self.root, "focused", target)
        expected = {p.relative_to(self.root).as_posix(): p.read_bytes()
                    for p in (self.root / "skills/alpha").rglob("*") if p.is_file()}
        expected["tests/replay-template.md"] = (self.root / "tests/replay-template.md").read_bytes()
        exported = {p.relative_to(target).as_posix(): p.read_bytes()
                    for p in target.rglob("*") if p.is_file() and p.name != "skills-lock.json"}
        self.assertEqual(exported, expected)
        self.assertEqual((target / "skills/alpha/tools/check.sh").stat().st_mode & 0o777, 0o755)
        self.assertFalse((target / "skills/beta").exists())

    def test_profile_can_select_multiple_skills(self):
        target = self.base / "export"
        self.library.export_profile(self.root, "all", target)
        self.assertEqual({p.name for p in (target / "skills").iterdir()}, {"alpha", "beta"})

    def test_tampered_main_or_support_or_shared_file_rejected(self):
        for relative in ("skills/alpha/SKILL.md", "skills/alpha/LICENSE", "tests/replay-template.md"):
            with self.subTest(relative=relative):
                path = self.root / relative
                original = path.read_bytes()
                path.write_bytes(original + b"changed")
                with self.assertRaisesRegex(ValueError, "hash|sha256|checksum"):
                    self.library.validate(self.root)
                path.write_bytes(original)

    def test_untracked_hidden_bundle_file_rejected(self):
        self.write("skills/alpha/.hidden", "unexpected")
        with self.assertRaisesRegex(ValueError, "inventory|untracked|undeclared"):
            self.library.validate(self.root)

    def test_missing_support_file_rejected(self):
        (self.root / "skills/alpha/LICENSE").unlink()
        with self.assertRaises((ValueError, OSError)):
            self.library.validate(self.root)

    def test_manifest_traversal_and_absolute_paths_rejected(self):
        for path in ("../outside", "/tmp/outside", "skills/alpha/../../../outside", "skills\\alpha\\SKILL.md"):
            with self.subTest(path=path):
                self.manifest["skills"][0]["path"] = path
                self.save_manifest()
                with self.assertRaises(ValueError):
                    self.library.validate(self.root)

    def test_support_file_cannot_belong_to_another_bundle(self):
        self.manifest["skills"][0]["files"].append(self.record("skills/beta/SKILL.md"))
        self.save_manifest()
        with self.assertRaises(ValueError):
            self.library.validate(self.root)

    def test_symlink_file_and_directory_rejected(self):
        path = self.root / "skills/alpha/LICENSE"
        outside = self.base / "license"
        outside.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.library.validate(self.root)
        path.unlink()
        path.write_bytes(outside.read_bytes())
        (self.root / "skills/alpha/linked").symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.library.validate(self.root)

    def test_frontmatter_name_must_match_bundle_directory(self):
        self.write("skills/alpha/SKILL.md", "---\nname: wrong\ndescription: Example\n---\n")
        self.refresh_alpha()
        with self.assertRaisesRegex(ValueError, "frontmatter|name"):
            self.library.validate(self.root)

    def test_existing_target_and_its_files_are_preserved(self):
        target = self.base / "export"
        target.mkdir()
        (target / "user-file").write_text("keep me")
        with self.assertRaises((ValueError, OSError)):
            self.library.export_profile(self.root, "focused", target)
        self.assertEqual(list(target.iterdir()), [target / "user-file"])
        self.assertEqual((target / "user-file").read_text(), "keep me")

    def test_existing_empty_target_and_dangling_symlink_are_refused(self):
        target = self.base / "empty"
        target.mkdir()
        with self.assertRaises((ValueError, OSError)):
            self.library.export_profile(self.root, "focused", target)
        target.rmdir()
        target.symlink_to(self.base / "missing")
        with self.assertRaises((ValueError, OSError)):
            self.library.export_profile(self.root, "focused", target)
        self.assertTrue(target.is_symlink())

    def test_source_overlap_including_symlinked_parent_is_refused(self):
        alias = self.base / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        for target in (self.root, self.root / "export", self.base, alias / "export"):
            with self.subTest(target=target), self.assertRaises((ValueError, OSError)):
                self.library.export_profile(self.root, "focused", target)
        self.assertFalse((self.root / "export").exists())

    def test_unknown_profile_leaves_no_target(self):
        target = self.base / "export"
        with self.assertRaisesRegex(ValueError, "profile"):
            self.library.export_profile(self.root, "missing", target)
        self.assertFalse(target.exists())

    def test_lock_records_selected_files_and_source_revision(self):
        if not shutil.which("git"):
            self.skipTest("git unavailable")
        def git(*args):
            return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.DEVNULL, text=True).strip()
        git("init", "-q")
        git("add", ".")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
        revision = git("rev-parse", "HEAD")
        target = self.base / "export"
        # An inherited Git override must not relabel these files as another repo.
        with patch.dict(os.environ, {"GIT_DIR": str(self.base / "unrelated-dot-git")}):
            self.library.export_profile(self.root, "focused", target)
        lock = json.loads((target / "skills-lock.json").read_text())
        self.assertEqual(lock["source"]["revision"], revision)
        self.assertFalse(lock["source"]["dirty"])
        self.assertEqual(lock["profile"], "focused")
        self.assertEqual(lock["skills"], ["alpha"])
        actual = {p.relative_to(target).as_posix(): digest(p) for p in target.rglob("*")
                  if p.is_file() and p.name != "skills-lock.json"}
        self.assertEqual({entry["path"]: entry["sha256"] for entry in lock["files"]}, actual)
        self.write("README.md", "Uncommitted library documentation.\n")
        self.library.export_profile(self.root, "focused", self.base / "dirty-export")
        dirty_lock = json.loads((self.base / "dirty-export/skills-lock.json").read_text())
        self.assertEqual(dirty_lock["source"]["revision"], revision)
        self.assertTrue(dirty_lock["source"]["dirty"])

    def test_malformed_quoted_frontmatter_name_rejected(self):
        self.write("skills/alpha/SKILL.md", "---\nname: 'alpha\ndescription: Example\n---\n")
        self.refresh_alpha()
        with self.assertRaisesRegex(ValueError, "frontmatter|name"):
            self.library.validate(self.root)

    def test_lock_handles_source_without_git(self):
        target = self.base / "export"
        self.library.export_profile(self.root, "focused", target)
        lock = json.loads((target / "skills-lock.json").read_text())
        self.assertIsNone(lock["source"]["revision"])
        self.assertIsNone(lock["source"]["dirty"])

    def test_missing_markdown_dependency_rejected_but_code_examples_ignored(self):
        guide = "skills/alpha/references/guide.md"
        self.write(guide, "```markdown\n[example](missing.md)\n```\n`[example](also-missing.md)`\n[Online](https://example.com)\n")
        self.refresh_alpha()
        self.library.validate(self.root)
        self.write(guide, "[Missing](missing.md)\n")
        self.refresh_alpha()
        with self.assertRaisesRegex(ValueError, "link|dependenc"):
            self.library.validate(self.root)

    def test_selected_profile_cannot_omit_linked_skill(self):
        self.write("skills/alpha/references/guide.md", "[Other skill](../../beta/SKILL.md)\n")
        self.refresh_alpha()
        self.library.validate(self.root)
        with self.assertRaisesRegex(ValueError, "link|dependenc"):
            self.library.export_profile(self.root, "focused", self.base / "export")

    def test_shared_markdown_link_cannot_hide_an_unexported_symlink(self):
        self.write("tests/replay-template.md", "[Guide](alias.md)\n")
        (self.root / "tests/alias.md").symlink_to(self.root / "skills/alpha/references/guide.md")
        self.manifest["sharedFiles"] = [self.record("tests/replay-template.md")]
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.library.validate(self.root)

    def test_profile_without_shared_dependency_omits_shared_files(self):
        self.write("profiles.json", json.dumps({"oncall": ["alpha", "beta"], "debugging": ["beta"]}))
        self.write("tests/replay-template.md", "[Attribution](../skills/alpha/references/guide.md)\n")
        self.manifest["sharedFiles"] = [self.record("tests/replay-template.md")]
        self.save_manifest()
        self.library.export_profile(self.root, "oncall", self.base / "oncall")
        self.assertTrue((self.base / "oncall/tests/replay-template.md").is_file())
        self.library.export_profile(self.root, "debugging", self.base / "debugging")
        self.assertTrue((self.base / "debugging/skills/beta/SKILL.md").is_file())
        self.assertFalse((self.base / "debugging/tests").exists())
        self.assertFalse((self.base / "debugging/skills/alpha").exists())

    def test_shared_file_dependencies_are_exported_transitively(self):
        self.write("tests/replay-template.md", "[Appendix](appendix.md)\n")
        self.write("tests/appendix.md", "Shared appendix.\n")
        self.manifest["sharedFiles"] = [self.record("tests/replay-template.md"), self.record("tests/appendix.md")]
        self.save_manifest()
        self.library.export_profile(self.root, "focused", self.base / "export")
        self.assertEqual((self.base / "export/tests/appendix.md").read_text(), "Shared appendix.\n")

    def test_unselected_shared_file_is_still_validated(self):
        self.write("profiles.json", json.dumps({"debugging": ["beta"]}))
        self.write("tests/replay-template.md", "Tampered shared template.\n")
        with self.assertRaisesRegex(ValueError, "sha256|hash|checksum"):
            self.library.export_profile(self.root, "debugging", self.base / "export")
        self.assertFalse((self.base / "export").exists())

    def test_cli_validate_and_export(self):
        script = self.root / "scripts/library.py"
        script.parent.mkdir()
        shutil.copy2(SCRIPT, script)
        checked = subprocess.run(["python3", str(script), "validate"], capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        target = self.base / "export"
        exported = subprocess.run(["python3", str(script), "export", "--profile", "focused", "--target", str(target)], capture_output=True, text=True)
        self.assertEqual(exported.returncode, 0, exported.stderr)
        self.assertTrue((target / "skills-lock.json").is_file())


if __name__ == "__main__":
    unittest.main()

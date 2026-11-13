"""Exercise repos.sh and the repos_dev make targets against throwaway local git repos.

No network, no gcloud, no real VM paths: sources are local repos with a local "origin",
the VM root is a temp directory, and chown / mv -T are shimmed like deploy/test_deploy.py.
Run: python3 -B livex-native/repos/test_repos.py
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess as sp
import tarfile
import tempfile

here = Path(__file__).resolve().parent
repo_root = here.parent.parent
repos_sh = here / "repos.sh"

for script in (repos_sh, here / "repos_dev.sh"):
    assert sp.run(["bash", "-n", str(script)]).returncode == 0, script
    assert sp.run(["/bin/bash", "-n", str(script)]).returncode == 0, script
print("PASS bash -n and /bin/bash -n on repos.sh and repos_dev.sh")


def git(cwd, *args, check=True):
    env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    r = sp.run(["git", "-C", str(cwd), *args], env=env, text=True, stdout=sp.PIPE, stderr=sp.STDOUT)
    if check:
        assert r.returncode == 0, (args, r.stdout)
    return r.stdout.strip()


with tempfile.TemporaryDirectory(prefix="livex-repos-test-") as scratch:
    base = Path(scratch)
    shim = base / "shim"
    shim.mkdir()
    chown_log = base / "chown.log"
    gcloud_log = base / "gcloud.log"

    def fake(name, body):
        p = shim / name
        p.write_text("#!/bin/bash\nset -eu\n" + body)
        p.chmod(0o755)

    fake("chown", f'echo "$@" >>"{chown_log}"\n')
    # GNU `mv -T` (the VM) is not on macOS: emulate it with an atomic rename.
    fake("mv", """if [[ ${1:-} == -T ]]; then exec python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$2" "$3"; fi
exec /bin/mv "$@"
""")
    # flock(1) is not on macOS: a shim that takes the same advisory lock (fd 9) with fcntl.
    fake("flock", """exec python3 -c 'import fcntl,sys
try:
    fcntl.flock(int(sys.argv[2]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(1)' "$@"
""")
    fake("gcloud", f'echo "$@" >>"{gcloud_log}"\nexit 0\n')

    # ---- source repositories: a feature branch with dirty and untracked files, a local origin ----
    sources = base / "src"
    sources.mkdir()
    special = base / "sp ace" / "gamma"  # a source path with a space, like /Volumes/SSK SSD/...
    special.parent.mkdir()

    def make_source(path, branch="main", files=None, extra=None):
        origin = base / "origin" / (path.name + ".git")
        origin.parent.mkdir(exist_ok=True)
        sp.run(["git", "init", "-q", "--bare", "-b", branch, str(origin)], check=True)
        sp.run(["git", "init", "-q", "-b", branch, str(path)], check=True)
        git(path, "remote", "add", "origin", str(origin))
        for name, text in (files or {"README.md": f"# {path.name}\n", "src/app.py": "print('v1')\n"}).items():
            (path / name).parent.mkdir(parents=True, exist_ok=True)
            (path / name).write_text(text)
        if extra:
            extra(path)
        git(path, "add", "-A")
        if path.name == "alpha":  # a gitlink (submodule) entry whose checkout is an empty directory
            git(path, "update-index", "--add", "--cacheinfo", f"160000,{'1' * 40},vendor/sub")
        git(path, "commit", "-qm", "v1")
        git(path, "push", "-q", "origin", branch)
        git(path, "fetch", "-q", "origin")

    def alpha_extra(path):
        os.symlink("README.md", path / "link-to-readme")

    make_source(sources / "alpha", files={"README.md": "# alpha\n", "src/app.py": "print('v1')\n", "config/prod.yaml": "k: v\n"},
                extra=alpha_extra)
    make_source(sources / "beta_x")
    make_source(special, branch="prod")
    # alpha moves to a feature branch with uncommitted changes and untracked secrets.
    git(sources / "alpha", "checkout", "-q", "-b", "feature/work")
    (sources / "alpha" / "src" / "app.py").write_text("print('DIRTY working tree')\n")
    (sources / "alpha" / "secret.txt").write_text("hunter2\n")
    (sources / "alpha" / ".env").write_text("TOKEN=abc\n")
    dirty_before = {p: git(sources / p, "status", "--porcelain") for p in ("alpha", "beta_x")}

    sources_file = base / "sources.local.json"
    sources_file.write_text(json.dumps({"base": str(sources), "overrides": {"gamma": str(special)}}, indent=2) + "\n")
    manifest = base / "manifest.json"

    def write_manifest(rows, path=manifest):
        body = ",\n".join(f'  {{"id": "{i}", "branch": "{b}", "commit": "{c}"}}' for i, b, c in rows)
        path.write_text("[\n" + body + "\n]\n")

    ids = [("alpha", "main"), ("beta_x", "main"), ("gamma", "prod")]
    write_manifest([(i, b, "") for i, b in ids])
    out = base / "out"

    def env(**extra):
        e = {**os.environ, "PATH": f"{shim}:{os.environ['PATH']}", "LIVEX_REPOS_MANIFEST": str(manifest),
             "LIVEX_REPOS_SOURCES": str(sources_file), "LIVEX_REPOS_OUT": str(out), "TMPDIR": str(base)}
        e.update(extra)
        return {k: v for k, v in e.items() if v is not None}

    def repos(*args, **extra):
        return sp.run(["bash", str(repos_sh), *args], env=env(**extra), text=True, stdout=sp.PIPE, stderr=sp.STDOUT)

    # ---- pin ----
    r = repos("pin")
    assert r.returncode == 0, r.stdout
    tips = {i: git(p, "rev-parse", f"origin/{b}") for (i, b), p in zip(ids, (sources / "alpha", sources / "beta_x", special))}
    parsed = json.loads(manifest.read_text())
    assert [(e["id"], e["branch"], e["commit"]) for e in parsed] == [(i, b, tips[i]) for i, b in ids], parsed
    for i, b in ids:
        assert i in r.stdout and tips[i] in r.stdout and "new" in r.stdout
    first = manifest.read_text()
    assert first.startswith('[\n  {"id": "alpha", "branch": "main", "commit": "') and first.endswith('"}\n]\n'), first
    assert repos("pin").stdout.count("same") == 3 and manifest.read_text() == first, "stable formatting, idempotent"
    # A new commit on origin moves the pin ("changed"), via a second clone pushing to the local origin.
    other = base / "pusher"
    sp.run(["git", "clone", "-q", str(base / "origin" / "beta_x.git"), str(other)], check=True)
    (other / "src").mkdir(exist_ok=True)
    (other / "src" / "app.py").write_text("print('v2')\n")
    git(other, "add", "-A")
    git(other, "commit", "-qm", "v2")
    git(other, "push", "-q", "origin", "main")
    r = repos("pin")
    assert r.returncode == 0 and "changed" in r.stdout, r.stdout
    new_beta = json.loads(manifest.read_text())[1]["commit"]
    assert new_beta == git(other, "rev-parse", "HEAD") and new_beta != tips["beta_x"]
    # Refusals leave the manifest alone.
    pinned = manifest.read_text()
    missing_sources = base / "sources-missing.json"
    missing_sources.write_text(json.dumps({"base": str(sources), "overrides": {"gamma": str(base / "nowhere")}}, indent=2))
    r = repos("pin", LIVEX_REPOS_SOURCES=str(missing_sources))
    assert r.returncode == 1 and "source for gamma is missing" in r.stdout, r.stdout
    (base / "notgit").mkdir()
    notgit = base / "sources-notgit.json"
    notgit.write_text(json.dumps({"base": str(sources), "overrides": {"gamma": str(base / "notgit")}}, indent=2))
    r = repos("pin", LIVEX_REPOS_SOURCES=str(notgit))
    assert r.returncode == 1 and "not a git repository" in r.stdout, r.stdout
    assert manifest.read_text() == pinned
    # pin keeps the operator's global git config (credential helpers, url rewrites): beta_x's
    # origin is an unreachable https URL that only the global insteadOf rewrite maps to the
    # local bare repository. With config isolation (gitq) the fetch would fail.
    beta_origin = base / "origin" / "beta_x.git"
    git(sources / "beta_x", "remote", "set-url", "origin", "https://git.invalid/beta_x.git")
    gcfg = base / "global.gitconfig"
    gcfg.write_text(f'[url "{beta_origin}"]\n\tinsteadOf = https://git.invalid/beta_x.git\n')
    r = repos("pin", GIT_CONFIG_GLOBAL=str(gcfg))
    assert r.returncode == 0 and json.loads(manifest.read_text())[1]["commit"] == new_beta, r.stdout
    r = repos("pin")  # without the global config the same origin is unreachable
    assert r.returncode == 1 and "fetch of origin main failed for beta_x" in r.stdout, r.stdout
    git(sources / "beta_x", "remote", "set-url", "origin", str(beta_origin))
    print("PASS pin: tips of the default branches written, stable format, changes detected, missing/non-git sources refused")

    # ---- build: exactly the pinned commit trees ----
    r = repos("build")
    assert r.returncode == 0, r.stdout
    commits = {e["id"]: e["commit"] for e in json.loads(manifest.read_text())}
    sha12 = hashlib.sha256(manifest.read_bytes()).hexdigest()[:12]
    archive = out / f"repositories-{sha12}.tar.gz"
    receipt = json.loads((out / "repositories.receipt.json").read_text())
    assert archive.is_file() and receipt["archive"] == archive.name and receipt["manifestSha12"] == sha12
    archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert receipt["archiveSha256"] == archive_sha and receipt["archiveBytes"] == archive.stat().st_size
    assert [(e["id"], e["commit"]) for e in receipt["repos"]] == [(i, commits[i]) for i, _ in ids]
    by_id = {e["id"]: e for e in receipt["repos"]}
    assert by_id["alpha"]["symlinks"] == 1 and by_id["alpha"]["submodules"] == 1 and by_id["beta_x"]["symlinks"] == 0, by_id
    assert by_id["alpha"]["files"] == len(git(sources / "alpha", "ls-tree", "-r", "--name-only", commits["alpha"]).splitlines())
    assert all(e["sizeKiB"] > 0 for e in receipt["repos"])
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        names = [m.name for m in members]
        assert all(not n.startswith("/") and ".." not in n.split("/") for n in names)
        assert {n.split("/")[0] for n in names} == {i for i, _ in ids}, "only <id>/... entries"
        assert all(m.uid == 1000 and m.gid == 1000 for m in members), "owner is 1000:1000"
        assert names == sorted(names), "deterministic (sorted) member order"
        assert not any("/._" in n or n.startswith("._") for n in names)
        extracted = base / "extracted"
        extracted.mkdir()
        tar.extractall(extracted)
    for i, _ in ids:
        d = extracted / i
        src = special if i == "gamma" else sources / i
        tree = {}
        for line in git(src, "ls-tree", "-r", commits[i]).splitlines():
            meta, name = line.split("\t", 1)
            mode, kind, _sha = meta.split()
            tree[name] = mode
        working = {str(p.relative_to(d)) for p in d.rglob("*") if ".git" not in p.relative_to(d).parts and (p.is_file() or p.is_symlink())}
        assert working == {n for n, m in tree.items() if m != "160000"}, (i, working ^ set(tree))
        assert (d / ".git" / "config").read_text().count("[remote") == 0, "no remotes"
        assert not (d / ".git" / "FETCH_HEAD").exists() and not (d / ".git" / "logs").exists()
        assert not any((d / ".git" / "hooks").glob("*")) if (d / ".git" / "hooks").exists() else True
        assert str(sources) not in (d / ".git" / "config").read_text() and str(special) not in (d / ".git" / "config").read_text()
        assert git(d, "rev-parse", "HEAD") == commits[i] and git(d, "status", "--porcelain") == ""
    assert (extracted / "alpha" / "src" / "app.py").read_text() == "print('v1')\n", "committed content, not the dirty working tree"
    assert not (extracted / "alpha" / "secret.txt").exists() and not (extracted / "alpha" / ".env").exists()
    assert os.readlink(extracted / "alpha" / "link-to-readme") == "README.md"
    assert (extracted / "beta_x" / "src" / "app.py").read_text() == "print('v2')\n", "pinned tip, not the local checkout"
    assert {p: git(sources / p, "status", "--porcelain") for p in ("alpha", "beta_x")} == dirty_before, "sources untouched"
    assert (sources / "alpha" / "src" / "app.py").read_text() == "print('DIRTY working tree')\n"
    # A missing commit fails the build.
    bad = base / "bad-manifest.json"
    write_manifest([("alpha", "main", commits["alpha"]), ("beta_x", "main", "f" * 40)], bad)
    r = repos("build", LIVEX_REPOS_MANIFEST=str(bad), LIVEX_REPOS_OUT=str(base / "out-bad"))
    assert r.returncode == 1 and "is not available" in r.stdout and not (base / "out-bad").exists(), r.stdout
    empty = base / "empty-manifest.json"
    write_manifest([(i, b, "") for i, b in ids], empty)
    r = repos("build", LIVEX_REPOS_MANIFEST=str(empty))
    assert r.returncode == 1 and "no pinned commits" in r.stdout, r.stdout
    assert not list(base.glob("livex-repos.*")), "scratch directory removed"
    print("PASS build: archive holds exactly the pinned trees (no dirty/untracked files, remotes, hooks, local paths), uid 1000, receipt counts")

    # ---- install into a temp root ----
    root = base / "vmroot"
    root.mkdir()
    (root / "repos-empty").mkdir()
    link_env = {"LIVEX_ROOT": str(root)}

    def install(arc, sha, mf, **extra):
        return repos("install", str(arc), sha, str(mf), **{**link_env, **extra})

    # Refusals leave the root exactly as it was.
    def listing():
        return sorted(p.name for p in root.iterdir() if p.name != "deploy.lock")

    before = listing()
    wrong = install(archive, "0" * 64, manifest)
    assert wrong.returncode == 1 and "sha256 mismatch" in wrong.stdout and listing() == before, wrong.stdout
    tampered = base / f"tampered" / archive.name
    tampered.parent.mkdir()
    data = bytearray(archive.read_bytes())
    data[len(data) // 2] ^= 0xFF
    tampered.write_bytes(bytes(data))
    t = install(tampered, archive_sha, manifest)
    assert t.returncode == 1 and "sha256 mismatch" in t.stdout and listing() == before, t.stdout
    other_name = base / "named" / "repositories-000000000000.tar.gz"
    other_name.parent.mkdir()
    shutil.copy(archive, other_name)
    n = install(other_name, archive_sha, manifest)
    assert n.returncode == 1 and "different manifest" in n.stdout and listing() == before, n.stdout
    # Entries outside the manifest's repositories or with parent paths are never extracted.
    evil = base / "evil" / "x.tar.gz"
    evil.parent.mkdir()
    for member in ("rogue/file", "alpha/../../escape"):
        with tarfile.open(evil, "w:gz") as tar:
            info = tarfile.TarInfo(member)
            info.size = 0
            tar.addfile(info)
        e = install(evil, hashlib.sha256(evil.read_bytes()).hexdigest(), manifest)
        assert e.returncode == 1 and "outside the manifest" in e.stdout and listing() == before, (member, e.stdout)
    # An archive whose repositories do not match the manifest fails verification and leaves nothing behind.
    wrong_manifest = base / "wrong-manifest.json"
    write_manifest([("alpha", "main", commits["alpha"]), ("beta_x", "main", tips["beta_x"]), ("gamma", "prod", commits["gamma"])], wrong_manifest)
    renamed = base / "renamed" / "snapshot.tar.gz"
    renamed.parent.mkdir()
    shutil.copy(archive, renamed)
    v = install(renamed, archive_sha, wrong_manifest)
    assert v.returncode == 1 and "HEAD is not" in v.stdout and listing() == before, v.stdout
    # A real directory at repos must be moved aside by the operator first.
    (root / "repos").mkdir()
    d = install(archive, archive_sha, manifest)
    assert d.returncode == 1 and "real directory" in d.stdout and listing() == sorted([*before, "repos"]), d.stdout
    (root / "repos").rmdir()
    # Members that are not regular files, directories or symlinks (a FIFO, a hardlink) are refused.
    for kind in (tarfile.FIFOTYPE, tarfile.LNKTYPE):
        with tarfile.open(evil, "w:gz") as tar:
            info = tarfile.TarInfo("alpha/odd")
            info.type = kind
            if kind == tarfile.LNKTYPE:
                info.linkname = "alpha/README.md"
            tar.addfile(info)
        e = install(evil, hashlib.sha256(evil.read_bytes()).hexdigest(), manifest)
        assert e.returncode == 1 and "not a regular file, directory or symlink" in e.stdout and listing() == before, (kind, e.stdout)
    # Free space: 2x the uncompressed size is required; LIVEX_MIN_FREE_GIB overrides the requirement.
    low = install(archive, archive_sha, manifest, LIVEX_MIN_FREE_GIB="999999999")
    assert low.returncode == 1 and "not enough free space" in low.stdout and listing() == before, low.stdout
    # No LIVEX_ROOT: the live root is only usable on the dev VM, as root.
    h = repos("install", str(archive), archive_sha, str(manifest))
    assert h.returncode == 1 and "refusing: host is" in h.stdout, h.stdout
    stale_roots = repos("install", str(archive), archive_sha, str(manifest), LIVEX_ROOT="/opt/livex-openclaw-test")
    assert stale_roots.returncode == 1 and "refusing /opt/livex-openclaw-test" in stale_roots.stdout
    print("PASS install refusals: wrong/tampered sha, mismatched name, rogue or parent-path entries, failed verification, real dir, wrong host/root")

    # Happy path.
    ok = install(archive, archive_sha, manifest)
    assert ok.returncode == 0, ok.stdout
    dest = root / f"repos-{sha12}"
    assert os.readlink(root / "repos") == str(dest) and dest.is_dir()
    assert sorted(p.name for p in dest.iterdir()) == sorted(i for i, _ in ids)
    assert f"-R 1000:1000 {dest}.new" in chown_log.read_text()
    assert oct(dest.stat().st_mode & 0o7777) == "0o750", "snapshot root is 0750"
    assert not (root / "repos.previous").exists() and not any(".new" in p.name for p in root.iterdir())
    assert "make deploy_dev" in ok.stdout
    again = install(archive, archive_sha, manifest)
    assert again.returncode == 0 and "already exists" in again.stdout and os.readlink(root / "repos") == str(dest)
    # verify / drift detection.
    assert repos("verify", **link_env).returncode == 0
    (dest / "alpha" / "stray.txt").write_text("x\n")
    drift = repos("verify", **link_env)
    assert drift.returncode == 1 and "working tree is not clean" in drift.stdout, drift.stdout
    (dest / "alpha" / "stray.txt").unlink()
    git(dest / "alpha", "remote", "add", "origin", "https://example.invalid/x.git")
    assert "has a remote" in repos("verify", **link_env).stdout
    git(dest / "alpha", "remote", "remove", "origin")
    assert repos("verify", **link_env).returncode == 0

    # Second snapshot: switch, record previous. Third: prune the first.
    def snapshot(label, version):
        (other / "src" / "app.py").write_text(f"print('{label}')\n")
        git(other, "add", "-A")
        git(other, "commit", "-qm", label)
        git(other, "push", "-q", "origin", "main")
        assert repos("pin").returncode == 0
        assert repos("build").returncode == 0
        rc = json.loads((out / "repositories.receipt.json").read_text())
        return out / rc["archive"], rc["archiveSha256"], rc["manifestSha12"]

    arc2, sha2, m2 = snapshot("v3", 3)
    dest2 = root / f"repos-{m2}"
    assert install(arc2, sha2, manifest).returncode == 0
    assert os.readlink(root / "repos") == str(dest2)
    assert (root / "repos.previous").read_text().strip() == str(dest)
    assert dest.is_dir() and dest2.is_dir() and (root / "repos-empty").is_dir()
    arc3, sha3, m3 = snapshot("v4", 4)
    dest3 = root / f"repos-{m3}"
    # Without a valid repos.mounted record nothing is pruned (the mounted snapshot is unknown).
    assert install(arc3, sha3, manifest).returncode == 0
    assert os.readlink(root / "repos") == str(dest3) and (root / "repos.previous").read_text().strip() == str(dest2)
    assert dest.is_dir() and "keeping every snapshot" in install(arc3, sha3, manifest).stdout, "no record: keep all"
    # A, B, C before a deploy: the container still mounts A, so A must survive when C is installed.
    (root / "repos.mounted").write_text(f"{dest}\n")
    assert install(arc3, sha3, manifest).returncode == 0
    assert dest.is_dir() and dest2.is_dir() and dest3.is_dir(), "the mounted snapshot is never pruned"
    # An invalid record keeps everything too.
    (root / "repos.mounted").write_text("/etc\n")
    assert install(arc3, sha3, manifest).returncode == 0 and dest.is_dir()
    # The deploy records the new mount (dest3): A is no longer mounted and is pruned.
    (root / "repos.mounted").write_text(f"{dest3}\n")
    assert install(arc3, sha3, manifest).returncode == 0
    assert not dest.exists(), "snapshots beyond current+previous+mounted are pruned"
    assert dest2.is_dir() and dest3.is_dir() and (root / "repos-empty").is_dir()
    (root / "repos-garbage").mkdir()
    (root / "repos-0123456789ab.new").mkdir()
    assert install(arc3, sha3, manifest).returncode == 0
    assert (root / "repos-garbage").exists() and not (root / "repos-0123456789ab.new").exists(), "only snapshot-shaped leftovers are pruned"
    # Rollback to the previous snapshot (verify uses the manifest of the NEW snapshot, so skip it here).
    rb = repos("rollback", **link_env)
    assert rb.returncode == 0 and os.readlink(root / "repos") == str(dest2), rb.stdout
    assert (root / "repos.previous").read_text().strip() == str(dest3)
    # Rollback and install take deploy.lock themselves unless the caller holds it (LIVEX_REPOS_LOCKED=1).
    import fcntl
    with open(root / "deploy.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        held = repos("rollback", **link_env)
        assert held.returncode == 1 and "deploy.lock" in held.stdout and os.readlink(root / "repos") == str(dest2), held.stdout
        held = install(arc3, sha3, manifest)
        assert held.returncode == 1 and "deploy.lock" in held.stdout and os.readlink(root / "repos") == str(dest2), held.stdout
        marked = repos("rollback", LIVEX_REPOS_LOCKED="1", **link_env)
        assert marked.returncode == 0 and os.readlink(root / "repos") == str(dest3), marked.stdout
        assert repos("rollback", LIVEX_REPOS_LOCKED="1", **link_env).returncode == 0 and os.readlink(root / "repos") == str(dest2)
    assert git(dest2 / "beta_x", "rev-parse", "HEAD") != git(dest3 / "beta_x", "rev-parse", "HEAD")
    print("PASS install: verified extract, chown 1000, symlink switch, previous kept, prune beyond current+previous, verify detects drift, rollback")

    # ---- make repos_dev / repos_dev_dry ----
    def make(*args, **extra):
        return sp.run(["make", "-C", str(repo_root), *args], env=env(**extra), text=True, stdout=sp.PIPE, stderr=sp.STDOUT)

    pinned_manifest = base / "pinned-manifest.json"
    pinned_manifest.write_text(manifest.read_text())
    unconfirmed = make("repos_dev", LIVEX_REPOS_MANIFEST=str(pinned_manifest))
    assert unconfirmed.returncode != 0 and "CONFIRM=livex-openclaw-dev" in unconfirmed.stdout and not gcloud_log.exists(), unconfirmed.stdout
    wrong_confirm = make("repos_dev", "CONFIRM=yes", LIVEX_REPOS_MANIFEST=str(pinned_manifest))
    assert wrong_confirm.returncode != 0 and not gcloud_log.exists() and not (base / "out-never").exists()
    m12 = hashlib.sha256(pinned_manifest.read_bytes()).hexdigest()[:12]
    dry = make("repos_dev_dry", LIVEX_REPOS_MANIFEST=str(pinned_manifest), LIVEX_REPOS_OUT=str(base / "out-dry"))
    assert dry.returncode == 0 and not gcloud_log.exists() and not (base / "out-dry").exists(), dry.stdout
    for needle in ("compute ssh livex-openclaw-dev", "compute scp", f"repositories-{m12}.tar.gz", "--tunnel-through-iap",
                   "/opt/livex-openclaw-native-dev", "install", "Dry run: nothing was built", "make deploy_dev", "--project=ai-mvp-dv"):
        assert needle in dry.stdout, (needle, dry.stdout)
    direct = make("repos_dev_dry", LIVEX_REPOS_MANIFEST=str(pinned_manifest), LIVEX_TEST_IAP="0")
    assert "--tunnel-through-iap" not in direct.stdout and "--ssh-flag=-4" in direct.stdout and "--scp-flag=-4" in direct.stdout
    nopins = make("repos_dev_dry", LIVEX_REPOS_MANIFEST=str(empty))
    assert nopins.returncode != 0 and "no pinned commits" in nopins.stdout and not gcloud_log.exists()
    uncommitted = make("repos_dev_dry", LIVEX_REPOS_MANIFEST=None)  # the real manifest: untracked/unpinned in a dev tree
    assert not gcloud_log.exists()
    # A confirmed run builds, then uploads and installs (gcloud is a recording stub).
    real_out = base / "out-real"
    run = make("repos_dev", "CONFIRM=livex-openclaw-dev", LIVEX_REPOS_MANIFEST=str(pinned_manifest), LIVEX_REPOS_OUT=str(real_out))
    assert run.returncode == 0, run.stdout
    calls = gcloud_log.read_text().splitlines()
    assert len(calls) == 3 and calls[0].startswith("compute ssh livex-openclaw-dev") and calls[1].startswith("compute scp ")
    rc = json.loads((real_out / "repositories.receipt.json").read_text())
    assert f"bash -s -- install" in calls[2] and rc["archiveSha256"] in calls[2] and "flock -n /opt/livex-openclaw-native-dev/deploy.lock env LIVEX_REPOS_LOCKED=1 bash" in calls[2]
    assert oct((real_out / rc["archive"]).stat().st_mode & 0o777) == "0o600", "uploaded archive is owner-only"
    assert str(real_out / rc["archive"]) in calls[1] and "livex-repos-manifest-" in calls[1]
    assert "make deploy_dev" in run.stdout
    print("PASS make repos_dev needs CONFIRM; dry run makes no gcloud call and does not build; confirmed run builds, uploads, installs")

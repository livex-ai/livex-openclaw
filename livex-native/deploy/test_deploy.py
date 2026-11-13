"""Exercise the real deploy lifecycle with Docker and HTTP stubbed."""

import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile

deploy = Path(__file__).resolve().parent
remote = os.environ.get("TEST_REMOTE_SCRIPT", str(deploy / "remote.sh"))
with tempfile.TemporaryDirectory(prefix="pr50-stage-probe-") as scratch:
    base = Path(scratch)
    binpath = base / "bin"
    binpath.mkdir()
    log = base / "docker.log"
    tagdir = base / "tags"
    tagdir.mkdir()
    active = base / "active-image"
    project = "livex-openclaw-stage"
    prior_sha = "a" * 40
    head_sha = "b" * 40
    broken_sha = "c" * 40
    late_sha = "d" * 40
    rename_sha = "e" * 40
    prior_image = f"{project}:{prior_sha}"
    head_image = f"{project}:{head_sha}"
    broken_image = f"{project}:{broken_sha}"

    def fake(name, body):
        script = binpath / name
        script.write_text("#!/bin/bash\nset -eu\n" + body)
        script.chmod(0o755)

    fake("hostname", 'echo "$TEST_HOSTNAME"\n')
    fake("mv", r"""if [[ -n ${TEST_FAIL_MV_CURRENT:-} ]]; then
  for a in "$@"; do if [[ $a == */current.tmp.* ]]; then exit 1; fi; done
fi
if [[ -n ${TEST_FAIL_MV_SAVED:-} ]]; then
  for a in "$@"; do if [[ $a == */compose.env.saved.* ]]; then exit 1; fi; done
fi
# GNU `mv -T` (the VM) is not on macOS: emulate it with an atomic rename.
if [[ ${1:-} == -T ]]; then exec python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$2" "$3"; fi
exec /bin/mv "$@"
""")
    fake("df", r"""if [[ "${*: -1}" == *dockerroot* ]]; then
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nx 1 1 1 100%% /\n'
else
  exec /bin/df "$@"
fi
""")
    fake("ln", r"""if [[ -n ${TEST_FAIL_LN:-} ]]; then
  for a in "$@"; do if [[ $a == *current-release* ]]; then exit 1; fi; done
fi
exec /bin/ln "$@"
""")
    fake("chown", "exit 0\n")
    fake("rm", r"""if [[ -n ${TEST_FAIL_RM:-} ]]; then
  for a in "$@"; do if [[ $a == *"$TEST_FAIL_RM"* ]]; then exit 1; fi; done
fi
exec /bin/rm "$@"
""")
    fake("mkdir", r"""if [[ -n ${TEST_FAIL_MKDIR:-} ]]; then
  for a in "$@"; do if [[ $a == *adopt-backup.* ]]; then exit 1; fi; done
fi
exec /bin/mkdir "$@"
""")
    fake("cp", r"""# Only the adoption copy (cp -a) or the record backup can be made to fail, leaving partial output.
if [[ -n ${TEST_FAIL_CP:-} && ${1:-} == -a ]]; then mkdir -p "$3"; echo partial >"$3/partial"; exit 1; fi
if [[ -n ${TEST_FAIL_CP_BACKUP:-} && "${*: -1}" == *adopt-backup.* ]]; then echo OPENCLAW_IMAGE=truncated >"${*: -1}"; exit 1; fi
exec /bin/cp "$@"
""")
    fake("curl", r"""image=$(cat "$TEST_ACTIVE")
printf '%s\n' "$image" >>"$TEST_CURL_LOG"
printf '%s\n' "${*: -1}" >>"$TEST_CURL_LOG.url"
[[ $image != "${TEST_NO_READY_IMAGE:-}" ]]
""")
    fake("docker", r'''printf '%s\n' "$*" >>"$TEST_DOCKER_LOG"
tagid() { if [[ -f "$TEST_TAGDIR/$1" ]]; then cat "$TEST_TAGDIR/$1"; else echo "${1#*:}"; fi; }
case "$1" in
  build)
    t=""; prev=""
    for a in "$@"; do if [[ $prev == -t ]]; then t=$a; fi; prev=$a; done
    # Rebuilding a tag gives it a NEW image id, like docker does.
    if [[ -n $t ]]; then echo "built-${t#*:}-$RANDOM" >"$TEST_TAGDIR/$t"; fi ;;
  tag) tagid "$2" >"$TEST_TAGDIR/$3" ;;
  info) printf '%s\n' "${TEST_DOCKER_ROOT:-}" ;;
  compose)
    printf '%s\n' "${LIVEX_GATEWAY_MEM_LIMIT-unset}" >>"$TEST_MEM_LOG"
    [[ $2 == --project-name && $3 == "$TEST_EXPECT_PROJECT" ]]
    printf '%s %s\n' "$5" "${LIVEX_HOST_PORT-unset}" >>"$TEST_COMPOSE_LOG"
    composefile=$5
    shift 5
    envfile=""
    if [[ $1 == --env-file ]]; then envfile=$2; shift 2; fi
    # Without --env-file (every deploy path) the stage flag must match the mode.
    [[ -n $envfile || "$LIVEX_STAGE_ONLY" == "$TEST_STAGE" ]]
    case "$1" in
      stop) rm -f "$TEST_ACTIVE" "$TEST_ACTIVE.id" ;;
      config)
        if [[ ${2:-} == --services ]]; then printf '%s\n' ${TEST_SERVICES:-gateway cli}; fi ;;
      port) echo "${TEST_PORT:-127.0.0.1:18790}" ;;
      run)
        printf '%s\n' "${LIVEX_REPOS_DIR-unset}" >>"$TEST_GUARD_LOG.reposdir"
        if [[ " $* " == *" --entrypoint bash "* ]]; then
          # remote.sh's pinned-repository check: run its script on the host against the "mount".
          args=("$@"); script=""; rest=()
          for ((k = 0; k < ${#args[@]}; k++)); do
            if [[ ${args[k]} == -c ]]; then script=${args[k+1]}; rest=("${args[@]:k+4}"); break; fi
          done
          printf '%s\n' "${rest[*]}" >>"$TEST_GUARD_LOG.repos"
          bash -c "$script" repos-check "$LIVEX_REPOS_DIR" ${rest[@]+"${rest[@]}"}
        elif [[ " $* " == *" LIVEX_CHECK_AGENTS_ONLY=1 "* ]]; then
          echo "$STATE_DIR" >>"$TEST_GUARD_LOG"
          echo "$*" >>"$TEST_GUARD_LOG.check"
          # Models the real guard: every live agent must be shipped or listed as unmanaged.
          listed=""
          for a in "$@"; do case $a in LIVEX_UNMANAGED_AGENTS=*) listed=${a#*=} ;; esac; done
          for id in ${TEST_LIVE_AGENTS:-}; do
            if [[ ",$listed," != *",$id,"* ]]; then echo "live config serves $id; release does not ship it" >&2; exit 1; fi
          done
          if [[ -n ${TEST_GUARD_FAIL:-} ]]; then echo "live config serves oncall; release does not ship it" >&2; exit 1; fi
        elif [[ " $* " == *" /opt/livex-native/deploy/apply.mjs "* ]]; then
          [[ " $* " == *" LIVEX_STAGE_ONLY=$TEST_STAGE "* ]]
          echo "${*}" >>"$TEST_GUARD_LOG.apply"
          printf '%s\n' "$OPENCLAW_IMAGE" >"$STATE_DIR/apply-result"
        fi
        ;;
      up)
        image=${OPENCLAW_IMAGE-}; state=${STATE_DIR-}
        if [[ -n $envfile ]]; then
          [[ -n $image ]] || image=$(sed -n 's/^OPENCLAW_IMAGE=//p' "$envfile")
          state=$(sed -n 's/^STATE_DIR=//p' "$envfile")
        fi
        printf '%s\n' "$image" >"$TEST_ACTIVE"
        tagid "$image" >"$TEST_ACTIVE.id"
        printf '%s\n' "$state" >"$TEST_ACTIVE.state"
        printf '%s\n' "$composefile" >"$TEST_ACTIVE.compose" ;;
      *) exit 75 ;;
    esac ;;
  inspect)
    [[ $4 == "$TEST_EXPECT_PROJECT-gateway-1" ]]
    if [[ $3 == '{{.State.Running}}' ]]; then
      [[ ! -e $TEST_ACTIVE ]] || echo true
    elif [[ $3 == *Labels* ]]; then
      echo "${TEST_LABEL_CONFIG:-}"
    elif [[ -f $TEST_ACTIVE ]]; then
      image=$(cat "$TEST_ACTIVE")
      if [[ $image == "${TEST_WRONG_IMAGE:-}" ]]; then
        printf 'sha256:stale\n'
      elif [[ -f $TEST_ACTIVE.id ]]; then
        printf 'sha256:%s\n' "$(cat "$TEST_ACTIVE.id")"
      else
        printf 'sha256:%s\n' "${image#*:}"
      fi
    fi ;;
  image)
    if [[ $2 == inspect ]]; then
      if [[ " ${TEST_MISSING_IMAGES:-} " == *" $5 "* ]]; then exit 1; fi
      printf 'sha256:%s\n' "$(tagid "$5")"
    elif [[ $2 == ls ]]; then
      [[ "${*: -1}" == "$TEST_EXPECT_PROJECT" ]]
    elif [[ $2 == prune ]]; then
      :
    elif [[ $2 == rm ]]; then
      rm -f "$TEST_TAGDIR/$3"
    else
      exit 1
    fi ;;
  builder)
    [[ "$TEST_STAGE" == 0 ]]
    ;;
  *) exit 76 ;;
esac
''')

    def add_release(root, sha):
        # remote.sh prunes all but the newest releases, so tests re-add theirs.
        release = root / "releases" / sha / "livex-native/deploy"
        release.mkdir(parents=True, exist_ok=True)
        for name in ("compose.yaml", "Dockerfile", "versions.env"):
            shutil.copyfile(deploy / name, release / name)

    def make_root(name, shas):
        root = base / name
        for item in ("state", "gcloud"):
            (root / item).mkdir(parents=True)
        (root / "runtime.env").write_text("OPENCLAW_GATEWAY_TOKEN=fixture-only\n")
        for sha in shas:
            add_release(root, sha)
        return root

    root = make_root("stage", (prior_sha, head_sha, broken_sha, late_sha, rename_sha))
    (root / "current").write_text(prior_image + "\n")
    active.write_text(prior_image + "\n")
    (root / "state" / "retained").write_text("existing candidate state\n")
    curl_log = base / "curl.log"

    def run(sha, *, staging=True, root=root, **extras):
        env = {
            **os.environ,
            "PATH": f"{binpath}:{os.environ['PATH']}",
            "LIVEX_ROOT": str(root),
            "LIVEX_ON_DEV_VM": "1" if staging else "0",
            "LIVEX_HEALTH_TIMEOUT": "2",
            "LIVEX_HEALTH_INTERVAL": "1",
            "TEST_ACTIVE": str(active),
            "TEST_DOCKER_LOG": str(log),
            "TEST_CURL_LOG": str(curl_log),
            "TEST_MEM_LOG": str(base / "mem.log"),
            "TEST_COMPOSE_LOG": str(base / "compose.log"),
            "TEST_TAGDIR": str(tagdir),
            "TEST_GUARD_LOG": str(base / "guard.log"),
            "LIVEX_MIN_FREE_GIB": "0",
            "TEST_HOSTNAME": "livex-openclaw-dev" if staging else "livex-openclaw-test",
            "TEST_EXPECT_PROJECT": project if staging else "livex-openclaw-test",
            "TEST_STAGE": "1" if staging else "0",
            **extras,
        }
        for key in [k for k, v in env.items() if v is None]:
            del env[key]
        add_release(root, sha)
        result = subprocess.run(["bash", remote, sha], env=env,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print("\n".join(line for line in result.stdout.splitlines()
                        if "STAGED" in line or "FAILED" in line or "ADOPTED" in line or
                        "Rollback ready" in line or "not ready at" in line or "DEPLOYED" in line))
        return result

    # Disk guard: refuse before building or stopping anything.
    log_before = log.read_text() if log.exists() else ""
    low_disk = run(head_sha, LIVEX_MIN_FREE_GIB="9999")
    assert low_disk.returncode == 1, low_disk.stdout
    assert "Refusing to deploy" in low_disk.stdout and "GiB free" in low_disk.stdout
    new_calls = (log.read_text() if log.exists() else "")[len(log_before):].splitlines()
    assert [c for c in new_calls if not c.startswith("info ")] == [], new_calls
    assert active.read_text().strip() == prior_image
    assert (root / "current").read_text().strip() == prior_image
    assert (root / "state" / "retained").read_text() == "existing candidate state\n"
    assert not (root / "state" / "apply-result").exists()
    bad_knob = run(head_sha, LIVEX_MIN_FREE_GIB="lots")
    assert bad_knob.returncode == 2, bad_knob.stdout
    print("PASS low disk refuses before build or stop; gateway untouched; bad knob rejected")

    success = run(head_sha)
    assert success.returncode == 0, success.stdout
    assert f"STAGED {head_sha}" in success.stdout
    assert (root / "current").read_text().strip() == head_image
    assert (root / "previous").read_text().strip() == prior_image
    assert "LIVEX_STAGE_ONLY=1" in (root / "compose.env").read_text()
    assert "LIVEX_GATEWAY_MEM_LIMIT=0" in (root / "compose.env").read_text()
    assert "LIVEX_HOST_PORT=18789" in (base / "guard.log.apply").read_text().splitlines()[-1], "stage forwards 18789"
    snapshot = root / "releases" / head_sha / "state.before.tgz"
    baseline = hashlib.sha256(snapshot.read_bytes()).hexdigest()

    retry = run(head_sha)
    assert retry.returncode == 0, retry.stdout
    assert (root / "previous").read_text().strip() == prior_image
    assert hashlib.sha256(snapshot.read_bytes()).hexdigest() == baseline
    print("PASS same-SHA staging preserves prior release and original snapshot")

    timed_out = run(broken_sha, TEST_WRONG_IMAGE=broken_image)
    assert timed_out.returncode == 1, timed_out.stdout
    print(timed_out.stdout)
    assert "not ready" in timed_out.stdout and "Rollback ready" in timed_out.stdout
    assert active.read_text().strip() == head_image
    assert (root / "current").read_text().strip() == head_image
    assert (root / "state" / "apply-result").read_text().strip() == head_image
    assert (root / "state" / "retained").read_text() == "existing candidate state\n"
    assert (root / "previous").read_text().strip() == prior_image
    assert "livex-openclaw-dev-gateway-1" not in log.read_text()
    assert "builder prune" not in log.read_text()
    assert broken_image not in curl_log.read_text()
    print("PASS wrong candidate image and ready loopback cannot activate; staging-only rollback succeeds")

    unreachable = run(broken_sha, TEST_NO_READY_IMAGE=broken_image)
    assert unreachable.returncode == 1, unreachable.stdout
    assert "not ready" in unreachable.stdout and "Rollback ready" in unreachable.stdout
    assert active.read_text().strip() == head_image
    assert "livex-openclaw-dev-gateway-1" not in log.read_text()
    assert broken_image in curl_log.read_text()
    print("PASS real readiness timeout control flow keeps legacy DEV outside rollback")

    late = run(late_sha, TEST_FAIL_LN="1")
    assert late.returncode != 0, late.stdout
    assert "Rollback ready" in late.stdout
    assert active.read_text().strip() == head_image
    assert (root / "current").read_text().strip() == head_image
    assert (root / "previous").read_text().strip() == prior_image
    assert f"OPENCLAW_IMAGE={head_image}" in (root / "compose.env").read_text()
    print("PASS late activation failure rolls back and leaves current on the running image")

    # An interrupted rename sequence (`current` rename fails) restores every record.
    def records():
        return {n: (root / n).read_text() for n in ("compose.env", "previous", "current")} | {
            "link": os.readlink(root / "current-release")}
    before = records()
    renamed = run(rename_sha, TEST_FAIL_MV_CURRENT="1")
    assert renamed.returncode != 0, renamed.stdout
    assert "Rollback ready" in renamed.stdout
    assert records() == before
    assert active.read_text().strip() == head_image
    assert [f.name for f in root.iterdir() if ".tmp." in f.name or ".saved." in f.name] == []
    print("PASS failed rename of current leaves compose.env, current-release, previous and current unchanged")

    active.unlink()
    test_root = make_root("dedicated", (head_sha,))
    test = run(head_sha, staging=False, root=test_root)
    assert test.returncode == 0, test.stdout
    assert f"DEPLOYED {head_sha}" in test.stdout
    assert "LIVEX_STAGE_ONLY=0" in (test_root / "compose.env").read_text()
    assert active.read_text().strip() == f"livex-openclaw-test:{head_sha}"
    print("PASS dedicated VM uses original project and non-staging config")

    # Docker data root is checked too (fake `df` reports it nearly full).
    dockerroot = base / "dockerroot"
    dockerroot.mkdir()
    active.unlink()
    low_docker = run(head_sha, staging=False, root=test_root, LIVEX_MIN_FREE_GIB="1",
                     TEST_DOCKER_ROOT=str(dockerroot))
    assert low_docker.returncode == 1 and "dockerroot" in low_docker.stdout, low_docker.stdout
    assert not active.exists()
    print("PASS low Docker data root refuses before any stop")

    # Memory cap is opt-in; an operator value is carried forward and exported.
    mem_root = make_root("mem", (head_sha,))
    (mem_root / "compose.env").write_text("LIVEX_GATEWAY_MEM_LIMIT=3g\n")
    (base / "mem.log").write_text("")
    mem = run(head_sha, staging=False, root=mem_root)
    assert mem.returncode == 0, mem.stdout
    assert "LIVEX_GATEWAY_MEM_LIMIT=3g" in (mem_root / "compose.env").read_text()
    assert set((base / "mem.log").read_text().split()) == {"3g"}
    bad_root = make_root("badmem", (head_sha,))
    (bad_root / "compose.env").write_text("LIVEX_GATEWAY_MEM_LIMIT=lots\n")
    bad = run(head_sha, staging=False, root=bad_root)
    assert bad.returncode == 2, bad.stdout
    low_root = make_root("lowmem", (head_sha,))
    (low_root / "compose.env").write_text("LIVEX_GATEWAY_MEM_LIMIT=64m\n")
    low = run(head_sha, staging=False, root=low_root)
    assert low.returncode == 2 and "at least 1g" in low.stdout, low.stdout
    zero_root = make_root("zeromem", (head_sha,))
    (zero_root / "compose.env").write_text("LIVEX_GATEWAY_MEM_LIMIT=0\n")
    assert run(head_sha, staging=False, root=zero_root).returncode == 0
    print("PASS memory limit: opt-in, carried forward and exported; malformed and under-1g rejected; 0 accepted")


    # ------------------------------------------------------------------
    # LIVE mode (LIVEX_DEV_LIVE=1): the Slack-serving native Gateway on the DEV VM.
    # ------------------------------------------------------------------
    live_project = "livex-openclaw-native-dev"
    cur_sha, prev_sha = "1" * 40, "2" * 40
    cur_image, prev_image = f"{live_project}:{cur_sha}", f"{live_project}:{prev_sha}"
    new_live = "b" * 40
    new_live_image = f"{live_project}:{new_live}"
    other_live = "d" * 40

    def tree(path):
        out = {}
        for q in [Path(path), *sorted(Path(path).rglob("*"))]:
            st = q.lstat()
            out[str(q.relative_to(path))] = (stat.S_IMODE(st.st_mode), q.read_bytes() if q.is_file() else None)
        return out

    def live(sha, root, **extras):
        env = {"LIVEX_DEV_LIVE": "1", "TEST_HOSTNAME": "livex-openclaw-dev",
               "TEST_EXPECT_PROJECT": live_project, "TEST_LABEL_CONFIG": str(root / "compose.yaml"), **extras}
        return run(sha, staging=False, root=root, **env)

    def make_adopted(name, shas=()):
        """A root already in our layout (after a first deploy)."""
        r = make_root(name, shas)
        (r / "runtime.env").write_text("OPENCLAW_GATEWAY_TOKEN=x\nSLACK_BOT_TOKEN=xoxb-fixture\nSLACK_APP_TOKEN=xapp-fixture\n")
        return r

    def make_legacy(name, stale="content"):
        """The hand-made layout: bare-sha records, per-release state, root compose files."""
        r = base / name
        r.mkdir()
        (r / "gcloud").mkdir()
        (r / "runtime.env").write_text("OPENCLAW_GATEWAY_TOKEN=x\nSLACK_BOT_TOKEN=xoxb-fixture\nSLACK_APP_TOKEN=xapp-fixture\n")
        (r / "compose.yaml").write_text("legacy compose, ports 18790\n")
        for sha, tag in ((cur_sha, "cur"), (prev_sha, "prev")):
            rel = r / f"release-{sha}.rand{tag}"
            (rel / "state" / "agents").mkdir(parents=True)
            (rel / "state" / "openclaw.json").write_text(f'{{"legacy":"{tag}"}}\n')
            db = rel / "state" / "agents" / "main.sqlite"
            db.write_bytes(b"SQLite format 3\0" + tag.encode())
            db.chmod(0o640)
            (rel / "state").chmod(0o700)
            for item in ("compose.env", "previous.env", "previous.marker", "previous.prepared", "slack-check.json"):
                (rel / item).write_text(f"{tag} {item}\n")
        (r / "compose.env").write_text(
            f"OPENCLAW_IMAGE={cur_image}\nRUNTIME_ENV_FILE={r}/runtime.env\n"
            f"STATE_DIR={r}/release-{cur_sha}.randcur/state\nSDK_STATE_DIR={r}/gcloud\nLIVEX_STAGE_ONLY=0\n")
        (r / "current").write_text(cur_sha + "\n")
        (r / "previous").write_text(prev_sha + "\n")
        (r / "prepared").write_text(cur_sha + "\n")
        if stale == "content":
            (r / "state").mkdir()
            (r / "state" / "stale-file").write_text("unrelated\n")
        elif stale == "empty":
            (r / "state").mkdir()
        return r

    def start_legacy(r):
        for f in tagdir.iterdir():
            f.unlink()
        (tagdir / cur_image).write_text("orig-id\n")
        Path(str(active) + ".id").write_text("orig-id\n")
        active.write_text(cur_image + "\n")
        Path(str(active) + ".state").write_text(f"{r}/release-{cur_sha}.randcur/state\n")

    def snapshot_legacy(r):
        return {n: (tree(r / n) if (r / n).is_dir() else (r / n).read_bytes())
                for n in sorted(os.listdir(r)) if n not in ("releases", "deploy.lock", "repos", "repos-empty")}

    def assert_original(r, before, label):
        assert snapshot_legacy(r) == before, label
        # Rollback starts the pinned tag (same image id as the original), not the sha tag.
        assert active.read_text().startswith(f"{live_project}:pre-adopt-"), label
        assert Path(str(active) + ".state").read_text().strip() == f"{r}/release-{cur_sha}.randcur/state", label
        assert Path(str(active) + ".compose").read_text().strip() == str(r / "compose.yaml"), label
        assert not (r / "current-release").exists() and not os.path.lexists(r / "current-release"), label
        assert not [n for n in os.listdir(r) if n.startswith(("adopt-backup", "state.pre-adopt", ".tmp"))
                    or ".tmp." in n], label
        assert [f.name for f in tagdir.iterdir() if "pre-adopt" in f.name] == [], label
        assert Path(str(active) + ".id").read_text().strip() == "orig-id", label
        assert (tagdir / cur_image).read_text().strip() == "orig-id", label

    def prune_logged():
        return log.read_text()

    # --- refusals: mode combinations, hostname, Slack, layout ---
    log_len = len(log.read_text())
    both = live(head_sha, make_adopted("livex-both", (head_sha,)), LIVEX_ON_DEV_VM="1")
    assert both.returncode == 1 and "cannot be combined" in both.stdout, both.stdout
    wrong_host = live(head_sha, make_adopted("livex-host", (head_sha,)), TEST_HOSTNAME="livex-openclaw-test")
    assert wrong_host.returncode == 1 and "host is 'livex-openclaw-test'" in wrong_host.stdout, wrong_host.stdout
    no_slack_root = make_adopted("noslack", (head_sha,))
    (no_slack_root / "runtime.env").write_text("OPENCLAW_GATEWAY_TOKEN=x\n")
    no_slack = live(head_sha, no_slack_root)
    assert no_slack.returncode == 1 and "lacks SLACK_BOT_TOKEN" in no_slack.stdout, no_slack.stdout
    assert not any(c.startswith(("build", "compose")) for c in log.read_text()[log_len:].splitlines())
    print("PASS live refuses mode combination, wrong host and missing Slack tokens before touching Docker")

    # --- happy path on an already-adopted root; and a second deploy ---
    live_root = make_adopted("live-ok", (cur_sha, head_sha, other_live))
    (live_root / "current").write_text(cur_image + "\n")
    active.write_text(cur_image + "\n")
    Path(str(active) + ".state").write_text("seed\n")
    (live_root / "state" / "retained").write_text("live state\n")
    Path(str(curl_log) + ".url").write_text("")
    (base / "compose.log").write_text("")
    (base / "guard.log.reposdir").write_text("")
    log_len = len(log.read_text())
    ok = live(head_sha, live_root)
    assert ok.returncode == 0, ok.stdout
    assert f"DEPLOYED {head_sha} LIVE" in ok.stdout and "host port 18790" in ok.stdout and "ADOPTED" not in ok.stdout
    env_text = (live_root / "compose.env").read_text()
    assert f"OPENCLAW_IMAGE={new_live_image}" in env_text and "LIVEX_HOST_PORT=18790" in env_text
    assert "LIVEX_STAGE_ONLY=0" in env_text and f"STATE_DIR={live_root}/state" in env_text
    assert (live_root / "current").read_text().strip() == new_live_image
    assert (live_root / "previous").read_text().strip() == cur_image
    assert os.readlink(live_root / "current-release") == str(live_root / "releases" / head_sha)
    assert set(Path(str(curl_log) + ".url").read_text().split()) == {"http://127.0.0.1:18790/readyz"}
    assert {line.split()[1] for line in (base / "compose.log").read_text().splitlines()} == {"18790"}
    new_log = log.read_text()[log_len:]
    assert f"-t {new_live_image}" in new_log and "image prune -f" in new_log
    assert "builder prune" not in new_log and "--filter" not in new_log.split("image prune")[1].split("\n")[0]
    assert "LIVEX_LIVE_GUARD=1" in (base / "guard.log.apply").read_text().splitlines()[-1]
    assert "LIVEX_HOST_PORT=18790" in (base / "guard.log.apply").read_text().splitlines()[-1], "apply gets the live host port"
    assert "livex-openclaw-stage" not in new_log and "livex-openclaw-dev-gateway-1" not in new_log
    assert (live_root / "state" / "apply-result").read_text().strip() == new_live_image
    assert active.read_text().strip() == new_live_image
    # The /repos mount source: an empty directory behind the `repos` symlink until the first install.
    assert f"LIVEX_REPOS_DIR={live_root}/repos\n" in env_text
    assert os.readlink(live_root / "repos") == str(live_root / "repos-empty")
    assert list((live_root / "repos-empty").iterdir()) == []
    assert (live_root / "repos.mounted").read_text() == f"{live_root}/repos-empty\n", "deploy records the mounted snapshot for repos.sh prune"
    assert set((base / "guard.log.reposdir").read_text().split()) == {f"{live_root}/repos"}
    assert "${LIVEX_REPOS_DIR:?" in (deploy / "compose.yaml").read_text() and ":/repos:ro" in (deploy / "compose.yaml").read_text()
    print("PASS live happy path: project, root, port 18790, Slack not skipped, housekeeping, no stage/PR#1 names")

    # --- pinned source snapshots: checked as uid 1000 through the mount BEFORE anything is stopped ---
    def write_manifest(root, sha, rows):
        d = root / "releases" / sha / "livex-native" / "repos"
        d.mkdir(parents=True, exist_ok=True)
        body = ",\n".join(f'  {{"id": "{i}", "branch": "main", "commit": "{c}"}}' for i, c in rows)
        (d / "manifest.json").write_text("[\n" + body + "\n]\n")

    def make_repo(path):
        path.mkdir(parents=True)
        sp.run(["git", "init", "-q", str(path)], check=True)
        sp.run(["git", "-C", str(path), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], check=True)
        return sp.run(["git", "-C", str(path), "rev-parse", "HEAD"], text=True, stdout=sp.PIPE, check=True).stdout.strip()

    def start_live(name):
        r = make_adopted(name, (cur_sha, head_sha))
        (r / "current").write_text(cur_image + "\n")
        active.write_text(cur_image + "\n")
        Path(str(active) + ".state").write_text("seed\n")
        (r / "state" / "retained").write_text("live state\n")
        return r

    # In this block `sp` is subprocess (the make test further down imports it too).
    import subprocess as sp
    pins_root = start_live("live-pins")
    snap_commit = make_repo(pins_root / "snapshots" / "alpha")
    write_manifest(pins_root, head_sha, [("alpha", snap_commit), ("beta", "")])
    (base / "guard.log.repos").write_text("")
    log_len = len(log.read_text())
    refused = live(head_sha, pins_root)  # `repos` points at the empty directory: alpha is missing
    assert refused.returncode == 1 and "run make repos_dev first" in refused.stdout and "Gateway was not touched" in refused.stdout, refused.stdout
    assert "missing: alpha" in refused.stdout, refused.stdout
    assert not any(" stop " in c for c in log.read_text()[log_len:].splitlines()), "nothing may be stopped"
    assert active.read_text().strip() == cur_image and (pins_root / "current").read_text().strip() == cur_image
    assert (pins_root / "state" / "retained").read_text() == "live state\n" and not (pins_root / "state" / "apply-result").exists()
    assert (base / "guard.log.repos").read_text().split() == ["alpha", snap_commit], "only pinned entries are checked"
    # An installed snapshot (repos -> a real directory) passes.
    os.remove(pins_root / "repos")
    os.symlink(pins_root / "snapshots", pins_root / "repos")
    passed = live(head_sha, pins_root)
    assert passed.returncode == 0 and f"DEPLOYED {head_sha} LIVE" in passed.stdout, passed.stdout
    assert os.readlink(pins_root / "repos") == str(pins_root / "snapshots"), "an installed snapshot is never replaced"
    assert f"LIVEX_REPOS_DIR={pins_root}/repos\n" in (pins_root / "compose.env").read_text()
    # A pinned commit the snapshot does not hold refuses too.
    bad_root = start_live("live-pins-bad")
    make_repo(bad_root / "snapshots" / "alpha")
    os.symlink(bad_root / "snapshots", bad_root / "repos")
    write_manifest(bad_root, head_sha, [("alpha", "1" * 40)])
    log_len = len(log.read_text())
    bad = live(head_sha, bad_root)
    assert bad.returncode == 1 and "not readable: alpha" in bad.stdout and "repos_dev first" in bad.stdout, bad.stdout
    assert not any(" stop " in c for c in log.read_text()[log_len:].splitlines())
    # A hand-made manifest that is not canonical is refused, not half-read.
    odd_root = start_live("live-pins-odd")
    (odd_root / "releases" / head_sha / "livex-native" / "repos").mkdir(parents=True)
    (odd_root / "releases" / head_sha / "livex-native" / "repos" / "manifest.json").write_text('[{"id": "a", "branch": "main", "commit": ""}]\n')
    odd = live(head_sha, odd_root)
    assert odd.returncode == 1 and "canonical" in odd.stdout, odd.stdout
    # No pins (empty commits) or no manifest: no check at all.
    none_root = start_live("live-pins-none")
    write_manifest(none_root, head_sha, [("alpha", "")])
    (base / "guard.log.repos").write_text("")
    assert live(head_sha, none_root).returncode == 0
    assert (base / "guard.log.repos").read_text() == ""
    # Stage and test modes mount an empty directory under their root.
    stage_ok = run(head_sha, root=make_root("stage-repos", (prior_sha, head_sha)))
    assert stage_ok.returncode == 0, stage_ok.stdout
    assert (base / "stage-repos" / "repos-empty").is_dir() and not (base / "stage-repos" / "repos").exists()
    assert f"LIVEX_REPOS_DIR={base}/stage-repos/repos-empty\n" in (base / "stage-repos" / "compose.env").read_text()
    print("PASS pinned repositories: refused before any stop when missing, passes when present, empty mount elsewhere")

    # --- one-time adoption of the hand-made layout ---
    legacy = make_legacy("legacy-ok")
    start_legacy(legacy)
    before = snapshot_legacy(legacy)
    old_state = tree(legacy / f"release-{cur_sha}.randcur" / "state")
    (base / "compose.log").write_text("")
    adopted = live(new_live, legacy)
    assert adopted.returncode == 0, adopted.stdout
    assert "adoption plan" in adopted.stdout and f"ADOPTED" in adopted.stdout, adopted.stdout
    copied = tree(legacy / "state")
    assert copied.pop("apply-result")[1].decode().strip() == new_live_image
    assert copied == old_state, "state copy keeps content and modes"
    assert tree(legacy / f"release-{cur_sha}.randcur" / "state") == old_state, "legacy state untouched"
    for name, value in before.items():
        if name.startswith("release-") or name in ("compose.yaml", "prepared"):
            assert snapshot_legacy(legacy)[name] == value, name
    asides = [n for n in os.listdir(legacy) if n.startswith("state.pre-adopt.")]
    assert len(asides) == 1 and (legacy / asides[0] / "stale-file").read_text() == "unrelated\n"
    assert (legacy / "current").read_text().strip() == new_live_image
    pin = (legacy / "previous").read_text().strip()
    assert pin.startswith(f"{live_project}:pre-adopt-") and (tagdir / pin).read_text().strip() == "orig-id", pin
    assert Path(base / "guard.log").read_text().splitlines()[-1] == f"{legacy}/release-{cur_sha}.randcur/state", \
        "pre-stop agent guard reads the LEGACY state"
    env_text = (legacy / "compose.env").read_text()
    assert f"OPENCLAW_IMAGE={new_live_image}" in env_text and f"STATE_DIR={legacy}/state" in env_text
    assert "LIVEX_HOST_PORT=18790" in env_text and "LIVEX_STAGE_ONLY=0" in env_text
    backups = [n for n in os.listdir(legacy) if n.startswith("adopt-backup.")]
    assert len(backups) == 1
    assert (legacy / backups[0] / "compose.env").read_text() == before["compose.env"].decode()
    assert (legacy / backups[0] / "current").read_bytes() == before["current"]
    assert "sudo rm -rf" in adopted.stdout and f"release-{cur_sha}.randcur" in adopted.stdout
    assert (legacy / "compose.yaml").read_text() == "legacy compose, ports 18790\n"
    assert active.read_text().strip() == new_live_image
    assert Path(str(active) + ".state").read_text().strip() == f"{legacy}/state"
    assert Path(str(active) + ".compose").read_text().strip() == str(legacy / "releases" / new_live / "livex-native/deploy/compose.yaml")
    print("PASS adoption copies state (modes kept), converts records, moves a stale state aside, keeps every legacy dir")

    # Second deploy after adoption takes the normal path.
    second = live(other_live, legacy)
    assert second.returncode == 0, second.stdout
    assert "adoption plan" not in second.stdout and "ADOPTED" not in second.stdout
    assert (legacy / "previous").read_text().strip() == new_live_image
    assert Path(base / "guard.log").read_text().splitlines()[-1] == str(legacy / "state")
    assert (legacy / "current").read_text().strip() == f"{live_project}:{other_live}"
    assert tree(legacy / f"release-{cur_sha}.randcur" / "state") == old_state
    assert (legacy / "state" / "stale-file").exists() is False
    print("PASS second deploy after adoption: normal path, legacy dirs still untouched")

    # Empty stale state dir: moved aside, then the empty leftover is removed.
    legacy_empty = make_legacy("legacy-empty", stale="empty")
    start_legacy(legacy_empty)
    assert live(new_live, legacy_empty).returncode == 0
    assert [n for n in os.listdir(legacy_empty) if n.startswith("state.pre-adopt.")] == []
    # No stale dir at all.
    legacy_none = make_legacy("legacy-none", stale="none")
    start_legacy(legacy_none)
    assert live(new_live, legacy_none).returncode == 0
    print("PASS adoption with an empty or absent root state dir")

    # Same sha as the hand-made install: the rebuild moves the legacy tag, so the
    # rollback target is the pre-adopt tag, which keeps the ORIGINAL image id.
    same = make_legacy("legacy-same")
    start_legacy(same)
    res = live(cur_sha, same)
    assert res.returncode == 0, res.stdout
    pin = (same / "previous").read_text().strip()
    assert (same / "current").read_text().strip() == cur_image and pin.startswith(f"{live_project}:pre-adopt-")
    assert (tagdir / pin).read_text().strip() == "orig-id" and (tagdir / cur_image).read_text().startswith("built-")
    print("PASS same-sha adoption pins the original image under a pre-adopt tag (rebuild moved the sha tag)")

    # --- adoption refusals leave everything alone ---
    for label, extras, fixup, needle in (
        ("current image missing", {"TEST_MISSING_IMAGES": cur_image}, None, "is not present"),
        ("state outside root", {}, lambda r: (r / "compose.env").write_text(
            (r / "compose.env").read_text().replace(f"{r}/release-{cur_sha}.randcur/state", "/etc")), "not a real"),
        ("no root compose.yaml", {}, lambda r: (r / "compose.yaml").unlink(), "compose.yaml is missing"),
        ("wrong service name", {"TEST_SERVICES": "web"}, None, "defines no 'gateway'"),
        ("other config_files label", {"TEST_LABEL_CONFIG": "/srv/other/compose.yaml"}, None, "was created from '/srv/other"),
        ("wrong published port", {"TEST_PORT": "127.0.0.1:18789"}, None, "expected 127.0.0.1:18790"),
        ("agent guard", {"TEST_GUARD_FAIL": "1"}, None, "serves an agent this release does not ship"),
    ):
        r = make_legacy("refuse-" + label.replace(" ", "-"))
        start_legacy(r)
        if fixup:
            fixup(r)
        before = snapshot_legacy(r)
        log_len = len(log.read_text())
        res = live(new_live, r, **extras)
        assert res.returncode == 1 and needle in res.stdout, (label, res.stdout)
        assert active.read_text().strip() == cur_image
        assert snapshot_legacy(r) == before, label
        calls = log.read_text()[log_len:].splitlines()
        assert not any(" stop " in c for c in calls), label
        assert [f.name for f in tagdir.iterdir() if "pre-adopt" in f.name] == [], label
        if label != "agent guard":  # that one runs after the build, still before any stop
            assert not any(c.startswith("build") for c in calls), label
    notrunning = make_legacy("refuse-not-running")
    start_legacy(notrunning)
    active.unlink()
    res = live(new_live, notrunning)
    assert res.returncode == 1 and "is not running" in res.stdout, res.stdout
    print("PASS adoption refusals happen before any stop and change nothing")

    # --- adoption failures restore EXACTLY the pre-adoption state ---
    for label, extras in (
        ("readiness timeout", {"TEST_NO_READY_IMAGE": new_live_image}),
        ("copy failure", {"TEST_FAIL_CP": "1"}),
        ("record rename failure", {"TEST_FAIL_MV_CURRENT": "1"}),
        ("ln failure", {"TEST_FAIL_LN": "1"}),
        ("backup mkdir failure", {"TEST_FAIL_MKDIR": "1"}),
        ("backup cp failure", {"TEST_FAIL_CP_BACKUP": "1"}),
    ):
        for stale in ("content", "none"):
            r = make_legacy(f"fail-{label.replace(' ', '-')}-{stale}", stale=stale)
            start_legacy(r)
            before = snapshot_legacy(r)
            res = live(new_live, r, **extras)
            assert res.returncode != 0, (label, res.stdout)
            assert f"Rollback ready on {live_project}:pre-adopt-" in res.stdout, (label, res.stdout)
            assert_original(r, before, f"{label}/{stale}")
    print("PASS failed adoption (not ready, copy, rename, link) restores compose.env, records, STATE_DIR, image and compose file exactly")

    # Same-sha adoption that fails after readiness: the moved sha tag is put back.
    r = make_legacy("fail-same-sha")
    start_legacy(r)
    before = snapshot_legacy(r)
    res = live(cur_sha, r, TEST_FAIL_LN="1")
    assert res.returncode != 0 and f"Rollback ready on {live_project}:pre-adopt-" in res.stdout, res.stdout
    assert_original(r, before, "same-sha failure")
    print("PASS failed same-sha adoption restarts the original image id and restores its tag")

    # Records cannot be restored (compose.env.saved rename fails): the backup and the pin
    # survive, the rollback falls back to the backup env file, and the message names them.
    r = make_legacy("fail-records")
    start_legacy(r)
    before = snapshot_legacy(r)
    res = live(new_live, r, TEST_FAIL_MV_CURRENT="1", TEST_FAIL_MV_SAVED="1")
    assert res.returncode != 0 and "could not fully restore activation records" in res.stdout, res.stdout
    assert f"Rollback ready on {live_project}:pre-adopt-" in res.stdout and "KEPT for manual recovery" in res.stdout
    backups = [n for n in os.listdir(r) if n.startswith("adopt-backup.")]
    assert len(backups) == 1 and f"{r}/{backups[0]}" in res.stdout
    assert (r / backups[0] / "compose.env").read_text() == before["compose.env"].decode()
    pins = [f.name for f in tagdir.iterdir() if "pre-adopt" in f.name]
    assert len(pins) == 1 and pins[0] in res.stdout
    assert Path(str(active) + ".state").read_text().strip() == f"{r}/release-{cur_sha}.randcur/state", "backup env used"
    assert "STATE_DIR=" + str(r / "state") in (r / "compose.env").read_text(), "compose.env really was not restored"
    print("PASS unrestorable records keep the backup and the pin, and print the manual recovery commands")

    # A failing housekeeping rm after activation must not fail the deploy or drop the pin.
    old_sha = "3" * 40
    r = make_legacy("housekeeping-fails")
    start_legacy(r)
    for age, extra in enumerate(("3", "4", "5", "6", "7"), start=1):
        add_release(r, extra * 40)
        os.utime(r / "releases" / (extra * 40), (age, age))
    res = live(new_live, r, TEST_FAIL_RM=f"/releases/{old_sha}")
    assert res.returncode == 0 and "FAILED" not in res.stdout, res.stdout
    assert (r / "current").read_text().strip() == new_live_image
    pin = (r / "previous").read_text().strip()
    assert pin.startswith(f"{live_project}:pre-adopt-") and (tagdir / pin).exists()
    assert (r / "releases" / old_sha).exists() and not (r / "releases" / ("4" * 40)).exists()
    print("PASS housekeeping failure after activation leaves a successful deploy, records and pin intact")

    # LIVEX_UNMANAGED_AGENTS: the live config serves oncall, which this release does not ship.
    r = make_legacy("unmanaged-refused")
    start_legacy(r)
    before = snapshot_legacy(r)
    log_len = len(log.read_text())
    res = live(new_live, r, TEST_LIVE_AGENTS="oncall")
    assert res.returncode == 1 and "serves an agent this release does not ship" in res.stdout, res.stdout
    assert snapshot_legacy(r) == before and active.read_text().strip() == cur_image
    assert not any(" stop " in c for c in log.read_text()[log_len:].splitlines())
    r = make_legacy("unmanaged-ok")
    start_legacy(r)
    res = live(new_live, r, TEST_LIVE_AGENTS="oncall", LIVEX_UNMANAGED_AGENTS="oncall")
    assert res.returncode == 0, res.stdout
    assert "LIVEX_UNMANAGED_AGENTS=oncall" in (base / "guard.log.check").read_text().splitlines()[-1]
    assert "LIVEX_HOST_PORT=18790" in (base / "guard.log.check").read_text().splitlines()[-1], "pre-stop check gets the live host port"
    assert "LIVEX_UNMANAGED_AGENTS=oncall" in (base / "guard.log.apply").read_text().splitlines()[-1]
    # An id other than the listed one is still refused.
    r = make_legacy("unmanaged-other")
    start_legacy(r)
    res = live(new_live, r, TEST_LIVE_AGENTS="oncall extra", LIVEX_UNMANAGED_AGENTS="oncall")
    assert res.returncode == 1 and "does not ship" in res.stdout
    for bad in ("Oncall", "oncall,", "a,b,c,d,e,f", "on call"):
        res = live(new_live, make_adopted("badlist-" + str(abs(hash(bad))), (new_live,)), LIVEX_UNMANAGED_AGENTS=bad)
        assert res.returncode == 1 and "must be 1 to 5" in res.stdout, (bad, res.stdout)
    res = run(head_sha, staging=False, root=make_root("nonlive-list", (head_sha,)), LIVEX_UNMANAGED_AGENTS="oncall")
    assert res.returncode == 1 and "only applies with LIVEX_DEV_LIVE=1" in res.stdout, res.stdout
    print("PASS LIVEX_UNMANAGED_AGENTS: forwarded to the pre-stop check and apply, refused without it, malformed or non-live rejected")

    # A re-run after a failed adoption adopts cleanly (idempotent).
    r = make_legacy("fail-then-ok")
    start_legacy(r)
    assert live(new_live, r, TEST_NO_READY_IMAGE=new_live_image).returncode != 0
    assert live(new_live, r).returncode == 0
    assert (r / "current").read_text().strip() == new_live_image
    print("PASS adoption is retryable after a failed attempt")

    # --- deploy.sh / deploy_dev.sh / Makefile on a throwaway committed repo ---
    import subprocess as sp
    tooling = base / "tooling"
    (tooling / "livex-native").mkdir(parents=True)
    shutil.copytree(deploy, tooling / "livex-native" / "deploy", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copyfile(deploy.parent.parent / "Makefile", tooling / "Makefile")
    origin = base / "origin.git"
    git = lambda *a, cwd=tooling: sp.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=cwd,
                                          text=True, stdout=sp.PIPE, stderr=sp.STDOUT, check=True)
    git("init", "-q")
    git("checkout", "-q", "-b", "main")
    git("add", "-A")
    git("commit", "-qm", "tooling")
    git("init", "-q", "--bare", str(origin), cwd=base)
    git("remote", "add", "origin", str(origin))
    gcloud_log = base / "gcloud.log"
    gbin = base / "gbin"
    gbin.mkdir()
    (gbin / "gcloud").write_text(f'#!/bin/bash\necho "$@" >>"{gcloud_log}"\nexit 99\n')
    (gbin / "gcloud").chmod(0o755)
    genv = {**os.environ, "PATH": f"{gbin}:{os.environ['PATH']}"}
    genv.pop("LIVEX_DEV_LIVE", None)

    def sh(cmd, **extra):
        return sp.run(cmd, cwd=tooling, env={**genv, **extra}, text=True, stdout=sp.PIPE, stderr=sp.STDOUT)

    head = git("rev-parse", "HEAD").stdout.strip()
    r = sh(["make", "deploy_dev_dry"])
    assert r.returncode != 0 and "not on any origin branch" in r.stdout, r.stdout
    git("push", "-q", "origin", "main")
    (tooling / "livex-native" / "untracked.txt").write_text("x\n")
    r = sh(["make", "deploy_dev_dry"])
    assert r.returncode != 0 and "uncommitted or untracked" in r.stdout and "untracked.txt" in r.stdout, r.stdout
    (tooling / "livex-native" / "untracked.txt").unlink()
    (tooling / "unrelated.txt").write_text("x\n")  # outside livex-native: not part of the archive
    n = sh(["make", "-n", "deploy_dev"])
    assert n.returncode == 0 and "LIVEX_DEV_LIVE=1" in n.stdout and "livex-openclaw-native-dev" in n.stdout, n.stdout
    d = sh(["make", "deploy_dev_dry"], LIVEX_TEST_IAP="0")
    assert d.returncode == 0, d.stdout
    for needle in ("livex-openclaw-dev", "/opt/livex-openclaw-native-dev", "project livex-openclaw-native-dev",
                   "LIVE:", "Dry run: nothing was uploaded", "LIVEX_DEV_LIVE=1", f"@ {head}"):
        assert needle in d.stdout, (needle, d.stdout)
    assert "livex-openclaw-stage" not in d.stdout and not gcloud_log.exists(), d.stdout
    (tooling / "unrelated.txt").unlink()
    assert "origin/main" in d.stdout and "LIVE Gateway" in d.stdout
    assert "(LIVEX_UNMANAGED_AGENTS): oncall" in d.stdout and "Unmanaged agents left untouched: oncall" in d.stdout, d.stdout
    assert 'LIVEX_UNMANAGED_AGENTS="oncall"' in n.stdout
    strict = sh(["make", "deploy_dev_dry", "LIVEX_UNMANAGED_AGENTS="], LIVEX_TEST_IAP="0")
    assert strict.returncode == 0 and "none (strict)" in strict.stdout, strict.stdout
    assert "LIVEX_UNMANAGED_AGENTS=oncall" in d.stdout.replace("\\", "") or "LIVEX_UNMANAGED_AGENTS=oncall" in d.stdout, d.stdout
    for bad in ("Oncall", "a,b,c,d,e,f"):
        r = sh(["bash", "livex-native/deploy/deploy.sh", head, "--dry-run"], LIVEX_DEV_LIVE="1", LIVEX_UNMANAGED_AGENTS=bad)
        assert r.returncode == 1 and "must be 1 to 5" in r.stdout and not gcloud_log.exists(), r.stdout
    r = sh(["bash", "livex-native/deploy/deploy.sh", head, "--dry-run"], LIVEX_UNMANAGED_AGENTS="oncall")
    assert r.returncode == 1 and "only applies with LIVEX_DEV_LIVE=1" in r.stdout and not gcloud_log.exists()
    for extras in ({"LIVEX_ON_DEV_VM": "1"}, {"LIVEX_TEST_VM": "livex-openclaw-test"}):
        bad = sh(["bash", "livex-native/deploy/deploy.sh", head, "--dry-run"], LIVEX_DEV_LIVE="1", **extras)
        assert bad.returncode == 1 and "cannot be combined" in bad.stdout and not gcloud_log.exists(), bad.stdout
    plain = sh(["bash", "livex-native/deploy/deploy.sh", head, "--dry-run"], LIVEX_TEST_IAP="0")
    assert plain.returncode == 0 and "livex-openclaw-native-dev" not in plain.stdout, plain.stdout
    print("PASS make deploy_dev / deploy_dev_dry: preconditions, live target, mode refusals, no gcloud call on dry run")
    # deploy.sh itself enforces the confirmation, so a direct call cannot skip it.
    direct = sh(["bash", "livex-native/deploy/deploy.sh", head], LIVEX_DEV_LIVE="1")
    assert direct.returncode == 1 and "CONFIRM=livex-openclaw-dev" in direct.stdout and not gcloud_log.exists(), direct.stdout
    # A real deploy needs CONFIRM; the refusal comes before any gcloud call.
    for cmd in (["make", "deploy_dev"], ["make", "deploy_dev", "CONFIRM=yes"],
                ["bash", "livex-native/deploy/deploy_dev.sh"]):
        r = sh(cmd)
        assert r.returncode != 0 and "CONFIRM=livex-openclaw-dev" in r.stdout and not gcloud_log.exists(), r.stdout
    r = sh(["make", "deploy_dev", "CONFIRM=livex-openclaw-dev"])
    assert "Archive:" in r.stdout and gcloud_log.read_text().startswith("compute ssh livex-openclaw-dev"), r.stdout
    print("PASS deploy_dev needs CONFIRM=livex-openclaw-dev; the dry run does not")

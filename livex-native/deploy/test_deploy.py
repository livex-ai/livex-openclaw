"""Exercise the real deploy lifecycle with Docker and HTTP stubbed."""

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

deploy = Path(__file__).resolve().parent
remote = os.environ.get("TEST_REMOTE_SCRIPT", str(deploy / "remote.sh"))
with tempfile.TemporaryDirectory(prefix="pr50-stage-probe-") as scratch:
    base = Path(scratch)
    binpath = base / "bin"
    binpath.mkdir()
    log = base / "docker.log"
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
    fake("ln", '[[ -z ${TEST_FAIL_LN:-} ]] || exit 1\nexec /bin/ln "$@"\n')
    fake("curl", r"""image=$(cat "$TEST_ACTIVE")
printf '%s\n' "$image" >>"$TEST_CURL_LOG"
[[ $image != "${TEST_NO_READY_IMAGE:-}" ]]
""")
    fake("docker", r'''printf '%s\n' "$*" >>"$TEST_DOCKER_LOG"
case "$1" in
  build) ;;
  info) printf '%s\n' "${TEST_DOCKER_ROOT:-}" ;;
  compose)
    printf '%s\n' "${LIVEX_GATEWAY_MEM_LIMIT-unset}" >>"$TEST_MEM_LOG"
    [[ $2 == --project-name && $3 == "$TEST_EXPECT_PROJECT" ]]
    [[ "$LIVEX_STAGE_ONLY" == "$TEST_STAGE" ]]
    shift 5
    case "$1" in
      stop) rm -f "$TEST_ACTIVE" ;;
      run)
        if [[ " $* " == *" /opt/livex-native/deploy/apply.mjs "* ]]; then
          [[ " $* " == *" LIVEX_STAGE_ONLY=$TEST_STAGE "* ]]
          printf '%s\n' "$OPENCLAW_IMAGE" >"$STATE_DIR/apply-result"
        fi
        ;;
      up) printf '%s\n' "$OPENCLAW_IMAGE" >"$TEST_ACTIVE" ;;
      *) exit 75 ;;
    esac ;;
  inspect)
    [[ $4 == "$TEST_EXPECT_PROJECT-gateway-1" ]]
    if [[ $3 == '{{.State.Running}}' ]]; then
      [[ ! -e $TEST_ACTIVE ]] || echo true
    elif [[ -f $TEST_ACTIVE ]]; then
      image=$(cat "$TEST_ACTIVE")
      if [[ $image == "${TEST_WRONG_IMAGE:-}" ]]; then
        printf 'sha256:stale\n'
      else
        printf 'sha256:%s\n' "${image#*:}"
      fi
    fi ;;
  image)
    if [[ $2 == inspect ]]; then
      printf 'sha256:%s\n' "${5#*:}"
    elif [[ $2 == ls ]]; then
      [[ "${*: -1}" == "$TEST_EXPECT_PROJECT" ]]
    else
      [[ $2 == rm ]]
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
            "LIVEX_MIN_FREE_GIB": "0",
            "TEST_HOSTNAME": "livex-openclaw-dev" if staging else "livex-openclaw-test",
            "TEST_EXPECT_PROJECT": project if staging else "livex-openclaw-test",
            "TEST_STAGE": "1" if staging else "0",
            **extras,
        }
        add_release(root, sha)
        result = subprocess.run(["bash", remote, sha], env=env,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print("\n".join(line for line in result.stdout.splitlines()
                        if "STAGED" in line or "FAILED" in line or
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

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
    prior_image = f"{project}:{prior_sha}"
    head_image = f"{project}:{head_sha}"
    broken_image = f"{project}:{broken_sha}"

    def fake(name, body):
        script = binpath / name
        script.write_text("#!/bin/bash\nset -eu\n" + body)
        script.chmod(0o755)

    fake("hostname", 'echo "$TEST_HOSTNAME"\n')
    fake("curl", r"""image=$(cat "$TEST_ACTIVE")
printf '%s\n' "$image" >>"$TEST_CURL_LOG"
[[ $image != "${TEST_NO_READY_IMAGE:-}" ]]
""")
    fake("docker", r'''printf '%s\n' "$*" >>"$TEST_DOCKER_LOG"
case "$1" in
  build) ;;
  compose)
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

    def make_root(name, shas):
        root = base / name
        for item in ("state", "gcloud"):
            (root / item).mkdir(parents=True)
        (root / "runtime.env").write_text("OPENCLAW_GATEWAY_TOKEN=fixture-only\n")
        for sha in shas:
            release = root / "releases" / sha / "livex-native/deploy"
            release.mkdir(parents=True)
            for name in ("compose.yaml", "Dockerfile", "versions.env"):
                shutil.copyfile(deploy / name, release / name)
        return root

    root = make_root("stage", (prior_sha, head_sha, broken_sha))
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
            "TEST_HOSTNAME": "livex-openclaw-dev" if staging else "livex-openclaw-test",
            "TEST_EXPECT_PROJECT": project if staging else "livex-openclaw-test",
            "TEST_STAGE": "1" if staging else "0",
            **extras,
        }
        result = subprocess.run(["bash", remote, sha], env=env,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print("\n".join(line for line in result.stdout.splitlines()
                        if "STAGED" in line or "FAILED" in line or
                        "Rollback ready" in line or "not ready at" in line or "DEPLOYED" in line))
        return result

    success = run(head_sha)
    assert success.returncode == 0, success.stdout
    assert f"STAGED {head_sha}" in success.stdout
    assert (root / "current").read_text().strip() == head_image
    assert (root / "previous").read_text().strip() == prior_image
    assert "LIVEX_STAGE_ONLY=1" in (root / "compose.env").read_text()
    snapshot = root / "releases" / head_sha / "state.before.tgz"
    baseline = hashlib.sha256(snapshot.read_bytes()).hexdigest()

    retry = run(head_sha)
    assert retry.returncode == 0, retry.stdout
    assert (root / "previous").read_text().strip() == prior_image
    assert hashlib.sha256(snapshot.read_bytes()).hexdigest() == baseline
    print("PASS same-SHA staging preserves prior release and original snapshot")

    timed_out = run(broken_sha, TEST_WRONG_IMAGE=broken_image)
    assert timed_out.returncode == 1, timed_out.stdout
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

    active.unlink()
    test_root = make_root("dedicated", (head_sha,))
    test = run(head_sha, staging=False, root=test_root)
    assert test.returncode == 0, test.stdout
    assert f"DEPLOYED {head_sha}" in test.stdout
    assert "LIVEX_STAGE_ONLY=0" in (test_root / "compose.env").read_text()
    assert active.read_text().strip() == f"livex-openclaw-test:{head_sha}"
    print("PASS dedicated VM uses original project and non-staging config")

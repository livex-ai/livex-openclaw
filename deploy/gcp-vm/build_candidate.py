import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

from release_inputs import concurrency_limit, release_arguments, reviewed_prompt_hash

os.umask(0o077)
source, old_id = release_arguments(sys.argv[1:3])
root = pathlib.Path("/opt/livex-openclaw/releases") / source
upload = pathlib.Path(__file__).resolve().parent
context = (upload / "package-context").resolve(strict=True)
expected_source, expected_package = sys.argv[3:5]
resume = sys.argv[5:] == ["--resume-after-base"]
if sys.argv[5:] and not resume:
    sys.exit("Unknown build option")


def digest(p):
    with p.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


if not (digest(upload / "source.tar.gz") == expected_source):
    raise RuntimeError("source archive mismatch")
if not (digest(context / "openclaw-current.tgz") == expected_package):
    raise RuntimeError("package mismatch")
if root.exists() and not resume:
    raise RuntimeError(
        "candidate release already exists; reconcile instead of rebuilding"
    )
if not (shutil.disk_usage("/").free > 5 * 1024**3):
    raise RuntimeError("insufficient build disk")
old_tag = "livex-openclaw-node-donor:" + source
if not resume:
    subprocess.run(["docker", "tag", old_id, old_tag], check=True)
if not (
    subprocess.check_output(
        ["docker", "image", "inspect", old_tag, "--format", "{{.Id}}"], text=True
    ).strip()
    == old_id
):
    raise RuntimeError("Node donor identity mismatch")
build = root / "build"
logs = root / "build-logs"
if not resume:
    root.mkdir(mode=0o700)
    build.mkdir()
    logs.mkdir(mode=0o700)
    subprocess.run(
        ["tar", "-xzf", str(upload / "source.tar.gz"), "-C", str(build)], check=True
    )
base = "livex-openclaw-e2e-base:" + source
runtime = "livex-openclaw-runtime:" + source
final = runtime + "-node2416"
sdk = "gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:1855ee6031f03bb7d4b251cfd0e5b88a18fd9a2552a742cf86d269810832c80b"
node_context = root / "node2416"
node_dockerfile = (
    "FROM "
    + old_tag
    + " AS pinned_node\nFROM "
    + runtime
    + '\nUSER root\nCOPY --from=pinned_node /usr/local/bin/node /usr/local/bin/node\nLABEL livex.node.version=24.16.0\nRUN test "$(node --version)" = "v24.16.0" && echo \'b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd  /usr/local/bin/node\' | sha256sum -c -\nUSER 1000:1000\n'
)
if resume:
    if (node_context / "Dockerfile").read_text() != node_dockerfile:
        sys.exit("Node pin differs from the staged release")
else:
    node_context.mkdir()
    (node_context / "Dockerfile").write_text(node_dockerfile)
steps = [
    (
        "base",
        [
            "docker",
            "buildx",
            "build",
            "--load",
            "--platform",
            "linux/amd64",
            "--progress=plain",
            "--target",
            "functional",
            "--build-context",
            "openclaw_package=" + str(context),
            "--build-arg",
            "OPENCLAW_FS_SAFE_NATIVE_CONTRACT=required",
            "-t",
            base,
            "-f",
            "scripts/e2e/Dockerfile",
            ".",
        ],
        build,
    ),
    (
        "runtime",
        [
            "docker",
            "build",
            "--platform=linux/amd64",
            "--progress=plain",
            "-f",
            "deploy/gcp-vm/Dockerfile",
            "--build-arg",
            "FORK_IMAGE=" + base,
            "--build-arg",
            "SDK_IMAGE=" + sdk,
            "--build-arg",
            "SOURCE_SHA=" + source,
            "-t",
            runtime,
            ".",
        ],
        build,
    ),
    (
        "node-pin",
        [
            "docker",
            "build",
            "--platform=linux/amd64",
            "--progress=plain",
            "-t",
            final,
            ".",
        ],
        node_context,
    ),
]
receipts = []
if resume:
    from release_inputs import verify_base_checkpoint

    receipts = json.loads((root / "build-receipts.json").read_text())
    image_id = subprocess.check_output(
        ["docker", "image", "inspect", base, "--format", "{{.Id}}"], text=True
    ).strip()
    verify_base_checkpoint(
        receipts, steps[0][1], image_id, (logs / "base.log").read_text()
    )
    if (root / "image-receipt.json").exists() or any(
        (logs / name).exists() for name in ("runtime.log", "node-pin.log")
    ):
        sys.exit("Later stage already attempted; inspect its receipt")
    # The interrupted build directory may have changed since the first invocation.
    clean_source = pathlib.Path(tempfile.mkdtemp(prefix="runtime-source-", dir=root))
    subprocess.run(
        ["tar", "-xzf", str(upload / "source.tar.gz"), "-C", str(clean_source)],
        check=True,
    )
    runtime_stage, runtime_command, _ = steps[1]
    steps = [(runtime_stage, runtime_command, clean_source), steps[2]]
for name, cmd, cwd in steps:
    if not (shutil.disk_usage("/").free > 3 * 1024**3):
        raise RuntimeError("insufficient remaining build disk")
    if name == "runtime":
        prompt_sha = reviewed_prompt_hash(
            (cwd / "deploy/gcp-vm/oncall-vm-prompt.sha256").read_text()
        )
        profile = json.loads(
            (cwd / "livex-agents/config/openclaw.template.json").read_bytes()
        )
        desired_concurrency = concurrency_limit(
            profile["agents"]["defaults"]["maxConcurrent"]
        )
    print("START " + name, flush=True)
    with (logs / (name + ".log")).open("x") as f:
        r = subprocess.run(
            cmd, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, check=False
        )
    receipts.append(
        {
            "name": name,
            "command": cmd,
            "exit": r.returncode,
            "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
    )
    (root / "build-receipts.json").write_text(json.dumps(receipts, indent=2) + "\n")
    print(name + " exit=" + str(r.returncode), flush=True)
    if r.returncode:
        raise SystemExit(r.returncode)
d = json.loads(
    subprocess.check_output(["docker", "image", "inspect", final], text=True)
)[0]
if not (d["Config"]["Labels"]["org.opencontainers.image.revision"] == source):
    raise RuntimeError("source label mismatch")
if not (d["Config"]["User"] == "1000:1000"):
    raise RuntimeError("runtime user mismatch")
receipt = {
    "source": source,
    "sourceArchiveSha256": expected_source,
    "packageSha256": expected_package,
    "image": d["Id"],
    "tag": final,
    "nodeVersion": "24.16.0",
    "previousImage": old_id,
    "maxConcurrent": desired_concurrency,
    "oncallPromptSha256": prompt_sha,
}
(root / "image-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt), flush=True)

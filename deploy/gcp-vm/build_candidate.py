import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys

from release_inputs import release_arguments

os.umask(0o077)
source, old_id = release_arguments(sys.argv[1:3])
root = pathlib.Path("/opt/livex-openclaw/releases") / source
upload = pathlib.Path(__file__).resolve().parent
context = upload / "package-context"
expected_source, expected_package = sys.argv[3:]


def digest(p):
    with p.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


if not (digest(upload / "source.tar.gz") == expected_source):
    raise RuntimeError("source archive mismatch")
if not (digest(context / "openclaw-current.tgz") == expected_package):
    raise RuntimeError("package mismatch")
if root.exists():
    raise RuntimeError(
        "candidate release already exists; reconcile instead of rebuilding"
    )
if not (shutil.disk_usage("/").free > 5 * 1024**3):
    raise RuntimeError("insufficient build disk")
old_tag = "livex-openclaw-node-donor:" + source
subprocess.run(["docker", "tag", old_id, old_tag], check=True)
if not (
    subprocess.check_output(
        ["docker", "image", "inspect", old_tag, "--format", "{{.Id}}"], text=True
    ).strip()
    == old_id
):
    raise RuntimeError("Node donor identity mismatch")
root.mkdir(mode=0o700)
build = root / "build"
build.mkdir()
logs = root / "build-logs"
logs.mkdir(mode=0o700)
subprocess.run(
    ["tar", "-xzf", str(upload / "source.tar.gz"), "-C", str(build)], check=True
)
base = "livex-openclaw-e2e-base:" + source
runtime = "livex-openclaw-runtime:" + source
final = runtime + "-node2416"
sdk = "gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:1855ee6031f03bb7d4b251cfd0e5b88a18fd9a2552a742cf86d269810832c80b"
node_context = root / "node2416"
node_context.mkdir()
(node_context / "Dockerfile").write_text(
    "FROM "
    + old_tag
    + " AS pinned_node\nFROM "
    + runtime
    + '\nUSER root\nCOPY --from=pinned_node /usr/local/bin/node /usr/local/bin/node\nLABEL livex.node.version=24.16.0\nRUN test "$(node --version)" = "v24.16.0" && echo \'b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd  /usr/local/bin/node\' | sha256sum -c -\nUSER 1000:1000\n'
)
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
for name, cmd, cwd in steps:
    if not (shutil.disk_usage("/").free > 3 * 1024**3):
        raise RuntimeError("insufficient remaining build disk")
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
}
(root / "image-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt), flush=True)

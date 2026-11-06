"""Run as root on the VM after candidate image build and review. No Slack posts."""

import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

from agent_bundle import BUNDLED as AGENT_BUNDLE, validate_bundle, with_agents, workspace

from release_inputs import (
    release_arguments,
    require_vm_policies,
    select_image,
    with_concurrency,
)
from vm_prompt import (
    BUNDLED,
    install_prompt,
    prior_hash,
    read_prompt,
    sha,
    verify_active,
)


def activate(root, source, old_image):
    release = root / "releases" / source
    container = "livex-openclaw-dev-gateway-1"
    compose = [
        "docker",
        "compose",
        "--project-name",
        "livex-openclaw-dev",
        "--env-file",
        str(root / "release.env"),
        "-f",
        str(root / "compose.yaml"),
    ]

    def digest(path):
        with path.open("rb") as f:
            return hashlib.file_digest(f, "sha256").hexdigest()

    def inspect_container():
        p = subprocess.run(
            ["docker", "inspect", container],
            text=True,
            capture_output=True,
            check=True,
            timeout=30,
        )
        return json.loads(p.stdout)[0]

    def verify_mount(container_info, agent_ids=("oncall",)):
        state = "/home/node/.openclaw"
        prompts = [workspace(agent_id) + "/AGENTS.md" for agent_id in agent_ids]
        mounts = container_info.get("Mounts", [])
        if not any(
            m.get("Type") == "bind"
            and m.get("Source") == str(root / "state")
            and m.get("Destination") == state
            for m in mounts
        ) or any(
            any(prompt == m.get("Destination") or prompt.startswith(m.get("Destination", "") + "/")
                for prompt in prompts)
            for m in mounts if m.get("Destination", "").startswith(state + "/")
        ):
            raise RuntimeError(
                "Unexpected managed workspace mount; reconcile before deployment"
            )

    def rpc(method, params, required):
        p = subprocess.run(
            [
                "docker",
                "exec",
                container,
                "node",
                "/app/openclaw.mjs",
                "gateway",
                "call",
                method,
                "--params",
                json.dumps(params),
                "--json",
            ],
            text=True,
            capture_output=True,
            check=True,
            timeout=90,
        )
        for i, c in enumerate(p.stdout):
            if c != "{":
                continue
            try:
                value, _ = json.JSONDecoder().raw_decode(p.stdout[i:])
            except ValueError:
                continue
            if isinstance(value, dict) and required.issubset(value):
                return value
        raise RuntimeError("Native RPC result could not be verified: " + method)

    def verify_configuration(content, agent_ids):
        # Native hashes distinguish saved configuration from the applied runtime.
        # Do not retain the redacted snapshot or any operational configuration.
        result = rpc("config.get", {}, {"valid", "sourceConfig", "configRevisionHash", "appliedConfigHash", "path"})
        if (result.get("valid") is not True
                or result.get("path") != "/home/node/.openclaw/openclaw.json"
                or not result.get("configRevisionHash")
                or result.get("configRevisionHash") != result.get("appliedConfigHash")):
            raise RuntimeError("Native Gateway has not applied the installed configuration")
        expected = json.loads(content).get("agents", {}).get("entries", {})
        actual = result.get("sourceConfig", {}).get("agents", {}).get("entries", {})
        for agent_id in agent_ids:
            if agent_id not in actual:
                raise RuntimeError("Managed agent is missing from the native configuration")
            for key in ("name", "description", "workspace", "skills", "subagents"):
                if actual.get(agent_id, {}).get(key) != expected.get(agent_id, {}).get(key):
                    raise RuntimeError("Native managed agent configuration mismatch: " + agent_id + "." + key)
        return result.get("appliedConfigHash")

    def atomic_replace(path, content):
        metadata = path.stat()
        fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            os.fchmod(fd, stat.S_IMODE(metadata.st_mode))
            os.fchown(fd, metadata.st_uid, metadata.st_gid)
            with os.fdopen(fd, "wb") as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    candidate = json.loads((release / "image-receipt.json").read_text())
    if not (candidate["source"] == source and candidate["previousImage"] == old_image):
        raise RuntimeError(
            "Release receipt does not match requested source and previous image"
        )
    new_image = candidate["image"]
    if not (re.fullmatch("sha256:[0-9a-f]{64}", new_image)):
        raise RuntimeError("Invalid candidate image ID")
    image = json.loads(
        subprocess.check_output(["docker", "image", "inspect", new_image], text=True)
    )[0]
    if not (image["Config"]["Labels"]["org.opencontainers.image.revision"] == source):
        raise RuntimeError("Candidate source label mismatch")
    if not (image["Config"]["Labels"]["livex.node.version"] == "24.16.0"):
        raise RuntimeError("Candidate Node label mismatch")
    if not (image["Config"]["User"] == "1000:1000"):
        raise RuntimeError("Unexpected candidate runtime user")
    config_name = "state/openclaw.json"
    config_path = root / config_name
    if config_path.is_symlink():
        raise RuntimeError("Expected a regular mounted VM config")
    old_config = config_path.read_bytes()
    require_vm_policies(old_config)
    target = candidate["maxConcurrent"]
    new_config = with_concurrency(old_config, target)
    old_release = (root / "release.env").read_bytes()
    new_release = select_image(old_release, old_image, new_image)
    before = inspect_container()
    if not (before["Image"] == old_image and before["State"]["Running"]):
        raise RuntimeError("Unexpected active runtime")
    if not (before["State"].get("Health", {}).get("Status") == "healthy"):
        raise RuntimeError("Gateway must be healthy before activation")
    verify_mount(before)
    before_sha = prior_hash(root, before)
    old_prompt = read_prompt(root)
    if sha(old_prompt) != before_sha:
        raise RuntimeError(
            "Active AGENTS.md differs from its reviewed baseline; reconcile local edits before deploying"
        )
    verify_active(rpc, before_sha)
    prompt_sha = candidate["oncallPromptSha256"]
    new_prompt = subprocess.check_output(
        [
            "docker",
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--entrypoint",
            "cat",
            new_image,
            BUNDLED,
        ],
        timeout=30,
    )
    if sha(new_prompt) != prompt_sha:
        raise RuntimeError("Bundled oncall prompt differs from the reviewed digest")
    old_prompts = {"oncall": old_prompt}
    new_prompts = {"oncall": new_prompt}
    previous_hashes = {"oncall": before_sha}
    previous_source = before["Config"]["Labels"]["org.opencontainers.image.revision"]
    previous = json.loads((root / "releases" / previous_source / "image-receipt.json").read_bytes())
    previous_hashes = previous.get("agentPromptSha256", previous_hashes)
    bundle = None
    if not candidate.get("agentBundleSha256") and set(previous_hashes) != {"oncall"}:
        raise RuntimeError("Legacy candidate cannot preserve managed agents; retire them explicitly before downgrade")
    if candidate.get("agentBundleSha256"):
        raw_bundle = subprocess.check_output(
            ["docker", "run", "--rm", "--pull", "never", "--network", "none",
             "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
             "--entrypoint", "cat", new_image, AGENT_BUNDLE], timeout=30,
        )
        if sha(raw_bundle) != candidate.get("agentBundleSha256"):
            raise RuntimeError("Agent bundle differs from the reviewed image receipt")
        bundle = validate_bundle(json.loads(raw_bundle))
        verify_mount(before, bundle.get("agents"))
        if set(previous_hashes) - set(bundle.get("agents")):
            raise RuntimeError("Managed agent removal requires explicit retirement; state is preserved")
        if bundle.get("agents").get("oncall").get("sha256") != prompt_sha:
            raise RuntimeError("Oncall prompt disagrees with agent bundle")
        for agent_id, item in bundle.get("agents").items():
            old = read_prompt(root, agent_id)
            baseline = previous_hashes.get(agent_id)
            if baseline is None:
                if old is not None:
                    raise RuntimeError("New managed workspace already contains instructions; reconcile")
            else:
                if old is None or sha(old) != baseline:
                    raise RuntimeError("Managed agent prompt differs from its previous release")
                verify_active(rpc, baseline, agent_id)
            old_prompts[agent_id] = old
            new_prompts[agent_id] = item.get("prompt").encode()
        new_config = with_agents(new_config, bundle, set(previous_hashes))
        require_vm_policies(new_config)
    expected_prompts = dict(old_prompts)
    active = rpc(
        "sessions.list",
        {
            "activeOnly": True,
            "includeGlobal": True,
            "includeUnknown": True,
            "limit": 1,
            "archived": "all",
        },
        {"sessions"},
    )
    if not (active["sessions"] == [] and active["totalCount"] == 0):
        raise RuntimeError("Active or queued work; wait before deployment")
    protected = [
        "state/openclaw.json",
        "runtime.env",
        "compose.yaml",
        "openclaw.sh",
        "start-gateway.sh",
    ]
    protected_hashes = {name: digest(root / name) for name in protected}
    protected_hashes[config_name] = hashlib.sha256(old_config).hexdigest()
    backup_bytes = sum(
        int(line.split()[0])
        for line in subprocess.check_output(
            [
                "du",
                "-sb",
                "state",
                "gcloud",
                "runtime.env",
                "release.env",
                "compose.yaml",
                "openclaw.sh",
                "start-gateway.sh",
            ],
            cwd=root,
            text=True,
        ).splitlines()
    )
    if shutil.disk_usage(root).free <= backup_bytes + 2 * 1024**3:
        raise RuntimeError("Insufficient backup headroom")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    logs = release / ("activation-" + stamp)
    logs.mkdir(mode=0o700)
    receipt = {
        "source": source,
        "previousImage": old_image,
        "previousPromptSha256": before_sha,
        "expectedPromptSha256": prompt_sha,
        "candidateImage": new_image,
        "checks": [],
        "status": "preparing",
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    receipt_path = logs / "receipt.json"

    def save():
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")

    def save_if_possible():
        try:
            save()
        except OSError as exc:
            print(f"Could not save recovery receipt: {exc}", file=sys.stderr)

    def logged(name, command, timeout=180):
        print("CHECK " + name, flush=True)
        step_started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with (logs / (name + ".log")).open("x") as f:
            result = subprocess.run(
                command,
                stdout=f,
                stderr=subprocess.STDOUT,
                timeout=timeout,
                check=False,
            )
        receipt["checks"].append(
            {
                "name": name,
                "exit": result.returncode,
                "startedAt": step_started,
                "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
        )
        save()
        if result.returncode:
            raise RuntimeError("Step failed: " + name + "; inspect private log")

    def unchanged():
        if any(read_prompt(root, agent_id) != expected
               for agent_id, expected in expected_prompts.items()):
            raise RuntimeError("Mounted agent prompt changed; reconcile")
        if not (
            all((digest(root / name) == sha for name, sha in protected_hashes.items()))
        ):
            raise RuntimeError("Protected configuration changed; reconcile")

    def ready(expected, since):
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            d = inspect_container()
            if not (d["Image"] == expected):
                raise RuntimeError("Unexpected runtime image during readiness")
            if not d["State"]["Running"]:
                raise RuntimeError("Gateway exited during readiness")
            p = subprocess.run(
                ["docker", "logs", "--since", since, "--tail", "400", container],
                text=True,
                capture_output=True,
                check=True,
                timeout=30,
            )
            socket = "socket mode connected" in (p.stdout + p.stderr).lower()
            if d["State"].get("Health", {}).get("Status") == "healthy" and socket:
                verify_mount(d, new_prompts)
                return {
                    "image": expected,
                    "health": "healthy",
                    "slackSocketConnected": True,
                    "startedAt": d["State"]["StartedAt"],
                    "observedAt": datetime.datetime.now(
                        datetime.timezone.utc
                    ).isoformat(),
                }
            time.sleep(3)
        raise RuntimeError("Gateway health/Slack readiness deadline exceeded")

    stopped = False
    stop_attempted = False
    save()
    try:
        if not ((root / "release.env").read_bytes() == old_release):
            raise RuntimeError("Image selection changed during activation")
        if not (inspect_container()["Image"] == old_image):
            raise RuntimeError("Running image changed before stop")
        stop_attempted = True
        logged(
            "stop-old-gateway",
            compose + ["stop", "--timeout", "60", "gateway"],
            timeout=120,
        )
        stopped = True
        if inspect_container()["State"]["Running"]:
            raise RuntimeError("Gateway did not stop")
        unchanged()
        backup = root / "backups" / ("pre-deploy-" + stamp)
        backup.mkdir(mode=0o700)
        archive = backup / "installation.tar.gz"
        logged(
            "backup",
            [
                "tar",
                "-czf",
                str(archive),
                "-C",
                str(root),
                "state",
                "gcloud",
                "runtime.env",
                "release.env",
                "compose.yaml",
                "openclaw.sh",
                "start-gateway.sh",
            ],
            timeout=180,
        )
        os.chmod(archive, 0o600)
        logged("verify-backup", ["tar", "-tzf", str(archive)], timeout=60)
        receipt["backup"] = str(archive)
        receipt["backupSha256"] = digest(archive)
        if not ((root / "release.env").read_bytes() == old_release):
            raise RuntimeError("Image selection changed before cutover")
        unchanged()
        atomic_replace(root / "release.env", new_release)
        if new_config != old_config:
            atomic_replace(config_path, new_config)
            protected_hashes[config_name] = hashlib.sha256(new_config).hexdigest()
        for agent_id, prompt in new_prompts.items():
            install_prompt(root, old_prompts[agent_id], prompt, agent_id)
            expected_prompts[agent_id] = prompt
        cli = compose + ["run", "--rm", "--no-deps", "--pull", "never"]
        checks = [
            (
                "node",
                [
                    "--entrypoint",
                    "node",
                    "cli",
                    "-e",
                    'if(process.version!=="v24.16.0")process.exit(1)',
                ],
            ),
            ("config", ["cli", "config", "validate", "--json"]),
            (
                "codex",
                [
                    "cli",
                    "doctor",
                    "--lint",
                    "--only",
                    "codex/managed-app-server",
                    "--json",
                ],
            ),
            (
                "gcp",
                [
                    "--entrypoint",
                    "node",
                    "cli",
                    "/opt/oncall/preflight.mjs",
                    "--config",
                    "/home/node/.openclaw/openclaw.json",
                    "--check",
                ],
            ),
        ]
        for agent_id in new_prompts:
            checks.append(("models-" + agent_id,
                           ["cli", "models", "status", "--agent", agent_id, "--json", "--check"]))
        for name, args in checks:
            logged(name, cli + args)
        unchanged()
        if not ((root / "release.env").read_bytes() == new_release):
            raise RuntimeError("Candidate selector changed before start")
        # Use the candidate runtime's agent-directory resolver and filesystem identity.
        seed = pathlib.Path(__file__).with_name("init_catalog.cjs").read_text()
        logged(
            "init-catalog",
            cli
            + [
                "--entrypoint",
                "node",
                "cli",
                "-e",
                seed + "\ninitializeOncallCatalog();",
            ],
        )
        started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        logged(
            "start-candidate",
            compose + ["up", "-d", "--no-deps", "--pull", "never", "gateway"],
        )
        receipt["readiness"] = ready(new_image, started)
        lanes = rpc("diagnostics.lanes", {}, {"lanes"})["lanes"]
        if [lane["maxConcurrent"] for lane in lanes if lane["lane"] == "main"] != [
            target
        ]:
            raise RuntimeError(
                "Live Gateway main lane does not match the Git concurrency setting"
            )
        receipt["readiness"]["maxConcurrent"] = target
        unchanged()
        receipt["readiness"]["activePromptSha256"] = verify_active(rpc, prompt_sha)
        receipt["readiness"]["agentPromptSha256"] = {
            agent_id: verify_active(rpc, sha(prompt), agent_id)
            for agent_id, prompt in new_prompts.items()
        }
        if bundle is not None:
            receipt["readiness"]["appliedConfigHash"] = verify_configuration(new_config, new_prompts)
        receipt["status"] = "running_verified"
        receipt["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save()
        print(
            json.dumps(
                {
                    "status": receipt["status"],
                    "image": new_image,
                    "activePromptSha256": receipt["readiness"]["activePromptSha256"],
                    "receipt": str(receipt_path),
                    "backup": str(archive),
                }
            ),
            flush=True,
        )
    except BaseException as error:
        receipt["status"] = "failed"
        receipt["failure"] = str(error)
        save_if_possible()
        if stop_attempted and not stopped:
            # A failed or timed-out client may still have stopped the container.
            # Reconcile the observed outcome before deciding whether recovery is needed.
            try:
                observed = inspect_container()
                stopped = (
                    observed["Image"] == old_image and not observed["State"]["Running"]
                )
                receipt["stopOutcome"] = {
                    "image": observed["Image"],
                    "running": observed["State"]["Running"],
                }
                save_if_possible()
            except (
                OSError,
                ValueError,
                RuntimeError,
                subprocess.SubprocessError,
            ) as inspection_error:
                receipt["stopReconciliationFailure"] = str(inspection_error)
                save_if_possible()
        if stopped:
            try:
                selected = (root / "release.env").read_bytes()
                if not (selected in (old_release, new_release)):
                    raise RuntimeError(
                        "Release selector changed externally; automatic rollback withheld"
                    )
                observed = inspect_container()
                if observed["Image"] not in (old_image, new_image):
                    raise RuntimeError(
                        "Unexpected Gateway image; reconcile before rollback"
                    )
                if observed["State"]["Running"]:
                    subprocess.run(
                        compose + ["stop", "--timeout", "60", "gateway"],
                        timeout=120,
                        check=True,
                    )
                if inspect_container()["State"]["Running"]:
                    raise RuntimeError(
                        "Gateway still running; reconcile before rollback"
                    )
                current_config = config_path.read_bytes()
                current_prompts = {agent_id: read_prompt(root, agent_id) for agent_id in new_prompts}
                if current_config not in (
                    old_config,
                    new_config,
                ) or any(current_prompts[agent_id] not in (old_prompts[agent_id], new_prompts[agent_id])
                         for agent_id in new_prompts):
                    raise RuntimeError(
                        "VM configuration or prompt changed externally; reconcile before rollback"
                    )
                if (root / "release.env").read_bytes() != selected:
                    raise RuntimeError("Release selector changed during rollback")
                for agent_id, current in current_prompts.items():
                    if current != old_prompts[agent_id]:
                        install_prompt(root, current, old_prompts[agent_id], agent_id)
                if current_config != old_config:
                    atomic_replace(config_path, old_config)
                if selected != old_release:
                    atomic_replace(root / "release.env", old_release)
                if (
                    any(read_prompt(root, agent_id) != prompt for agent_id, prompt in old_prompts.items())
                    or config_path.read_bytes() != old_config
                    or (root / "release.env").read_bytes() != old_release
                ):
                    raise RuntimeError("Previous deployment could not be restored")
                rollback_started = datetime.datetime.now(
                    datetime.timezone.utc
                ).isoformat()
                subprocess.run(
                    compose + ["up", "-d", "--no-deps", "--pull", "never", "gateway"],
                    timeout=180,
                    check=True,
                )
                receipt["rollback"] = ready(old_image, rollback_started)
                receipt["rollback"]["activePromptSha256"] = verify_active(
                    rpc, before_sha
                )
                receipt["rollback"]["agentPromptSha256"] = {
                    agent_id: verify_active(rpc, expected, agent_id)
                    for agent_id, expected in previous_hashes.items()
                }
                if bundle is not None:
                    receipt["rollback"]["appliedConfigHash"] = verify_configuration(old_config, previous_hashes)
                receipt["status"] = "rolled_back"
                save_if_possible()
            except (
                OSError,
                ValueError,
                RuntimeError,
                subprocess.SubprocessError,
            ) as rollback_error:
                receipt["rollbackFailure"] = str(rollback_error)
                save_if_possible()
        receipt["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save_if_possible()
        print(
            json.dumps(
                {
                    "status": receipt["status"],
                    "receipt": str(receipt_path),
                    "error": str(error),
                }
            ),
            flush=True,
        )
        raise


if __name__ == "__main__":
    if os.geteuid() != 0:
        sys.exit("Run as root")
    os.umask(0o077)
    activate(pathlib.Path("/opt/livex-openclaw"), *release_arguments(sys.argv[1:]))

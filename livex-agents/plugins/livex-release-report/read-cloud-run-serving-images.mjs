import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import registry from "./services.json" with { type: "json" };

const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const registryHost = registry.region + "-docker.pkg.dev";
const commandTimeoutMs = 15_000;
const maxResponseBytes = 512 * 1024;
const concurrency = 4;
const execFileAsync = promisify(execFile);
const manifestTypes = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

function selections(values, selected) {
  if (selected === undefined) {
    return Object.keys(values);
  }
  if (!Object.hasOwn(values, selected)) {
    throw new RangeError("Unknown service or environment");
  }
  return [selected];
}

function targets({ service, environment }) {
  return selections(registry.services, service).flatMap((id) => {
    const entry = registry.services[id];
    return selections(registry.environments, environment).map((env) => {
      const project = registry.environments[env];
      const cloudRunService =
        env === "dev" && entry.devCloudRun ? entry.devCloudRun : entry.cloudRun;
      return {
        service: id,
        repo: entry.repo,
        environment: env,
        project,
        region: registry.region,
        cloudRunService,
        gkePending: env === "prd" && entry.gkeProduction === true,
        imagePrefix:
          registryHost + "/" + project + "/copilot/" + (entry.artifact ?? entry.cloudRun),
      };
    });
  });
}

function servingRevision(response, service) {
  const traffic = response?.status?.traffic;
  if (!Array.isArray(traffic) || traffic.length === 0) {
    return { reason: "no-serving-traffic" };
  }
  if (
    traffic.some(
      (entry) =>
        !entry ||
        (entry.percent !== undefined &&
          (!Number.isInteger(entry.percent) || entry.percent < 0 || entry.percent > 100)),
    )
  ) {
    return { reason: "invalid-traffic" };
  }
  // Cloud Run lists tagged, zero-traffic revisions alongside the default route.
  const serving = traffic.filter((entry) => entry.percent > 0);
  if (serving.length === 0) {
    return { reason: "no-serving-traffic" };
  }
  const revision = serving[0].revisionName;
  if (
    serving.some(
      ({ revisionName }) =>
        typeof revisionName !== "string" ||
        !revisionName.startsWith(service + "-") ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(revisionName),
    )
  ) {
    return { reason: "invalid-traffic" };
  }
  if (
    serving.some(({ revisionName }) => revisionName !== revision) ||
    serving.reduce((percent, entry) => percent + entry.percent, 0) !== 100
  ) {
    return { reason: "split-traffic" };
  }
  return { revision };
}

async function collectTarget(target, readers) {
  const { gkePending, imagePrefix, ...path } = target;
  if (gkePending) {
    return { path: { ...path, status: "gke-pending", reason: "production-route-served-by-gke" } };
  }
  const unresolved = (reason) => ({ path: { ...path, status: "unresolved", reason } });
  let first;
  try {
    first = servingRevision(await readers.readService(target), path.cloudRunService);
  } catch {
    return unresolved("service-unavailable");
  }
  if (!first.revision) {
    return unresolved(first.reason);
  }

  let image;
  try {
    const response = await readers.readRevision(target, first.revision);
    if (response?.metadata?.name !== first.revision) {
      return unresolved("unexpected-revision");
    }
    image = response?.status?.imageDigest;
  } catch {
    return unresolved("revision-unavailable");
  }

  const prefix = imagePrefix + "@";
  if (typeof image !== "string" || !image.startsWith(prefix)) {
    return unresolved("unexpected-image");
  }
  const digest = image.slice(prefix.length);
  if (!digestPattern.test(digest)) {
    return unresolved("unexpected-image");
  }

  let commit;
  let commitReason = "image-commit-missing";
  try {
    commit = await readers.readImageCommit(target, digest);
  } catch {
    commitReason = "artifact-unavailable";
  }

  return {
    path,
    evidence: {
      revision: first.revision,
      digest,
      ...(typeof commit === "string" && shaPattern.test(commit)
        ? { commit, commitSource: "artifact-registry-config" }
        : { commit: null, commitReason }),
    },
  };
}

async function recheckTarget({ path, evidence }, readers) {
  if (!evidence) {
    return path;
  }
  const unresolved = (reason) => ({
    ...path,
    status: "unresolved",
    reason,
    observedAt: new Date().toISOString(),
  });
  let second;
  try {
    second = servingRevision(await readers.readService(path), path.cloudRunService);
  } catch {
    return unresolved("traffic-recheck-unavailable");
  }
  if (second.revision !== evidence.revision) {
    return unresolved("traffic-changed");
  }
  return { ...path, ...evidence, status: "verified", observedAt: new Date().toISOString() };
}

async function readInBatches(items, read) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    results.push(...(await Promise.all(items.slice(offset, offset + concurrency).map(read))));
  }
  return results;
}

export async function collectCloudRunServingImages(
  options = {},
  readers = createCloudRunReaders(),
) {
  const selected = targets(options);
  const captureStartedAt = new Date().toISOString();
  const candidates = await readInBatches(selected, async (target) => {
    const candidate = await collectTarget(target, readers);
    candidate.path.observedAt = new Date().toISOString();
    return candidate;
  });
  // The final fleet pass starts after initial evidence for every path has been read.
  const paths = await readInBatches(candidates, (candidate) => recheckTarget(candidate, readers));
  return { captureStartedAt, capturedAt: new Date().toISOString(), paths };
}

async function gcloud(args) {
  const { stdout } = await execFileAsync("gcloud", [...args, "--quiet"], {
    encoding: "utf8",
    maxBuffer: maxResponseBytes,
    timeout: commandTimeoutMs,
  });
  return stdout;
}

async function readDocument(response, expectedDigest) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Registry response unavailable");
  }
  const stream = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await stream.cancel();
        throw new Error("Registry response too large");
      }
      chunks.push(value);
    }
  } finally {
    stream.releaseLock();
  }
  const body = Buffer.concat(chunks, bytes);
  if ("sha256:" + createHash("sha256").update(body).digest("hex") !== expectedDigest) {
    throw new Error("Registry digest mismatch");
  }
  return JSON.parse(body.toString("utf8"));
}

function configCommit(document) {
  const env = Array.isArray(document?.config?.Env) ? document.config.Env : [];
  const values = [document?.config?.Labels?.["org.opencontainers.image.revision"]];
  for (const item of env) {
    if (typeof item === "string") {
      const match = /^(?:COMMIT_ID|COMMIT_SHA|GIT_SHA)=([a-f0-9]{40})$/.exec(item);
      if (match) {
        values.push(match[1]);
      }
    }
  }
  const shas = [
    ...new Set(values.filter((value) => typeof value === "string" && shaPattern.test(value))),
  ];
  return shas.length === 1 ? shas[0] : null;
}

// Each reader instance uses the active gcloud credential for one capture.
export function createCloudRunReaders({ runGcloud = gcloud, fetchRegistry = fetch } = {}) {
  let accessToken;
  async function registryDocument(target, kind, digest) {
    const path = target.imagePrefix.slice(registryHost.length + 1);
    if (
      !digestPattern.test(digest) ||
      !target.imagePrefix.startsWith(registryHost + "/") ||
      !/^[-a-z0-9]+\/copilot\/[-a-z0-9]+$/.test(path)
    ) {
      throw new Error("Invalid registry request");
    }
    accessToken ??= runGcloud(["auth", "print-access-token"]).then((value) => value.trim());
    const token = await accessToken;
    if (!token || /\s/.test(token)) {
      throw new Error("Registry credential unavailable");
    }
    const origin = "https://" + registryHost;
    const url = origin + "/v2/" + path + "/" + kind + "/" + digest;
    const signal = AbortSignal.timeout(commandTimeoutMs);
    const isBlob = kind === "blobs";
    const response = await fetchRegistry(url, {
      headers: { Authorization: "Bearer " + token, Accept: manifestTypes },
      redirect: isBlob ? "manual" : "error",
      signal,
    });
    if (isBlob && response.status === 302) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      // Large Artifact Registry blobs use a bearer-free, same-project download path.
      const prefix =
        "/artifacts-downloads/namespaces/" + target.project + "/repositories/copilot/downloads/";
      if (
        !location?.startsWith(prefix) ||
        !/^[A-Za-z0-9_-]+$/.test(location.slice(prefix.length))
      ) {
        throw new Error("Invalid registry download");
      }
      const download = await fetchRegistry(origin + location, { redirect: "error", signal });
      return readDocument(download, digest);
    }
    return readDocument(response, digest);
  }

  return {
    async readService({ cloudRunService, project, region }) {
      return JSON.parse(
        await runGcloud([
          "run",
          "services",
          "describe",
          cloudRunService,
          "--project",
          project,
          "--region",
          region,
          "--format=json(status.traffic)",
        ]),
      );
    },
    async readRevision({ project, region }, revision) {
      return JSON.parse(
        await runGcloud([
          "run",
          "revisions",
          "describe",
          revision,
          "--project",
          project,
          "--region",
          region,
          "--format=json(metadata.name,status.imageDigest)",
        ]),
      );
    },
    async readImageCommit(target, digest) {
      let manifest = await registryDocument(target, "manifests", digest);
      if (Array.isArray(manifest?.manifests)) {
        const runnable = manifest.manifests.filter(
          ({ platform } = {}) => platform?.os === "linux" && platform?.architecture === "amd64",
        );
        if (runnable.length !== 1) {
          return null;
        }
        manifest = await registryDocument(target, "manifests", runnable[0].digest);
      }
      return configCommit(await registryDocument(target, "blobs", manifest?.config?.digest));
    },
  };
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import registry from "./services.json" with { type: "json" };

const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const registryHost = registry.region + "-docker.pkg.dev";
const commandTimeoutMs = 15_000;
const maxResponseBytes = 512 * 1024;
const maxVersionBytes = 512;
const versionTimeoutMs = 4_000;
const versionServices = new Set(["frontend", "gateway"]);
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

class ImageCommitConflict extends Error {}

function versionOrigin(target, url, projectNumber) {
  if (
    !versionServices.has(target.service) ||
    target.cloudRunService !== registry.services[target.service].cloudRun ||
    target.region !== registry.region ||
    typeof url !== "string"
  ) {
    return null;
  }
  const prefix = "https://" + target.cloudRunService + "-";
  if (
    typeof projectNumber === "string" &&
    /^[1-9][0-9]{0,19}$/.test(projectNumber) &&
    url === prefix + projectNumber + "." + target.region + ".run.app"
  ) {
    return url;
  }
  const suffix = "-uc.a.run.app";
  const label = url.slice(prefix.length, -suffix.length);
  return url.startsWith(prefix) && url.endsWith(suffix) && /^[a-z0-9]{1,40}$/.test(label)
    ? url
    : null;
}

function versionBinding(response, target) {
  const generation = response?.metadata?.generation;
  const projectNumber = response?.metadata?.namespace;
  const origin = versionOrigin(target, response?.status?.url, projectNumber);
  const conditions = response?.status?.conditions;
  const ready = Array.isArray(conditions)
    ? conditions.filter((condition) => condition?.type === "Ready")
    : [];
  return origin &&
    ready.length === 1 &&
    ready[0].status === "True" &&
    response.metadata?.name === target.cloudRunService &&
    Number.isSafeInteger(generation) &&
    generation > 0 &&
    response.status.observedGeneration === generation
    ? { origin, generation, projectNumber }
    : null;
}

async function collectTarget(target, readers) {
  const { gkePending, imagePrefix, ...path } = target;
  if (gkePending) {
    return { path: { ...path, status: "gke-pending", reason: "production-route-served-by-gke" } };
  }
  const unresolved = (reason) => ({ path: { ...path, status: "unresolved", reason } });
  let initial;
  try {
    initial = await readers.readService(target);
  } catch {
    return unresolved("service-unavailable");
  }
  const first = servingRevision(initial, path.cloudRunService);
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
  let binding;
  try {
    commit = await readers.readImageCommit(target, digest);
  } catch (error) {
    commitReason =
      error instanceof ImageCommitConflict ? "image-commit-conflict" : "artifact-unavailable";
  }
  if (
    commit === null &&
    versionServices.has(target.service) &&
    typeof readers.readVersion === "function"
  ) {
    const initialBinding = versionBinding(initial, target);
    if (initialBinding) {
      commitReason = "cloud-run-version-unavailable";
      try {
        const version = await readers.readVersion(target, initialBinding);
        if (typeof version === "string" && shaPattern.test(version)) {
          commit = version;
          binding = initialBinding;
        }
      } catch {
        // Digest evidence remains usable when the serving version cannot be read.
      }
    } else {
      commitReason = "cloud-run-version-unverified";
    }
  }

  return {
    path,
    binding,
    evidence: {
      revision: first.revision,
      digest,
      ...(typeof commit === "string" && shaPattern.test(commit)
        ? { commit, commitSource: binding ? "cloud-run-version" : "artifact-registry-config" }
        : { commit: null, commitReason }),
    },
  };
}

async function recheckTarget({ path, binding, evidence }, readers) {
  if (!evidence) {
    return path;
  }
  const unresolved = (reason) => ({
    ...path,
    status: "unresolved",
    reason,
    observedAt: new Date().toISOString(),
  });
  let terminal;
  try {
    terminal = await readers.readService(path);
  } catch {
    return unresolved("traffic-recheck-unavailable");
  }
  const second = servingRevision(terminal, path.cloudRunService);
  if (second.revision !== evidence.revision) {
    return unresolved("traffic-changed");
  }
  const observedAt = new Date().toISOString();
  if (binding) {
    const latest = versionBinding(terminal, path);
    if (
      latest?.origin !== binding.origin ||
      latest.generation !== binding.generation ||
      latest.projectNumber !== binding.projectNumber
    ) {
      return {
        ...path,
        status: "verified",
        observedAt,
        revision: evidence.revision,
        digest: evidence.digest,
        commit: null,
        commitReason: "cloud-run-version-unstable",
      };
    }
  }
  return { ...path, ...evidence, status: "verified", observedAt };
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

async function readResponseBytes(response, limit) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Response unavailable");
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
      if (bytes > limit) {
        await stream.cancel();
        throw new Error("Response too large");
      }
      chunks.push(value);
    }
  } finally {
    stream.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

async function readDocument(response, expectedDigest) {
  const body = await readResponseBytes(response, maxResponseBytes);
  if ("sha256:" + createHash("sha256").update(body).digest("hex") !== expectedDigest) {
    throw new Error("Registry digest mismatch");
  }
  return JSON.parse(body.toString("utf8"));
}

function configCommit(document) {
  const config = document?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Image config unavailable");
  }
  const env = config.Env ?? [];
  const labels = config.Labels ?? {};
  if (!Array.isArray(env) || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error("Image config unavailable");
  }
  const values = [labels["org.opencontainers.image.revision"]];
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
  if (shas.length > 1) {
    throw new ImageCommitConflict("Conflicting image commit metadata");
  }
  return shas[0] ?? null;
}

// Each reader instance uses the active gcloud credential for one capture.
export function createCloudRunReaders({
  runGcloud = gcloud,
  fetchRegistry = fetch,
  fetchVersion = fetch,
} = {}) {
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
          "--format=json(metadata.name,metadata.namespace,metadata.generation,status.traffic,status.url,status.observedGeneration,status.conditions)",
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
    async readVersion(target, { origin: url, projectNumber }) {
      const origin = versionOrigin(target, url, projectNumber);
      if (!origin) {
        throw new Error("Version origin unavailable");
      }
      const response = await fetchVersion(origin + "/version", {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(versionTimeoutMs),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error("Version response unavailable");
      }
      const text = (await readResponseBytes(response, maxVersionBytes)).toString("utf8").trim();
      const commit = target.service === "frontend" ? text : JSON.parse(text)?.version;
      if (typeof commit !== "string" || !shaPattern.test(commit)) {
        throw new Error("Version response unavailable");
      }
      return commit;
    },
    async readImageCommit(target, digest) {
      let manifest = await registryDocument(target, "manifests", digest);
      if (Array.isArray(manifest?.manifests)) {
        const runnable = manifest.manifests.filter(
          ({ platform } = {}) => platform?.os === "linux" && platform?.architecture === "amd64",
        );
        if (runnable.length !== 1) {
          throw new Error("Image platform unavailable");
        }
        manifest = await registryDocument(target, "manifests", runnable[0].digest);
      }
      return configCommit(await registryDocument(target, "blobs", manifest?.config?.digest));
    },
  };
}

import { isCaptureTimestamp, isGkeObservation } from "../../capture.mjs";
import registry from "../../services.json" with { type: "json" };

const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const serviceIds = Object.keys(registry.services);
const versionServices = new Set(["frontend", "gateway"]);
const servingVersionSource = "cloud-run-version";
const comparisons = [
  { base: "prd", head: "stg" },
  { base: "stg", head: "dev" },
];
const captureReasons = new Set([
  "artifact-unavailable",
  "cloud-run-version-unavailable",
  "cloud-run-version-unverified",
  "cloud-run-version-unstable",
  "gke-read-unavailable",
  "gke-route-unverified",
  "gke-workload-unverified",
  "gke-mixed-images",
  "gke-evidence-changed",
  "image-commit-conflict",
  "image-commit-missing",
  "invalid-traffic",
  "no-serving-traffic",
  "revision-unavailable",
  "service-unavailable",
  "split-traffic",
  "traffic-changed",
  "traffic-recheck-unavailable",
  "unexpected-image",
  "unexpected-revision",
]);
const githubReasons = new Set(["github-credential-unavailable", "github-compare-incomplete"]);

function indexCapture(capture) {
  if (
    !isCaptureTimestamp(capture?.captureStartedAt) ||
    !isCaptureTimestamp(capture?.capturedAt) ||
    capture.captureStartedAt > capture.capturedAt ||
    !Array.isArray(capture.paths) ||
    capture.paths.length > serviceIds.length * Object.keys(registry.environments).length
  ) {
    throw new Error("Invalid Cloud Run capture");
  }
  const paths = new Map();
  for (const row of capture.paths) {
    if (
      typeof row?.service !== "string" ||
      typeof row.environment !== "string" ||
      !Object.hasOwn(registry.services, row.service) ||
      !Object.hasOwn(registry.environments, row.environment) ||
      row.repo !== registry.services[row.service].repo ||
      row.project !== registry.environments[row.environment] ||
      row.region !== registry.region ||
      !["verified", "unresolved", "gke-pending"].includes(row.status)
    ) {
      throw new Error("Invalid Cloud Run capture path");
    }
    const binding = registry.services[row.service];
    const expectedCloudRun =
      row.environment === "dev" ? (binding.devCloudRun ?? binding.cloudRun) : binding.cloudRun;
    const expectsGke = row.environment === "prd" && binding.gkeProduction === true;
    const gke = isGkeObservation(row);
    const validSource =
      row.source === "gke"
        ? expectsGke && gke
        : row.source === undefined &&
          row.workloads === undefined &&
          (row.status === "gke-pending") === expectsGke;
    if (row.cloudRunService !== expectedCloudRun || !validSource) {
      throw new Error("Invalid Cloud Run capture route");
    }
    if (
      (row.status === "verified" || gke) &&
      (!isCaptureTimestamp(row.observedAt) ||
        row.observedAt < capture.captureStartedAt ||
        row.observedAt > capture.capturedAt)
    ) {
      throw new Error("Invalid Cloud Run capture observation time");
    }
    const servingVersion = row.commitSource === servingVersionSource;
    if (
      servingVersion &&
      (row.status !== "verified" ||
        row.source !== undefined ||
        !versionServices.has(row.service) ||
        row.commit == null)
    ) {
      throw new Error("Invalid Cloud Run capture evidence");
    }
    if (
      row.status === "verified" &&
      (typeof row.digest !== "string" ||
        !digestPattern.test(row.digest) ||
        (row.commit != null &&
          (typeof row.commit !== "string" ||
            !shaPattern.test(row.commit) ||
            (row.commitSource !== "artifact-registry-config" && !servingVersion))))
    ) {
      throw new Error("Invalid Cloud Run capture evidence");
    }
    const key = row.service + "/" + row.environment;
    if (paths.has(key)) {
      throw new Error("Invalid Cloud Run capture duplicate");
    }
    paths.set(key, row);
  }
  return paths;
}

function captureGap(row, environment) {
  if (!row) {
    return { environment, kind: "missing" };
  }
  if (row.status === "gke-pending") {
    return { environment, kind: "gke-pending" };
  }
  if (row.status === "unresolved") {
    return {
      environment,
      kind: "unresolved",
      source: row.source === "gke" ? "gke" : "cloud-run",
      reason: captureReasons.has(row.reason) ? row.reason : null,
    };
  }
  return null;
}

async function comparePath(paths, service, { base, head }, compare) {
  const before = paths.get(service + "/" + base);
  const after = paths.get(service + "/" + head);
  const gaps = [captureGap(before, base), captureGap(after, head)].filter(Boolean);
  if (gaps.length > 0) {
    return { service, gap: { kind: "capture", paths: gaps } };
  }
  if (before.digest === after.digest) {
    if (
      (before.commitSource === servingVersionSource ||
        after.commitSource === servingVersionSource) &&
      before.commit &&
      after.commit &&
      before.commit !== after.commit
    ) {
      return { service, gap: { kind: "commit-conflict" } };
    }
    return { service, note: "same-image" };
  }
  if (!before.commit || !after.commit) {
    const missing = [before, after]
      .filter((row) => !row.commit)
      .map((row) => ({
        environment: row.environment,
        reason: captureReasons.has(row.commitReason) ? row.commitReason : null,
      }));
    return { service, gap: { kind: "missing-commit", paths: missing } };
  }
  if (before.commit === after.commit) {
    return { service, note: "same-commit" };
  }

  const { repo, commit: baseCommit } = before;
  const headCommit = after.commit;
  let result;
  try {
    result = await compare({ repo, base: baseCommit, head: headCommit });
  } catch {
    return { service, gap: { kind: "github", reason: null } };
  }
  if (result.status !== "verified") {
    return {
      service,
      gap: { kind: "github", reason: githubReasons.has(result.reason) ? result.reason : null },
    };
  }
  return {
    service,
    repo,
    range: { base: baseCommit, head: headCommit },
    commits: (result.commits ?? []).map(({ sha, subject, pullRequests }) => ({
      sha,
      subject,
      pullRequests: pullRequests.map(({ number, title }) => ({ number, title })),
    })),
    ahead: result.ahead,
    behind: result.behind,
    linkStatus: result.linkStatus === "partial" ? "partial" : "complete",
  };
}

export async function prepareReleaseEvidence(capture, compare) {
  const paths = indexCapture(capture);
  const views = [];
  for (const comparison of comparisons) {
    const results = [];
    for (const service of serviceIds) {
      results.push(await comparePath(paths, service, comparison, compare));
    }
    views.push({ ...comparison, results });
  }

  const observations = [...paths.values()]
    .filter((row) => row.status === "verified")
    .map(({ service, environment, source, observedAt, commit, commitSource }) => ({
      service,
      environment,
      source: source === "gke" ? "gke" : "cloud-run",
      observedAt,
      commitSource: commit == null ? null : commitSource,
    }));
  return {
    captureStartedAt: capture.captureStartedAt,
    capturedAt: capture.capturedAt,
    observations,
    comparisons: views,
  };
}

export async function runReleaseChanges({ capture, compare } = {}) {
  if (typeof capture !== "function" || typeof compare !== "function") {
    throw new TypeError("Release workflow requires capture and compare functions");
  }
  return prepareReleaseEvidence(await capture(), compare);
}

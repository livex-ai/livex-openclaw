import { parseArgs } from "node:util";
import { collectCloudRunServingImages } from "./read-cloud-run-serving-images.mjs";
import registry from "./services.json" with { type: "json" };

const usage = "Usage: node capture.mjs [--service <id>] [--environment dev|stg|prd]";

export function isCaptureTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function isGkeObservation(row) {
  const expected = registry.gke?.workloads?.[row?.service];
  return (
    row?.source === "gke" &&
    ["verified", "unresolved"].includes(row.status) &&
    Array.isArray(expected) &&
    Array.isArray(row.workloads) &&
    row.workloads.length === expected.length &&
    expected.every(({ name }) => row.workloads.includes(name))
  );
}

function mergeGkeEvidence(cloudRun, gke) {
  if (
    !isCaptureTimestamp(gke?.captureStartedAt) ||
    !isCaptureTimestamp(gke?.capturedAt) ||
    gke.captureStartedAt > gke.capturedAt ||
    gke.capturedAt < cloudRun.captureStartedAt ||
    cloudRun.capturedAt < gke.captureStartedAt ||
    !Array.isArray(gke.paths)
  ) {
    return cloudRun;
  }

  let merged = false;
  const paths = cloudRun.paths.map((path) => {
    if (path.status !== "gke-pending") {
      return path;
    }
    const matches = gke.paths.filter(
      (row) => row?.service === path.service && row.environment === path.environment,
    );
    const [row] = matches;
    if (
      matches.length !== 1 ||
      !isGkeObservation(row) ||
      row.repo !== path.repo ||
      row.project !== path.project ||
      row.region !== path.region ||
      row.cloudRunService !== path.cloudRunService ||
      !isCaptureTimestamp(row.observedAt) ||
      row.observedAt < gke.captureStartedAt ||
      row.observedAt > gke.capturedAt
    ) {
      return path;
    }
    merged = true;
    return row;
  });
  if (!merged) {
    return cloudRun;
  }
  return {
    captureStartedAt:
      cloudRun.captureStartedAt < gke.captureStartedAt
        ? cloudRun.captureStartedAt
        : gke.captureStartedAt,
    capturedAt: cloudRun.capturedAt > gke.capturedAt ? cloudRun.capturedAt : gke.capturedAt,
    paths,
  };
}

function includesProductionGke({ service, environment }) {
  return (
    (environment === undefined || environment === "prd") &&
    (service === undefined ||
      (Object.hasOwn(registry.services, service) &&
        registry.services[service].gkeProduction === true))
  );
}

async function loadProductionGke() {
  try {
    const { collectGkeServingImages } = await import("./read-gke-serving-images.mjs");
    return collectGkeServingImages;
  } catch {
    return null;
  }
}

async function readGke(selection, collectGke) {
  try {
    return await collectGke(selection);
  } catch {
    return null;
  }
}

export async function captureReleaseEvidence(
  selection = {},
  { collectGke } = {},
  readers = undefined,
) {
  // Injected Cloud Run readers keep captures synthetic unless GKE is also injected.
  const gkeCollector = includesProductionGke(selection)
    ? (collectGke ?? (readers === undefined ? await loadProductionGke() : null))
    : null;
  // Start both sources before waiting. Production-only GKE canaries have no Cloud Run reads.
  const gkeCapture = gkeCollector ? readGke(selection, gkeCollector) : null;
  const [cloudRun, gke] = await Promise.all([
    collectCloudRunServingImages(selection, readers),
    gkeCapture,
  ]);
  return mergeGkeEvidence(cloudRun, gke);
}

export async function runCapture(
  args,
  { output = console.log, error = console.error, collectGke } = {},
  readers = undefined,
) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        service: { type: "string" },
        environment: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      output(usage);
      return 0;
    }
    const result = await captureReleaseEvidence(values, { collectGke }, readers);
    output(JSON.stringify(result, null, 2));
    return 0;
  } catch (cause) {
    if (cause instanceof RangeError || cause?.code?.startsWith("ERR_PARSE_ARGS_")) {
      error("Invalid capture options. " + usage);
      return 2;
    }
    error("Cloud Run capture failed.");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCapture(process.argv.slice(2));
}

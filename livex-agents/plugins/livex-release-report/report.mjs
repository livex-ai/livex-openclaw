import { isCaptureTimestamp, isGkeObservation } from "./capture.mjs";
import { createGitHubComparator } from "./compare-deployed-commits.mjs";
import registry from "./services.json" with { type: "json" };

const maxCaptureBytes = 64 * 1_024;
const maxDisplayedChanges = 20;
// Match Slack's recommended message length in extensions/slack/src/limits.ts.
const maxSlackChars = 4_000;
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const environmentNames = { dev: "Dev", stg: "STG", prd: "US production" };
const serviceIds = Object.keys(registry.services);
const versionServices = ["frontend", "gateway"];
const servingVersionSource = "cloud-run-version";
const comparisons = [
  { base: "prd", head: "stg", label: "STG vs US production", title: "STG changes" },
  { base: "stg", head: "dev", label: "Dev vs STG", title: "Dev-only changes (vs STG)" },
];
const captureReasons = {
  "artifact-unavailable": "Artifact Registry metadata unavailable",
  "cloud-run-version-unavailable": "serving /version unavailable",
  "cloud-run-version-unverified": "serving /version evidence unverified",
  "cloud-run-version-unstable": "serving /version evidence changed",
  "gke-read-unavailable": "GKE read unavailable",
  "gke-route-unverified": "GKE route unverified",
  "gke-workload-unverified": "GKE workload unverified",
  "gke-mixed-images": "GKE mixed serving images",
  "gke-evidence-changed": "GKE evidence changed during capture",
  "image-commit-conflict": "image commit metadata conflicts",
  "image-commit-missing": "image has no exact commit metadata",
  "invalid-traffic": "invalid serving traffic",
  "no-serving-traffic": "serving traffic unavailable",
  "revision-unavailable": "serving revision unavailable",
  "service-unavailable": "service evidence unavailable",
  "split-traffic": "traffic split or incomplete",
  "traffic-changed": "traffic changed during capture",
  "traffic-recheck-unavailable": "traffic recheck unavailable",
  "unexpected-image": "unexpected serving image",
  "unexpected-revision": "unexpected serving revision",
};
const githubReasons = {
  "github-credential-unavailable": "GitHub credential unavailable",
  "github-compare-incomplete": "GitHub comparison incomplete",
};

function lookupReason(reasons, code, fallback) {
  return typeof code === "string" && Object.hasOwn(reasons, code) ? reasons[code] : fallback;
}

function indexCapture(capture) {
  if (
    !isCaptureTimestamp(capture?.captureStartedAt) ||
    !isCaptureTimestamp(capture?.capturedAt) ||
    capture.captureStartedAt > capture.capturedAt ||
    !Array.isArray(capture.paths) ||
    capture.paths.length > serviceIds.length * Object.keys(environmentNames).length
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
        !versionServices.includes(row.service) ||
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

function describeGap(row) {
  if (!row) {
    return "capture missing";
  }
  if (row.status === "gke-pending") {
    return "GKE evidence pending";
  }
  if (row.status === "unresolved") {
    const fallback =
      row.source === "gke" ? "GKE serving evidence unresolved" : "serving evidence unresolved";
    return lookupReason(captureReasons, row.reason, fallback);
  }
  return null;
}

function githubLink(repo, path, label) {
  return "<https://github.com/livex-ai/" + repo + "/" + path + "|" + label + ">";
}

async function comparePath(paths, service, { base, head }, compare) {
  const before = paths.get(service + "/" + base);
  const after = paths.get(service + "/" + head);
  const gaps = [
    [base, describeGap(before)],
    [head, describeGap(after)],
  ]
    .filter(([, reason]) => reason)
    .map(([env, reason]) => environmentNames[env] + ": " + reason);
  if (gaps.length > 0) {
    return { service, gap: gaps.join(", ") };
  }
  if (before.digest === after.digest) {
    if (
      (before.commitSource === servingVersionSource ||
        after.commitSource === servingVersionSource) &&
      before.commit &&
      after.commit &&
      before.commit !== after.commit
    ) {
      return { service, gap: "same image digest but conflicting commit SHAs" };
    }
    return { service, note: "same image digest" };
  }
  if (!before.commit || !after.commit) {
    const missing = [before, after]
      .filter((row) => !row.commit)
      .map((row) => {
        const reason = lookupReason(captureReasons, row.commitReason, "no commit evidence");
        return environmentNames[row.environment] + " (" + reason + ")";
      });
    return { service, gap: "exact commit SHA unavailable for " + missing.join(", ") };
  }
  if (before.commit === after.commit) {
    return { service, note: "different image digests, same commit" };
  }

  const request = { repo: before.repo, base: before.commit, head: after.commit };
  let result;
  try {
    result = await compare(request);
  } catch {
    return { service, gap: "GitHub comparison unavailable" };
  }
  if (result.status !== "verified") {
    return {
      service,
      gap: lookupReason(githubReasons, result.reason, "GitHub comparison unavailable"),
    };
  }
  const range = githubLink(
    request.repo,
    "compare/" + request.base + "..." + request.head,
    "SHA range",
  );
  const { commits, ahead, behind, linkStatus } = result;
  return { service, repo: request.repo, range, commits, ahead, behind, linkStatus };
}

// Slack interprets angle brackets as links or mentions and these glyphs as markup.
const slackEscapes = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "*": "∗",
  _: "＿",
  "~": "∼",
  "`": "ˋ",
  "@": "＠",
  "#": "＃",
};

function slackText(value) {
  let escaped = "";
  const clean = value
    .slice(0, 300)
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
  for (const char of clean) {
    const token = slackEscapes[char] ?? char;
    if (escaped.length + token.length > 160) {
      return escaped.trimEnd() + "…";
    }
    escaped += token;
  }
  return escaped || "Untitled change";
}

function changeLines(results) {
  const linkedCommits = new Set();
  const displayed = new Map();
  for (const result of results) {
    for (const commit of result.commits ?? []) {
      const id = result.repo + "/" + commit.sha;
      if (commit.pullRequests.length === 0 && !linkedCommits.has(id)) {
        const short = commit.sha.slice(0, 8);
        displayed.set(
          id,
          slackText(commit.subject) +
            " · " +
            githubLink(result.repo, "commit/" + commit.sha, short) +
            " · PR not linked",
        );
      }
      for (const pr of commit.pullRequests) {
        linkedCommits.add(id);
        displayed.delete(id);
        const key = result.repo + "/pull/" + pr.number;
        displayed.set(
          key,
          slackText(pr.title) +
            " · " +
            githubLink(result.repo, "pull/" + pr.number, "#" + pr.number),
        );
      }
    }
  }
  const bullets = [...displayed.values()].slice(0, maxDisplayedChanges).map((line) => "• " + line);
  return { count: displayed.size, bullets };
}

function renderChanges({ count, bullets }, budget) {
  if (count === 0) {
    return "No changes verified for covered paths.";
  }
  const omitted = (total) => "• " + total + " more changes omitted. See SHA ranges.";
  const lines = [];
  let used = 0;
  for (const bullet of bullets) {
    const withBullet = used + (lines.length > 0 ? 1 : 0) + bullet.length;
    const remaining = count - lines.length - 1;
    const reserved = remaining > 0 ? omitted(remaining).length + 1 : 0;
    if (withBullet + reserved > budget) {
      break;
    }
    lines.push(bullet);
    used = withBullet;
  }
  if (lines.length < count) {
    lines.push(omitted(count - lines.length));
  }
  return lines.join("\n");
}

function observedTimes(rows) {
  const times = rows.map(({ observedAt }) => observedAt).toSorted();
  const first = times[0];
  const last = times.at(-1);
  return first === last ? first : first + " to " + last;
}

function verifiedChangeCount(count) {
  return count + (count === 1 ? " verified change" : " verified changes");
}

async function buildComparison(paths, comparison, compare) {
  const results = [];
  for (const service of serviceIds) {
    results.push(await comparePath(paths, service, comparison, compare));
  }
  const covered = results.filter((result) => !result.gap).length;
  return { ...comparison, ...changeLines(results), covered, results };
}

export async function formatReleaseReport(capture, compare) {
  const paths = indexCapture(capture);
  const views = [];
  for (const comparison of comparisons) {
    views.push(await buildComparison(paths, comparison, compare));
  }

  const gaps = views.flatMap(({ label, results }) =>
    results.flatMap(({ service, gap, linkStatus }) => {
      const detail = gap ?? (linkStatus === "partial" ? "PR lookup incomplete" : null);
      return detail ? ["• " + label + " · " + service + " · " + detail] : [];
    }),
  );
  const [stg, dev] = views;
  const header = [
    "*Release changes · STG vs US production*",
    "*Readiness unverified* · " +
      (gaps.length > 0 ? "*Partial coverage*" : "*Full change coverage*"),
    verifiedChangeCount(stg.count) +
      " · " +
      stg.covered +
      "/" +
      serviceIds.length +
      " STG paths covered",
    "Dev vs STG · " +
      verifiedChangeCount(dev.count) +
      " · " +
      dev.covered +
      "/" +
      serviceIds.length +
      " paths covered",
  ];

  const lines = [];
  if (gaps.length > 0) {
    lines.push("*Coverage gaps*", ...gaps, "");
  }
  lines.push(
    "*Evidence*",
    "Capture window (UTC) · " + capture.captureStartedAt + " to " + capture.capturedAt,
  );
  const versionEvidence = versionServices.flatMap((service) => {
    const environments = Object.keys(environmentNames)
      .filter((env) => paths.get(service + "/" + env)?.commitSource === servingVersionSource)
      .map((env) => environmentNames[env]);
    return environments.length > 0 ? [service + " (" + environments.join(", ") + ")"] : [];
  });
  if (versionEvidence.length > 0) {
    lines.push("• Serving /version commit evidence · " + versionEvidence.join(", "));
  }
  const verifiedGke = [...paths.values()].filter(
    (row) => row.source === "gke" && row.status === "verified",
  );
  if (verifiedGke.length > 0) {
    const verifiedCloudRun = [...paths.values()].filter(
      (row) => row.source === undefined && row.status === "verified",
    );
    if (verifiedCloudRun.length > 0) {
      lines.push("• Cloud Run observed (UTC) · " + observedTimes(verifiedCloudRun));
    }
    lines.push("• GKE observed (UTC) · " + observedTimes(verifiedGke));
  }
  if (verifiedGke.some(({ service }) => service === "chat-engine")) {
    lines.push("• GKE · Chat Engine web and avatar route digests agree.");
  }
  const readyWorkers = verifiedGke
    .filter(({ service }) => service !== "chat-engine")
    .map(({ service }) => service);
  if (readyWorkers.length > 0) {
    lines.push(
      "• GKE · " + readyWorkers.join(", ") + " · ready workers verified. Job pickup unverified.",
    );
  }
  const ranges = [];
  for (const { label, results } of views) {
    const matches = results.filter(({ note }) => note === "same image digest");
    if (matches.length > 0) {
      lines.push(
        "• " +
          label +
          " · " +
          matches.map(({ service }) => service).join(", ") +
          " · same image digest",
      );
    }
    for (const { service, note, range, ahead, behind } of results) {
      if (note && note !== "same image digest") {
        lines.push("• " + label + " · " + service + " · " + note);
      }
      if (range) {
        ranges.push(
          "• " +
            label +
            " · " +
            service +
            " · " +
            range +
            " · " +
            ahead +
            " ahead, " +
            behind +
            " behind",
        );
      }
    }
  }
  const intro = header.join("\n");
  const stgHeading = "*" + stg.title + "*";
  const devHeading = "*" + dev.title + "*";
  const fixedLength = (evidence) =>
    [intro, stgHeading, devHeading, evidence].join("\n\n").length + 2;
  const minimumLength = ({ count, bullets }) =>
    renderChanges({ count, bullets: bullets.slice(0, 1) }, Infinity).length;
  const minimumStg = minimumLength(stg);
  const minimumDev = minimumLength(dev);
  const minimumChanges = minimumStg + minimumDev;
  const evidenceText = (shown) => {
    const parts = [...lines, ...ranges.slice(0, shown)];
    if (shown < ranges.length) {
      parts.push("• " + (ranges.length - shown) + " additional SHA ranges omitted.");
    }
    parts.push("Dependency readiness unverified · Jira status unavailable.");
    return parts.join("\n");
  };
  let shown = ranges.length;
  let evidence = evidenceText(shown);
  // Preserve coverage and the change counts before fitting optional range links.
  while (fixedLength(evidence) + minimumChanges > maxSlackChars && shown > 0) {
    shown -= 1;
    evidence = evidenceText(shown);
  }
  const budget = maxSlackChars - fixedLength(evidence);
  if (budget < minimumChanges) {
    throw new Error("Release evidence exceeds the Slack reply budget");
  }
  const stgBudget = Math.min(
    budget - minimumDev,
    Math.max(minimumStg, Math.floor(budget / 2), budget - renderChanges(dev, Infinity).length),
  );
  const stgChanges = renderChanges(stg, stgBudget);
  const devChanges = renderChanges(dev, budget - stgChanges.length);
  return [intro, stgHeading + "\n" + stgChanges, devHeading + "\n" + devChanges, evidence].join(
    "\n\n",
  );
}

async function readCapture(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxCaptureBytes) {
      throw new Error("Cloud Run capture exceeds input limit");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function runReport(
  input,
  { compare, output = console.log, error = console.error } = {},
) {
  try {
    const capture = await readCapture(input);
    const comparator = compare ?? createGitHubComparator();
    output(await formatReleaseReport(capture, comparator));
    return 0;
  } catch {
    error("Invalid or unreadable Cloud Run capture JSON.");
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await runReport(process.stdin);
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runCapture } from "./capture.mjs";
import { formatReleaseReport, renderReleaseReport, runReport } from "./report.mjs";
import registry from "./services.json" with { type: "json" };
import { runReleaseChanges } from "./workflows/release-changes/service.mjs";

const sha = (digit) => digit.repeat(40);
const digest = (digit) => "sha256:" + digit.repeat(64);
const captureStartedAt = "2026-11-09T18:00:00.000Z";
const capturedAt = "2026-11-09T18:01:00.000Z";

function capture(overrides = {}) {
  const paths = Object.entries(registry.services).flatMap(
    ([service, { repo, cloudRun, devCloudRun, gkeProduction }]) =>
      Object.entries(registry.environments).map(([environment, project]) => {
        const identity = {
          service,
          repo,
          environment,
          project,
          region: registry.region,
          cloudRunService: environment === "dev" && devCloudRun ? devCloudRun : cloudRun,
          observedAt: capturedAt,
        };
        const override = overrides[service + "/" + environment];
        const evidence =
          environment === "prd" && gkeProduction && override?.source !== "gke"
            ? { status: "gke-pending", reason: "production-route-served-by-gke" }
            : { status: "verified", digest: digest("a"), commit: null };
        return Object.assign(identity, evidence, override);
      }),
  );
  return { captureStartedAt, capturedAt, paths };
}

function exact(digit, commit = sha(digit)) {
  return { digest: digest(digit), commit, commitSource: "artifact-registry-config" };
}

const engineWorkloads = ["chat-engine", "chat-engine-avatar"];

function gke(workloads, overrides = {}) {
  return { source: "gke", workloads, status: "verified", digest: digest("a"), ...overrides };
}

function comparison(commits, linkStatus = "complete") {
  return { status: "verified", commits, ahead: commits.length, behind: 0, linkStatus };
}

test("formats a single Slack report with linked STG changes, separate Dev changes, and explicit GKE coverage", async () => {
  const snapshot = capture({
    "scheduler/prd": exact("b"),
    "scheduler/stg": exact("c"),
    "scheduler/dev": exact("c"),
    "chat-engine/stg": exact("d"),
    "chat-engine/dev": exact("e"),
  });
  const calls = [];
  const report = await formatReleaseReport(snapshot, async (request) => {
    calls.push(request);
    if (request.repo === "chat-engine") {
      return comparison([{ sha: sha("e"), subject: "Dev change", pullRequests: [] }]);
    }
    return comparison([
      {
        sha: sha("f"),
        subject: "Ignored commit subject",
        pullRequests: [{ number: 1, title: "Guard <!channel> *rollout*\n> fake heading & alert" }],
      },
      {
        sha: sha("c"),
        subject: "Second commit",
        pullRequests: [{ number: 2, title: "Fix export" }],
      },
    ]);
  });

  assert.deepEqual(calls, [
    { repo: "copilot-scheduler", base: sha("b"), head: sha("c") },
    { repo: "chat-engine", base: sha("d"), head: sha("e") },
  ]);
  assert.match(report, /^\*Release changes · STG vs US production\*/);
  assert.match(report, /Readiness unverified.*Partial coverage/);
  assert.match(report, /2 verified changes · 5\/8 STG paths covered/);
  assert.match(
    report,
    /\*STG changes\*[\s\S]*<https:\/\/github\.com\/livex-ai\/copilot-scheduler\/pull\/1\|#1>/,
  );
  assert.match(report, /<https:\/\/github\.com\/livex-ai\/copilot-scheduler\/pull\/2\|#2>/);
  assert.doesNotMatch(report, /<!channel>|\*rollout\*|\n> fake heading|Ignored commit subject/);
  assert.match(report, /&lt;!channel&gt;.*&amp; alert/);
  assert.match(report, /\*Dev-only changes \(vs STG\)\*[\s\S]*Dev change/);
  assert.match(report, /gateway.*same image digest/);
  assert.match(report, /\*Coverage gaps\*[\s\S]*chat-engine.*GKE evidence pending/);
  assert.match(report, /2026-11-09T18:00:00\.000Z.*2026-11-09T18:01:00\.000Z/);
});

test("separates artifact differences, unavailable SHAs, changed traffic, and unavailable GitHub", async () => {
  const snapshot = capture({
    "gateway/prd": exact("b"),
    "gateway/stg": exact("c", sha("b")),
    "gateway/dev": exact("c", sha("b")),
    "frontend/prd": { digest: digest("d") },
    "scheduler/prd": { status: "unresolved", reason: "traffic-changed" },
    "chatbox/prd": exact("e"),
    "chatbox/stg": exact("f"),
    "chatbox/dev": exact("f"),
  });
  const calls = [];
  const report = await formatReleaseReport(snapshot, async (request) => {
    calls.push(request);
    return { status: "unresolved", reason: "github-compare-unavailable" };
  });

  assert.deepEqual(calls, [{ repo: "chatbox-js", base: sha("e"), head: sha("f") }]);
  assert.match(report, /gateway.*different image digests, same commit/);
  assert.match(report, /frontend.*exact commit SHA unavailable/);
  assert.match(report, /scheduler.*traffic changed during capture/);
  assert.match(report, /chatbox.*GitHub comparison unavailable/);
  assert.match(report, /No changes verified for covered paths/);
});

test("uses exact Frontend and Gateway serving version evidence with explicit provenance", async () => {
  const version = (digit) => ({ ...exact(digit), commitSource: "cloud-run-version" });
  const snapshot = capture({
    "frontend/prd": version("b"),
    "frontend/stg": version("c"),
    "frontend/dev": exact("c"),
    "gateway/dev": version("a"),
  });
  const calls = [];
  const report = await formatReleaseReport(snapshot, async (request) => {
    calls.push(request);
    return comparison([{ sha: sha("c"), subject: "Frontend change", pullRequests: [] }]);
  });

  assert.deepEqual(calls, [{ repo: "chat-frontend", base: sha("b"), head: sha("c") }]);
  assert.match(report, /1 verified change · 5\/8 STG paths covered/);
  assert.match(
    report,
    /Serving \/version commit evidence · frontend \(STG, US production\), gateway \(Dev\)/,
  );
  assert.match(report, /gateway.*same image digest/);
});

test("flags conflicting serving SHAs for an equal image digest", async () => {
  const snapshot = capture({
    "frontend/prd": exact("a", sha("b")),
    "frontend/stg": { ...exact("a", sha("c")), commitSource: "cloud-run-version" },
    "frontend/dev": exact("a", sha("c")),
  });
  const report = await formatReleaseReport(snapshot, () => assert.fail("unexpected GitHub call"));

  assert.match(report, /4\/8 STG paths covered/);
  assert.match(
    report,
    /STG vs US production · frontend · same image digest but conflicting commit SHAs/,
  );
  assert.doesNotMatch(report, /STG vs US production · .*frontend.*same image digest$/m);
  assert.ok(report.length <= 4_000);
});

test("rejects serving version provenance outside verified eligible Cloud Run rows", async () => {
  const version = { ...exact("b"), commitSource: "cloud-run-version" };
  const snapshots = [
    capture({ "scheduler/stg": version }),
    capture({ "chat-engine/prd": gke(engineWorkloads, version) }),
    capture({ "frontend/stg": { ...version, status: "unresolved" } }),
    capture({ "gateway/stg": { ...version, commit: null } }),
    capture({ "gateway/stg": { ...version, commit: "bad" } }),
  ];
  for (const snapshot of snapshots) {
    await assert.rejects(
      formatReleaseReport(snapshot, () => assert.fail("unexpected GitHub call")),
      /Invalid Cloud Run capture evidence/,
    );
  }
});

test("qualifies a gap when the serving version evidence changes", async () => {
  const snapshot = capture({
    "frontend/prd": { digest: digest("b"), commitReason: "cloud-run-version-unstable" },
    "frontend/stg": exact("c"),
    "frontend/dev": exact("c"),
  });
  const report = await formatReleaseReport(snapshot, () => assert.fail("unexpected GitHub call"));
  assert.match(report, /frontend.*US production.*serving \/version evidence changed/);
  assert.doesNotMatch(report, /Serving \/version commit evidence/);
});

test("counts multiple commits linked to one merged PR as one reported change", async () => {
  const snapshot = capture({
    "scheduler/prd": exact("b"),
    "scheduler/stg": exact("c"),
    "scheduler/dev": exact("c"),
  });
  const pullRequests = [{ number: 1, title: "One merged change" }];
  const report = await formatReleaseReport(snapshot, async () =>
    comparison([
      { sha: sha("f"), subject: "First commit", pullRequests },
      { sha: sha("c"), subject: "Second commit", pullRequests },
    ]),
  );

  assert.match(report, /1 verified change · 5\/8 STG paths covered/);
  assert.equal([...report.matchAll(/pull\/1\|#1/g)].length, 1);
});

test("preserves verified commits when PR lookup is incomplete and explicitly limits display", async () => {
  const snapshot = capture({
    "scheduler/prd": exact("b"),
    "scheduler/stg": exact("c"),
    "scheduler/dev": exact("c"),
  });
  const commits = Array.from({ length: 25 }, (_, index) => ({
    sha: (index + 1).toString(16).padStart(40, "0"),
    subject: "Change " + (index + 1) + " " + "<>&".repeat(1_000),
    pullRequests: [],
  }));
  const report = await formatReleaseReport(snapshot, async () => comparison(commits, "partial"));

  assert.match(report, /25 verified changes/);
  assert.match(report, /PR lookup incomplete/);
  const shown = [...report.matchAll(/\/commit\//g)].length;
  assert.ok(shown > 0 && shown < 25);
  assert.match(report, new RegExp(25 - shown + " more changes omitted"));
  assert.match(report, /compare\//);
  assert.ok(report.length <= 4_000);
});

test("fits one Slack reply when both sections have long changes and preserves evidence", async () => {
  const snapshot = capture({
    "scheduler/prd": exact("b"),
    "scheduler/stg": exact("c"),
    "scheduler/dev": exact("d"),
  });
  const report = await formatReleaseReport(snapshot, async ({ head }) =>
    comparison(
      Array.from({ length: 25 }, (_, index) => ({
        sha: (index + 1).toString(16).padStart(40, "0"),
        subject: "Ignored commit subject",
        pullRequests: [
          {
            number: index + (head === sha("c") ? 1 : 101),
            title: "Long PR title " + "x".repeat(300),
          },
        ],
      })),
    ),
  );

  assert.ok(report.length <= 4_000, `Report has ${report.length} characters`);
  const [, stg, dev] = report.split(
    /\*STG changes\*|\*Dev-only changes \(vs STG\)\*|\*Coverage gaps\*/,
  );
  for (const section of [stg, dev]) {
    const shown = [...section.matchAll(/\/pull\//g)].length;
    assert.ok(shown > 0 && shown < 20);
    assert.match(section, new RegExp(25 - shown + " more changes omitted"));
  }
  assert.match(report, /\*Coverage gaps\*[\s\S]*GKE evidence pending/);
  assert.match(report, /\*Evidence\*[\s\S]*SHA range[\s\S]*Jira status unavailable/);
});

test("keeps coverage and reserves change summaries when range evidence fills the reply", async () => {
  const snapshot = capture();
  let index = 0;
  for (const path of snapshot.paths) {
    if (path.status === "verified") {
      const value = (++index).toString(16);
      path.digest = "sha256:" + value.padStart(64, "0");
      path.commit = value.padStart(40, "0");
      path.commitSource =
        path.service === "frontend" || path.service === "gateway"
          ? "cloud-run-version"
          : "artifact-registry-config";
    }
  }
  const report = await formatReleaseReport(snapshot, async ({ head }) => ({
    ...comparison([{ sha: head, subject: "Change", pullRequests: [] }], "partial"),
    behind: Number.MAX_SAFE_INTEGER,
  }));
  assert.ok(report.length <= 4_000, `Report has ${report.length} characters`);
  assert.match(report, /GKE evidence pending/);
  assert.match(report, /PR lookup incomplete/);
  assert.match(report, /additional SHA ranges omitted/);
  assert.match(report, /Serving \/version commit evidence/);
  assert.match(report, /Capture window/);
  const [, stg, dev] = report.split(
    /\*STG changes\*|\*Dev-only changes \(vs STG\)\*|\*Coverage gaps\*/,
  );
  assert.match(stg, /\/commit\//);
  assert.match(dev, /\/commit\//);
});

test("uses verified production GKE evidence for all eight paths and qualifies ready workers", async () => {
  const snapshot = capture({
    "chat-engine/prd": gke(engineWorkloads, exact("b")),
    "chat-engine/stg": exact("c"),
    "chat-engine/dev": exact("c"),
    "conversation-agent/prd": gke(["conversation-agent"]),
    "conversation-avatar/prd": gke(["conversation-avatar"]),
  });
  const calls = [];
  const report = await formatReleaseReport(snapshot, async (request) => {
    calls.push(request);
    return comparison([{ sha: sha("c"), subject: "Engine change", pullRequests: [] }]);
  });

  assert.deepEqual(calls, [{ repo: "chat-engine", base: sha("b"), head: sha("c") }]);
  assert.match(report, /1 verified change · 8\/8 STG paths covered/);
  assert.match(report, /Full change coverage/);
  assert.match(report, /Cloud Run observed \(UTC\).*2026-11-09T18:01:00.000Z/);
  assert.match(report, /GKE observed \(UTC\).*2026-11-09T18:01:00.000Z/);
  assert.match(report, /Chat Engine web and avatar route digests agree/);
  assert.match(
    report,
    /conversation-agent, conversation-avatar.*ready workers.*job pickup unverified/i,
  );
  assert.doesNotMatch(report, /GKE evidence pending/);
});

test("retains explicit gaps for unresolved GKE workloads", async () => {
  const snapshot = capture({
    "chat-engine/prd": gke(engineWorkloads, { status: "unresolved", reason: "gke-mixed-images" }),
  });
  const report = await formatReleaseReport(snapshot, () => assert.fail("unexpected GitHub call"));
  assert.match(report, /Partial coverage/);
  assert.match(report, /chat-engine.*GKE.*mixed serving images/i);
  assert.match(report, /conversation-agent.*GKE evidence pending/);
  assert.doesNotMatch(report, /route digests agree/);
});

test("rejects unapproved GKE source and workload identities", async () => {
  const invalid = [
    capture({ "gateway/prd": gke(["gateway"]) }),
    capture({ "chat-engine/dev": gke(engineWorkloads) }),
    capture({ "chat-engine/prd": gke(["chat-engine"]) }),
    capture({ "chat-engine/prd": gke(["chat-engine", "chat-engine"]) }),
    capture({ "chat-engine/prd": gke(["chat-engine", "other-avatar"]) }),
    capture({
      "chat-engine/prd": gke(engineWorkloads, { observedAt: "2026-11-09T18:01:01.000Z" }),
    }),
  ];
  for (const snapshot of invalid) {
    await assert.rejects(
      formatReleaseReport(snapshot, () => assert.fail("unexpected GitHub call")),
      /Invalid .*capture/,
    );
  }
});

test("capture CLI merges only matching GKE placeholders from overlapping observation windows", async () => {
  const output = [];
  const now = Date.now();
  const gkeStart = new Date(now - 60_000).toISOString();
  const gkeEnd = new Date(now + 60_000).toISOString();
  const input = capture({
    "chat-engine/prd": gke(engineWorkloads, {
      ...exact("b"),
      observedAt: new Date(now).toISOString(),
    }),
  });
  const path = input.paths.find(
    (row) => row.service === "chat-engine" && row.environment === "prd",
  );
  const errors = [];
  const requests = [];
  const options = {
    output: (message) => output.push(JSON.parse(message)),
    error: (message) => errors.push(message),
    collectGke: async (selection) => {
      requests.push({ ...selection });
      return {
        captureStartedAt: gkeStart,
        capturedAt: gkeEnd,
        paths: [path, { ...path, service: "gateway" }],
      };
    },
  };
  const args = ["--service", "chat-engine", "--environment", "prd"];
  assert.equal(await runCapture(args, options, {}), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [{ service: "chat-engine", environment: "prd" }]);
  assert.equal(output.length, 1);
  assert.deepEqual(output[0].paths, [path]);
  assert.equal(output[0].captureStartedAt, gkeStart);
  assert.equal(output[0].capturedAt, gkeEnd);

  const wrong = {
    ...options,
    collectGke: async () => ({
      captureStartedAt: gkeStart,
      capturedAt: gkeEnd,
      paths: [{ ...path, repo: "other" }],
    }),
  };
  assert.equal(await runCapture(args, wrong, {}), 0);
  assert.equal(output[1].paths[0].status, "gke-pending");

  const disjoint = {
    ...options,
    collectGke: async () => ({
      captureStartedAt,
      capturedAt,
      paths: [{ ...path, observedAt: capturedAt }],
    }),
  };
  assert.equal(await runCapture(args, disjoint, {}), 0);
  assert.equal(output[2].paths[0].status, "gke-pending");
});

test("capture CLI starts eligible GKE alongside Cloud Run and keeps pending evidence on failure", async () => {
  const output = [];
  let gkeReads = 0;
  const options = {
    output: (message) => output.push(JSON.parse(message)),
    error: () => {},
    async collectGke() {
      gkeReads += 1;
      throw new Error("private provider failure");
    },
  };
  const readers = {
    async readService(target) {
      const revisionName = target.cloudRunService + "-00001-xyz";
      return { status: { traffic: [{ revisionName, percent: 100 }] } };
    },
    async readRevision(target, revision) {
      return {
        metadata: { name: revision },
        status: { imageDigest: target.imagePrefix + "@" + digest("a") },
      };
    },
    async readImageCommit() {
      return gkeReads === 1 ? sha("b") : null;
    },
  };
  assert.equal(await runCapture(["--service", "chat-engine"], options, readers), 0);
  assert.equal(gkeReads, 1);
  assert.equal(output[0].paths.find(({ environment }) => environment === "stg").commit, sha("b"));
  assert.equal(
    output[0].paths.find(({ environment }) => environment === "prd").status,
    "gke-pending",
  );
  assert.equal(await runCapture(["--service", "unapproved"], options, readers), 2);
  assert.equal(await runCapture(["--environment", "unapproved"], options, readers), 2);
  assert.equal(await runCapture(["--service", "gateway"], options, readers), 0);
  assert.equal(
    await runCapture(["--service", "chat-engine", "--environment", "stg"], options, readers),
    0,
  );
  assert.equal(gkeReads, 1);
});

test("rejects mismatched or duplicate identities before any comparison", async () => {
  const wrongRepo = capture({ "gateway/stg": { repo: "unapproved" } });
  const duplicate = capture();
  duplicate.paths.push(duplicate.paths[0]);
  for (const invalid of [wrongRepo, duplicate]) {
    await assert.rejects(
      formatReleaseReport(invalid, () => assert.fail("unexpected GitHub call")),
      /Invalid Cloud Run capture/,
    );
  }
});

test("rejects relabeled GKE paths and Cloud Run observations outside the capture contract", async () => {
  const invalid = [
    capture({ "chat-engine/prd": { status: "verified", ...exact("b") } }),
    capture({ "doc-processor/dev": { cloudRunService: "copilot-cloudrun-doc-processor" } }),
    capture({ "scheduler/prd": { observedAt: "2026-11-09T18:01:01.000Z" } }),
    capture({ "scheduler/stg": { observedAt: "2026-11-09T17:59:59.000Z" } }),
  ];
  for (const snapshot of invalid) {
    await assert.rejects(
      formatReleaseReport(snapshot, () => assert.fail("unexpected GitHub call")),
      /Invalid Cloud Run capture/,
    );
  }
});

test("CLI accepts bounded capture JSON on stdin and sanitizes invalid input", async () => {
  const messages = [];
  const errors = [];
  const sinks = {
    compare: () => assert.fail("unexpected GitHub call"),
    output: (message) => messages.push(message),
    error: (message) => errors.push(message),
  };
  const json = JSON.stringify(capture());
  assert.equal(await runReport([json.slice(0, 30), json.slice(30)], sinks), 0);
  assert.equal(messages.length, 1);
  assert.equal(await runReport(["private garbage"], sinks), 2);
  assert.equal(await runReport(["x".repeat(65_537)], sinks), 2);
  assert.equal(messages.length, 1);
  assert.equal(errors.length, 2);
  assert.doesNotMatch(errors.join("\n"), /private garbage|xxx/);
});

test("renders prepared evidence synchronously with the exact baseline report bytes", async () => {
  const snapshot = capture({
    "frontend/prd": { ...exact("b"), commitSource: "cloud-run-version" },
    "frontend/stg": exact("c"),
    "frontend/dev": exact("c"),
    "scheduler/prd": { status: "unresolved", reason: "traffic-changed" },
  });
  let comparisons = 0;
  const evidence = await runReleaseChanges({
    capture: () => snapshot,
    compare: () => {
      comparisons += 1;
      return comparison(
        [
          {
            sha: sha("c"),
            subject: "change",
            pullRequests: [{ number: 123, title: "Guard <!channel> *rollout*" }],
          },
        ],
        "partial",
      );
    },
  });
  const report = renderReleaseReport(evidence);
  assert.equal(comparisons, 1);
  assert.equal(
    createHash("sha256").update(report).digest("hex"),
    "9ca87463c60d89181c391ea85d879fd956f6fc3cbde34af9425bc0fb2f70ca45",
  );
});

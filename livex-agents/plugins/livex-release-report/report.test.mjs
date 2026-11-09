import assert from "node:assert/strict";
import test from "node:test";
import { formatReleaseReport, runReport } from "./report.mjs";
import registry from "./services.json" with { type: "json" };

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
        const evidence =
          environment === "prd" && gkeProduction
            ? { status: "gke-pending", reason: "production-route-served-by-gke" }
            : { status: "verified", digest: digest("a"), commit: null };
        return Object.assign(identity, evidence, overrides[service + "/" + environment]);
      }),
  );
  return { captureStartedAt, capturedAt, paths };
}

function exact(digit, commit = sha(digit)) {
  return { digest: digest(digit), commit, commitSource: "artifact-registry-config" };
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
      path.commitSource = "artifact-registry-config";
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
  assert.match(report, /Capture window/);
  const [, stg, dev] = report.split(
    /\*STG changes\*|\*Dev-only changes \(vs STG\)\*|\*Coverage gaps\*/,
  );
  assert.match(stg, /\/commit\//);
  assert.match(dev, /\/commit\//);
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

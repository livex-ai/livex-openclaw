import assert from "node:assert/strict";
import test from "node:test";
import { runReleaseChanges } from "./service.mjs";

const captureStartedAt = "2026-11-09T18:00:00.000Z";
const capturedAt = "2026-11-09T18:01:00.000Z";
const base = "b".repeat(40);
const head = "c".repeat(40);

function scheduler(environment, digit) {
  return {
    service: "scheduler",
    repo: "copilot-scheduler",
    environment,
    project: {
      dev: "ai-mvp-dv",
      stg: "livex-copilot-stg",
      prd: "livex-copilot-prd",
    }[environment],
    region: "us-central1",
    cloudRunService: "copilot-scheduler",
    status: "verified",
    observedAt: capturedAt,
    digest: "sha256:" + digit.repeat(64),
    commit: digit.repeat(40),
    commitSource: "artifact-registry-config",
    raw: "discard capture internals",
  };
}

test("runs one capture and returns ordered, serializable comparison evidence", async () => {
  const calls = [];
  const report = await runReleaseChanges({
    capture() {
      calls.push("capture");
      return {
        captureStartedAt,
        capturedAt,
        paths: [
          scheduler("prd", "b"),
          scheduler("stg", "c"),
          scheduler("dev", "c"),
          {
            ...scheduler("stg", "c"),
            service: "gateway",
            repo: "copilot-api-gateway",
            cloudRunService: "copilot-api-gateway",
            status: "unresolved",
            reason: "discard private failure detail",
          },
          {
            service: "frontend",
            repo: "chat-frontend",
            environment: "prd",
            project: "livex-copilot-prd",
            region: "us-central1",
            cloudRunService: "copilot-chat-frontend",
            status: "verified",
            observedAt: capturedAt,
            digest: "sha256:" + "a".repeat(64),
            commit: "a".repeat(40),
            commitSource: "cloud-run-version",
          },
        ],
      };
    },
    compare(request) {
      calls.push(request);
      return {
        status: "verified",
        ahead: 1,
        behind: 0,
        linkStatus: "complete",
        raw: "discard comparison internals",
        commits: [
          {
            sha: head,
            subject: "Synthetic change",
            raw: "discard commit internals",
            pullRequests: [
              { number: 123, title: "Synthetic pull request", raw: "discard PR internals" },
            ],
          },
        ],
      };
    },
  });
  assert.deepEqual(calls, ["capture", { repo: "copilot-scheduler", base, head }]);
  assert.equal(report.captureStartedAt, captureStartedAt);
  assert.equal(report.capturedAt, capturedAt);
  const serialized = JSON.stringify(report);
  assert.deepEqual(JSON.parse(serialized), report);
  assert.doesNotMatch(serialized, /discard |https:\/\//);
  assert.deepEqual(
    report.observations.find(({ service }) => service === "frontend"),
    {
      service: "frontend",
      environment: "prd",
      source: "cloud-run",
      observedAt: capturedAt,
      commitSource: "cloud-run-version",
    },
  );
  const [stg, dev] = report.comparisons;
  assert.deepEqual([stg.base, stg.head, dev.base, dev.head], ["prd", "stg", "stg", "dev"]);
  assert.deepEqual(
    stg.results.find(({ service }) => service === "scheduler"),
    {
      service: "scheduler",
      repo: "copilot-scheduler",
      range: { base, head },
      ahead: 1,
      behind: 0,
      linkStatus: "complete",
      commits: [
        {
          sha: head,
          subject: "Synthetic change",
          pullRequests: [{ number: 123, title: "Synthetic pull request" }],
        },
      ],
    },
  );
  assert.deepEqual(
    stg.results.find(({ service }) => service === "frontend"),
    {
      service: "frontend",
      gap: { kind: "capture", paths: [{ environment: "stg", kind: "missing" }] },
    },
  );
});

test("requires explicit provider callbacks before starting capture", async () => {
  await assert.rejects(
    runReleaseChanges({ capture: () => assert.fail("capture should not start") }),
    /capture and compare functions/,
  );
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it } from "vitest";
import { createOncallCatalogReader } from "./oncall-catalog.js";
import { createIssueId, serializeCatalog, type CatalogIssue } from "./schema.js";

const scope = {
  agentId: "oncall",
  accountId: "default",
  teamId: "T1",
  channelId: "C1",
  senderId: "U1",
};
const signature = {
  service: "scheduler",
  environment: "prd",
  operation: "parse",
  error: "Missing field",
  resource: "job-1",
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(issues: CatalogIssue[] = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oncall-catalog-"));
  directories.push(directory);
  const file = path.join(directory, "investigations.md");
  await fs.writeFile(file, serializeCatalog(issues));
  const config = {
    agents: { entries: { oncall: { agentDir: directory } } },
    plugins: {
      entries: {
        "livex-investigations": {
          enabled: true,
          config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
        },
      },
    },
  };
  return { file, config };
}

function issue(): CatalogIssue {
  return {
    issueId: createIssueId({ ...signature, scope }),
    signature: { ...signature, scope },
    task: "Investigate",
    status: "Open",
    waitingOn: "",
    prs: [],
    jiraTickets: [],
    slackThreads: ["https://example.slack.com/archives/C1/p1000000000000000"],
    lastUpdated: "2026-11-06T10:00:00-08:00",
    whatWeDidLast: [
      {
        completedAt: "2026-11-06T10:00:00-08:00",
        summary: "Observed",
        kind: "new",
        facts: {
          priority: "Critical",
          finding: "Failure",
          impact: "One job",
          nextAction: "Review",
        },
        evidenceUrls: ["https://logs.example/1"],
        reportUrl: "https://example.slack.com/archives/C1/p1000000000000000",
      },
    ],
  };
}

it("uses the owning parser and scope for known Critical and genuinely new failures", async () => {
  const { config } = await fixture([issue()]);
  const reader = createOncallCatalogReader({ config, scope, assertCurrent() {} });
  const matches = await reader.lookup([signature, { ...signature, error: "Different failure" }]);
  expect(matches.map((match) => match.classification)).toEqual(["known", "unknown"]);
  expect(matches[0]!.issueId).toBe(issue().issueId);
});

it.each(["global-disable", "entry-disable", "deny", "not-allowed"])(
  "refuses initially %s catalog authority for known and new signatures",
  async (mode) => {
    const fixtureValue = await fixture([issue()]);
    const config: OpenClawConfig = structuredClone(fixtureValue.config);
    const plugins = config.plugins!;
    const authorized = createOncallCatalogReader({
      config,
      scope,
      assertCurrent() {},
    }).sourceIdentity;
    if (mode === "global-disable") {
      plugins.enabled = false;
    }
    if (mode === "entry-disable") {
      plugins.entries!["livex-investigations"]!.enabled = false;
    }
    if (mode === "deny") {
      plugins.deny = ["livex-investigations"];
    }
    if (mode === "not-allowed") {
      plugins.allow = ["livex-gcp-readonly"];
    }
    const reader = createOncallCatalogReader({ config, scope, assertCurrent() {} });
    expect(reader.sourceIdentity).not.toBe(authorized);
    expect(
      (await reader.lookup([signature, { ...signature, error: "New failure" }])).map(
        (match) => match.classification,
      ),
    ).toEqual(["unclassified", "unclassified"]);
  },
);

it("preserves default-enabled catalog semantics when optional eligibility flags are absent", async () => {
  const fixtureValue = await fixture([issue()]);
  const config: OpenClawConfig = structuredClone(fixtureValue.config);
  delete config.plugins!.entries!["livex-investigations"]!.enabled;
  const reader = createOncallCatalogReader({ config, scope, assertCurrent() {} });
  expect((await reader.lookup([signature]))[0]?.classification).toBe("known");
});

it("treats conflicting signatures and duplicate matches as unclassified", async () => {
  const { config } = await fixture([issue(), issue()]);
  const reader = createOncallCatalogReader({ config, scope, assertCurrent() {} });
  expect((await reader.lookup([signature]))[0]!.classification).toBe("unclassified");
  expect((await reader.lookup([{ ...signature, operation: "different" }]))[0]!.classification).toBe(
    "unclassified",
  );
});

it("does not turn corrupt or missing catalog into an unknown classification", async () => {
  const { config, file } = await fixture();
  const reader = createOncallCatalogReader({ config, scope, assertCurrent() {} });
  await fs.writeFile(file, "broken");
  expect((await reader.lookup([signature]))[0]!.classification).toBe("unclassified");
  await fs.unlink(file);
  expect((await reader.lookup([signature]))[0]!.classification).toBe("unclassified");
});

it("rechecks lifecycle after the actual read", async () => {
  const { config } = await fixture();
  let count = 0;
  const reader = createOncallCatalogReader({
    config,
    scope,
    assertCurrent() {
      if (++count > 1) {
        throw new Error("retired");
      }
    },
  });
  await expect(reader.lookup([signature])).rejects.toThrow("retired");
});

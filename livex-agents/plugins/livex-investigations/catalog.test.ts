import fs from "node:fs/promises";
import path from "node:path";
import * as securityRuntime from "openclaw/plugin-sdk/security-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { compareFindings } from "./matching.js";
import {
  parseCatalog,
  parseCompletedInvestigations,
  serializeCatalog,
  type CompletedInvestigation,
  type HistoryScope,
} from "./schema.js";
import { commitInvestigations, readCatalog } from "./store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scope: HistoryScope = {
  agentId: "oncall",
  accountId: "default",
  teamId: "T1",
  channelId: "C1",
  senderId: "U1",
};
const firstUrl = "https://example.slack.com/archives/C1/p1000000000000000";
const secondUrl = "https://example.slack.com/archives/C1/p1000000000000001";
const thirdUrl = "https://example.slack.com/archives/C1/p1000000000000002";
const initial =
  "# Investigation catalog\n\n<!-- openclaw-investigations:v1 -->\n\n## Record fields\n\n- Issue ID\n- Issue signature\n- Task\n- Status\n- What we did last (dated investigation history)\n- Waiting on (next action, accepted owner, and blockers when verified)\n- PRs (link array)\n- Slack threads (link array; original verified investigation first)\n- Jira tickets (link array)\n- Last updated (America/Los_Angeles with UTC offset)\n\n## Investigations\n\n<!-- Completed issue records belong below. The catalog is currently empty. -->\n";
function finding(
  error = "missing variant_name",
  overrides: Partial<CompletedInvestigation> = {},
): CompletedInvestigation {
  return {
    signature: {
      scope,
      service: "document-worker",
      environment: "production",
      operation: "parse",
      error,
    },
    task: "Investigate document parsing",
    status: "Investigated",
    historySummary: "Confirmed missing variant_name",
    waitingOn: "Owner acceptance unknown",
    prs: [],
    slackThreads: [],
    jiraTickets: [],
    facts: {
      finding: error,
      impact: "Some documents fail",
      nextAction: "Validate variant handling",
    },
    evidenceUrls: ["https://logs.example/evidence"],
    ...overrides,
  };
}
async function catalogPath() {
  const filePath = path.join(tempDirs.make("slack-investigations-"), "investigations.md");
  await fs.writeFile(filePath, initial, { mode: 0o600 });
  return filePath;
}
async function record(
  filePath: string,
  updates = [finding()],
  reportUrl = firstUrl,
  now = new Date("2026-10-21T12:00:00Z"),
) {
  return await commitInvestigations({
    filePath,
    scope,
    updates,
    reportUrl,
    now,
    assertCurrent: () => {},
  });
}

describe("completed investigation catalog", () => {
  it("accepts the initialized empty human-readable artifact and round trips escaped record fields", async () => {
    const filePath = await catalogPath();
    expect(parseCatalog(initial)).toEqual([]);
    const task = 'Quoted "task"\n## forged issue\n- Status: "resolved"';
    expect((await record(filePath, [finding("missing variant_name", { task })])).status).toBe(
      "committed",
    );
    const snapshot = await readCatalog({ filePath, scope });
    expect(snapshot.status).toBe("ready");
    expect(snapshot.issues[0].task).toBe(task);
    expect(parseCatalog(serializeCatalog(snapshot.issues))).toEqual(snapshot.issues);
    expect((await fs.readFile(filePath, "utf8")).match(/^### /gm)).toHaveLength(1);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("treats schema marker text inside a quoted task as inert record content", async () => {
    const filePath = await catalogPath();
    const task = "Report quoted <!-- openclaw-investigations:v1 --> as evidence";
    await record(filePath, [finding(undefined, { task })]);
    const snapshot = await readCatalog({ filePath, scope });
    expect(snapshot.status).toBe("ready");
    expect(snapshot.issues[0]?.task).toBe(task);
  });

  it("links Oct 24 and Oct 25 persistence to Oct 21 without changing substantive Last updated", async () => {
    const filePath = await catalogPath();
    await record(filePath);
    const first = await readCatalog({ filePath, scope });
    expect(compareFindings(first, [finding()])[0]).toMatchObject({
      kind: "known-persistence",
      canonicalThreadUrl: firstUrl,
      changes: [],
    });
    await record(filePath, [finding()], secondUrl, new Date("2026-10-24T12:00:00Z"));
    await record(filePath, [finding()], thirdUrl, new Date("2026-10-25T12:00:00Z"));
    const after = await readCatalog({ filePath, scope });
    expect(after.issues).toHaveLength(1);
    expect(after.issues[0].slackThreads).toEqual([firstUrl, secondUrl, thirdUrl]);
    expect(after.issues[0].whatWeDidLast.map((entry) => entry.kind)).toEqual([
      "new",
      "known-persistence",
      "known-persistence",
    ]);
    expect(after.issues[0].lastUpdated).toBe(first.issues[0].lastUpdated);
    expect(after.issues[0].lastUpdated).toContain("-07:00");
    expect(after.issues[0].whatWeDidLast[2].completedAt).toContain("2026-10-25");
  });

  it("keeps independent embedding, account, sitemap and bulk timeout signatures separate", async () => {
    const filePath = await catalogPath();
    const updates = [
      "missing variant_name",
      "embedding delete failed",
      "missing account_id",
      "invalid sitemap",
      "bulk timeout",
    ].map((error) => finding(error));
    await record(filePath, updates);
    const snapshot = await readCatalog({ filePath, scope });
    expect(snapshot.issues).toHaveLength(5);
    expect(new Set(snapshot.issues.map((issue) => issue.issueId)).size).toBe(5);
    expect(compareFindings(snapshot, updates).map((match) => match.kind)).toEqual(
      Array(5).fill("known-persistence"),
    );
  });

  it.each([false, true])(
    "persists independent same-error operations against one locked baseline (reversed=%s)",
    async (reversed) => {
      const filePath = await catalogPath();
      const updates = ["parse", "delete"].map((operation) =>
        finding("operation failed", {
          signature: { ...finding().signature, operation, error: "operation failed" },
        }),
      );
      if (reversed) {
        updates.reverse();
      }
      const before = await readCatalog({ filePath, scope });
      expect(compareFindings(before, updates).map((match) => match.kind)).toEqual(["new", "new"]);
      const result = await record(filePath, updates);
      expect(result).toMatchObject({ status: "committed", saved: 2, skipped: 0 });
      const after = await readCatalog({ filePath, scope });
      expect(after.status).toBe("ready");
      expect(after.issues.map((issue) => issue.signature.operation).toSorted()).toEqual([
        "delete",
        "parse",
      ]);
      expect(after.issues.every((issue) => issue.whatWeDidLast[0]?.kind === "new")).toBe(true);
    },
  );

  it("records an exact duplicate signature only once within one delivered batch", async () => {
    const filePath = await catalogPath();
    const result = await record(filePath, [finding(), finding()]);
    expect(result).toMatchObject({ status: "committed", saved: 1, skipped: 0 });
    const after = await readCatalog({ filePath, scope });
    expect(after.status).toBe("ready");
    expect(after.issues).toHaveLength(1);
    expect(after.issues[0]?.whatWeDidLast).toHaveLength(1);
    expect(after.issues[0]?.slackThreads).toEqual([firstUrl]);
    expect(await record(filePath, [finding(), finding()])).toMatchObject({
      status: "unchanged",
      saved: 0,
      skipped: 0,
    });
  });

  it("retains a preexisting near-collision as uncertain without changing its record", async () => {
    const filePath = await catalogPath();
    await record(filePath);
    const before = await fs.readFile(filePath, "utf8");
    const conflicting = finding(undefined, {
      signature: { ...finding().signature, operation: "delete" },
    });
    expect(compareFindings(await readCatalog({ filePath, scope }), [conflicting])[0]?.kind).toBe(
      "uncertain",
    );
    expect(await record(filePath, [conflicting], secondUrl)).toMatchObject({
      status: "partial",
      saved: 0,
      skipped: 1,
    });
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
  });

  it.each([
    ["impact", { impact: "New customer impacted" }],
    ["evidence", { evidence: "Pinned source confirms the missing field is required" }],
    ["nextAction", { nextAction: "Patch the parser" }],
    [
      "owner",
      {
        owner: {
          name: "Accepted operator",
          evidenceUrl: "https://example.slack.com/archives/C1/p2000000000000000",
        },
      },
    ],
    ["disposition", { disposition: "Fix approved" }],
    ["recovery", { recovery: "No failures in a complete follow-up window" }],
  ])("reports meaningful %s changes", async (field, patch) => {
    const filePath = await catalogPath();
    await record(filePath);
    const updated = finding(undefined, { facts: { ...finding().facts, ...patch } });
    const matches = compareFindings(await readCatalog({ filePath, scope }), [updated]);
    expect(matches[0]).toMatchObject({ kind: "changed", changes: [field] });
    await record(filePath, [updated], secondUrl, new Date("2026-10-24T12:00:00Z"));
    const after = await readCatalog({ filePath, scope });
    expect(after.issues[0].lastUpdated).toContain("2026-10-24");
  });

  it("does not treat a fresh evidence URL, prose timestamp or omitted owner as new cause or owner removal", async () => {
    const filePath = await catalogPath();
    const owner = { name: "Operator", evidenceUrl: secondUrl };
    await record(filePath, [
      finding(undefined, {
        facts: { ...finding().facts, owner, disposition: "Waiting for owner" },
      }),
    ]);
    const update = finding(undefined, {
      historySummary: "Seen again at a newer timestamp",
      evidenceUrls: ["https://logs.example/new-window"],
    });
    expect(compareFindings(await readCatalog({ filePath, scope }), [update])[0].kind).toBe(
      "known-persistence",
    );
    await record(filePath, [update], thirdUrl);
    const saved = (await readCatalog({ filePath, scope })).issues[0].whatWeDidLast.at(-1);
    expect(saved?.facts.owner).toEqual(owner);
    expect(saved?.facts.disposition).toBe("Waiting for owner");
  });

  it.each([undefined, "Waiting for release"])(
    "preserves visible ownership when a repeat carries disposition %s",
    async (disposition) => {
      const filePath = await catalogPath();
      await record(filePath, [
        finding(undefined, {
          status: "In progress",
          waitingOn: "Maya accepted the parser fix; waiting for release",
          facts: {
            ...finding().facts,
            owner: { name: "Maya", evidenceUrl: secondUrl },
            disposition: "Waiting for release",
          },
        }),
      ]);
      const before = (await readCatalog({ filePath, scope })).issues[0]!;
      const repeat = finding(undefined, {
        facts: { ...finding().facts, ...(disposition ? { disposition } : {}) },
      });
      expect(compareFindings(await readCatalog({ filePath, scope }), [repeat])[0]?.kind).toBe(
        "known-persistence",
      );
      await record(filePath, [repeat], thirdUrl);
      const after = (await readCatalog({ filePath, scope })).issues[0]!;
      expect(after.waitingOn).toBe(before.waitingOn);
      expect(after.status).toBe("In progress");
      expect(after.lastUpdated).toBe(before.lastUpdated);
    },
  );

  it("preserves readable old history when a derived tracking value exceeds its field limit", async () => {
    const filePath = await catalogPath();
    await record(filePath, [
      finding(undefined, {
        waitingOn: "Accepted owner Maya",
        facts: { ...finding().facts, owner: { name: "Maya", evidenceUrl: secondUrl } },
      }),
    ]);
    const before = await fs.readFile(filePath, "utf8");
    const result = await record(
      filePath,
      [finding(undefined, { facts: { ...finding().facts, nextAction: "x".repeat(4_096) } })],
      thirdUrl,
    );
    expect(result.status).toBe("partial");
    expect(result.saved).toBeUndefined();
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
    expect((await readCatalog({ filePath, scope })).status).toBe("ready");
  });

  it("does not collapse case-sensitive resource identifiers into the same known issue", async () => {
    const filePath = await catalogPath();
    await record(filePath, [
      finding(undefined, { signature: { ...finding().signature, resource: "bucket/ReportA" } }),
    ]);
    const differentResource = finding(undefined, {
      signature: { ...finding().signature, resource: "bucket/reporta" },
    });
    const snapshot = await readCatalog({ filePath, scope });
    expect(snapshot.issues[0]?.signature.resource).toBe("bucket/ReportA");
    expect(compareFindings(snapshot, [differentResource])[0]?.kind).toBe("uncertain");
  });

  it("never merges missing or conflicting context and still persists a valid independent issue", async () => {
    const filePath = await catalogPath();
    await record(filePath);
    const missing = finding(undefined, { signature: { ...finding().signature, environment: "" } });
    const conflicting = finding(undefined, {
      signature: { ...finding().signature, service: "other-service" },
    });
    const snapshot = await readCatalog({ filePath, scope });
    expect(compareFindings(snapshot, [missing, conflicting]).map((match) => match.kind)).toEqual([
      "uncertain",
      "uncertain",
    ]);
    const result = await record(filePath, [missing, finding("new independent error")], secondUrl);
    expect(result).toMatchObject({ status: "partial", saved: 1, skipped: 1 });
    const after = await readCatalog({ filePath, scope });
    expect(after.issues).toHaveLength(2);
    expect(
      after.issues.find((issue) => issue.signature.error === "missing variant_name")?.slackThreads,
    ).toEqual([firstUrl]);
  });

  it("keeps scope boundaries and never returns another channel's records", async () => {
    const filePath = await catalogPath();
    await record(filePath);
    const other = { ...scope, channelId: "C2" };
    expect((await readCatalog({ filePath, scope: other })).issues).toEqual([]);
    const wrong = finding(undefined, { signature: { ...finding().signature, scope: other } });
    const result = await record(filePath, [wrong], secondUrl);
    expect(result.status).toBe("partial");
    expect((await readCatalog({ filePath, scope })).issues).toHaveLength(1);
  });

  it("serializes concurrent writers, preserves both issues and makes a repeated delivery idempotent", async () => {
    const filePath = await catalogPath();
    await Promise.all([record(filePath), record(filePath, [finding("bulk timeout")], secondUrl)]);
    const before = await fs.readFile(filePath, "utf8");
    expect((await readCatalog({ filePath, scope })).issues).toHaveLength(2);
    expect((await record(filePath)).status).toBe("unchanged");
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
  });

  it("distinguishes missing, corrupt and oversized history and preserves invalid content", async () => {
    const filePath = await catalogPath();
    await fs.rm(filePath);
    expect((await readCatalog({ filePath, scope })).status).toBe("uninitialized");
    expect((await record(filePath)).status).toBe("uninitialized");
    await fs.writeFile(filePath, "malformed history");
    expect((await readCatalog({ filePath, scope })).status).toBe("corrupt");
    expect((await record(filePath)).status).toBe("corrupt");
    expect(await fs.readFile(filePath, "utf8")).toBe("malformed history");
    await fs.writeFile(filePath, "x".repeat(2 * 1024 * 1024 + 1));
    expect((await readCatalog({ filePath, scope })).status).toBe("partial");
    expect((await record(filePath)).status).toBe("partial");
  });

  it("rejects duplicate fields, malformed URLs and an owner claim without evidence", async () => {
    const filePath = await catalogPath();
    await record(filePath);
    const content = await fs.readFile(filePath, "utf8");
    expect(() =>
      parseCatalog(
        content.replace(
          '- Status: "Investigated"',
          '- Status: "Investigated"\n- Status: "Resolved"',
        ),
      ),
    ).toThrow();
    expect(() =>
      parseCompletedInvestigations([{ ...finding(), prs: ["javascript:alert(1)"] }]),
    ).toThrow();
    expect(() =>
      parseCompletedInvestigations([
        { ...finding(), facts: { ...finding().facts, owner: { name: "Someone" } } },
      ]),
    ).toThrow();
  });

  it.each([
    ["Bearer", "Authorization: Bearer fixture-opaque-credential-0123456789"],
    ["API key", "api_key=fixture-api-key-0123456789"],
    ["query credential", "https://logs.example/read?access_token=fixture-query-secret-0123456789"],
  ])(
    "rejects %s content at input and retained-record boundaries without echoing it",
    async (_kind, sensitive) => {
      const message = "Investigation content contains sensitive data";
      expect(() =>
        parseCompletedInvestigations([finding(undefined, { historySummary: sensitive })]),
      ).toThrow(message);
      expect(() =>
        parseCompletedInvestigations([
          finding(undefined, { facts: { ...finding().facts, finding: sensitive } }),
        ]),
      ).toThrow(message);
      if (_kind === "query credential") {
        expect(() =>
          parseCompletedInvestigations([finding(undefined, { evidenceUrls: [sensitive] })]),
        ).toThrow(message);
      }
      const filePath = await catalogPath();
      await record(filePath);
      const clean = await fs.readFile(filePath, "utf8");
      const unsafe = clean.replace(
        '"summary":"Confirmed missing variant_name"',
        `"summary":${JSON.stringify(sensitive)}`,
      );
      expect(unsafe).not.toBe(clean);
      let error: unknown;
      try {
        parseCatalog(unsafe);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(message);
      expect((error as Error).message).not.toContain(sensitive);
    },
  );

  it("preserves the old catalog after a staged write fails before atomic publication", async () => {
    const filePath = await catalogPath();
    await record(filePath);
    const before = await fs.readFile(filePath, "utf8");
    const replace = securityRuntime.replaceFileAtomic;
    const spy = vi.spyOn(securityRuntime, "replaceFileAtomic").mockImplementationOnce(
      async (params) =>
        await replace({
          ...params,
          beforeRename: async () => {
            throw new Error("synthetic write failure");
          },
        }),
    );
    try {
      const result = await record(filePath, [finding("bulk timeout")], secondUrl);
      expect(result.status).toBe("unavailable");
      expect(result.saved).toBeUndefined();
      expect(await fs.readFile(filePath, "utf8")).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  it("checks current authority immediately before replacement and leaves old bytes intact on refusal", async () => {
    const filePath = await catalogPath();
    const before = await fs.readFile(filePath, "utf8");
    const assertCurrent = vi.fn(() => {
      throw new Error("invocation closed");
    });
    await expect(
      commitInvestigations({
        filePath,
        scope,
        updates: [finding()],
        reportUrl: firstUrl,
        now: new Date(),
        assertCurrent,
      }),
    ).rejects.toThrow("invocation closed");
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
  });
});

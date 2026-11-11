import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginRecord,
  createPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ReplyTurnDeliveryHost, ReportAmendment } from "openclaw/plugin-sdk/reply-turns";
import type { AgentReportProfile } from "openclaw/plugin-sdk/report-profiles";
import { resolveAgentReportProfile } from "openclaw/plugin-sdk/report-profiles";
import { afterEach, expect, it, vi } from "vitest";
import { createInvestigationDelivery } from "./delivery.js";
import { createInvestigationRecordTool } from "./report-tool.js";
import { closeInvestigationTurnRegistry, getInvestigationTurnRegistry } from "./runtime.js";
import { serializeCatalog, type CompletedInvestigation } from "./schema.js";
import { commitInvestigations, readCatalog } from "./store.js";

const rootPaths: string[] = [];
function profile(id: string, agentId: string): AgentReportProfile {
  return {
    id,
    agentIds: [agentId],
    channels: ["slack"],
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    instructions: `Use ${id} format`,
    prepare: (input) => {
      const text = `${id}: ${(input as { message: string }).message}`;
      return {
        profileId: id,
        text,
        state: {},
        channelData: {
          slack: { blocks: [{ type: "section", text: { type: "plain_text", text } }] },
        },
      };
    },
    appendNotice: (prepared, notice) => ({
      ...prepared,
      text: `${prepared.text} (${id}: ${notice})`,
    }),
  };
}
function install() {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "fixture-reports",
    source: "/fixture/index.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  record.status = "loaded";
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  api.registerReportProfile(profile("compact", "oncall"));
  api.registerReportProfile(profile("qa", "qa"));
  setActivePluginRegistry(builder.registry);
  return builder;
}
async function turn(agentId: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "report-profile-"));
  rootPaths.push(root);
  const filePath = path.join(root, "investigations.md");
  await fs.writeFile(filePath, serializeCatalog([]));
  const scope = { agentId, accountId: "default", teamId: "T1", channelId: "C1", senderId: "U1" };
  const sessionKey = `agent:${agentId}:slack:channel:c1`;
  const value = getInvestigationTurnRegistry().register({
    id: agentId,
    scope,
    sessionKey,
    filePath,
    reportProfile: resolveAgentReportProfile(agentId, "slack"),
    snapshot: { status: "ready", scope, revision: "r", issues: [] },
    assertCurrent() {},
  });
  const ctx: OpenClawPluginToolContext<2> = {
    agentId,
    agentAccountId: "default",
    messageChannel: "slack",
    nativeChannelId: "C1",
    requesterSenderId: "U1",
    sessionKey,
    toolBindings: { slack_investigation: { turnId: agentId } },
    assertInvocationCurrent() {},
  };
  const update: CompletedInvestigation = {
    signature: {
      scope,
      service: "api",
      environment: "prod",
      operation: "mapping",
      error: "variant_name",
    },
    task: "Mapping",
    status: "open",
    historySummary: "Field missing",
    waitingOn: "Unassigned",
    prs: [],
    slackThreads: [],
    jiraTickets: [],
    facts: { finding: "Missing field", impact: "One job", nextAction: "Fix mapping" },
    evidenceUrls: [],
  };
  return { value, ctx, update, filePath, scope };
}
afterEach(async () => {
  closeInvestigationTurnRegistry();
  setActivePluginRegistry(
    createPluginRegistry({
      logger: { info() {}, warn() {}, error() {} },
      runtime: createPluginRuntimeMock(),
      activateGlobalSideEffects: false,
    }).registry,
  );
  await Promise.all(
    rootPaths.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
it("uses each agent's configured schema and renderer through the real record tool", async () => {
  install();
  for (const agentId of ["oncall", "qa"]) {
    const fixture = await turn(agentId);
    const tool = createInvestigationRecordTool(fixture.ctx);
    expect(tool.parameters).toMatchObject({ properties: { report: { required: ["message"] } } });
    const result = await tool.execute("prepare", {
      action: "prepare_update",
      report: { message: "Done" },
      updates: [fixture.update],
    });
    expect(result.details).toMatchObject({
      finalText: `${agentId === "oncall" ? "compact" : "qa"}: Done`,
    });
  }
  expect(resolveAgentReportProfile("ordinary", "slack")).toBeUndefined();
});
it("keeps the staged profile through queued projection and records only the confirmed receipt", async () => {
  const builder = install();
  const fixture = await turn("oncall");
  const result = await createInvestigationRecordTool(fixture.ctx).execute("prepare", {
    action: "prepare_update",
    report: { message: "Done" },
    updates: [fixture.update],
  });
  expect(result.details).toMatchObject({ finalText: "compact: Done" });
  // Change current selection without retiring this admitted turn's owner.
  builder.registry.reportProfiles.splice(0, 1);
  builder.registerReportProfile(builder.registry.plugins[0]!, profile("later", "oncall"));
  const owner = createInvestigationDelivery({
    turn: fixture.value,
    sourceMessageIds: ["source"],
    resolvePermalink: async () => "https://example.slack.com/archives/C1/p1000000000000000",
    annotateAcceptedFinal: vi.fn(),
    reportError: vi.fn(),
    deliver: vi.fn(async () => ({ visibleReplySent: true })),
  });
  const projected = owner.queuedCorrelation?.prepareReply?.(
    { text: "compact: Done" },
    { kind: "final" },
  );
  expect(projected).toMatchObject({
    text: "compact: Done",
    channelData: { slack: { blocks: [{ text: { text: "compact: Done" } }] } },
  });
  expect(
    (await readCatalog({ filePath: fixture.filePath, scope: fixture.scope })).issues,
  ).toHaveLength(0);
  await owner.queuedCorrelation?.onReplyDelivered?.(projected!, {
    kind: "final",
    complete: false,
    messageId: "1000000000.000000",
  });
  expect(
    (await readCatalog({ filePath: fixture.filePath, scope: fixture.scope })).issues,
  ).toHaveLength(0);
  await owner.queuedCorrelation?.onReplyDelivered?.(projected!, {
    kind: "final",
    complete: true,
    messageId: "1000000000.000000",
  });
  await owner.queuedCorrelation?.onReplyDelivered?.(projected!, {
    kind: "final",
    complete: true,
    messageId: "1000000000.000000",
  });
  const saved = await readCatalog({ filePath: fixture.filePath, scope: fixture.scope });
  expect(saved.issues).toHaveLength(1);
  expect(saved.issues[0]?.whatWeDidLast).toHaveLength(1);
  expect(saved.issues[0]?.whatWeDidLast[0]?.reportUrl).toBe(
    "https://example.slack.com/archives/C1/p1000000000000000",
  );
});

it.each(["text", "card", "missing-card", "mutated-card"] as const)(
  "does not publish or restore a queued report changed by outbound policy (%s)",
  async (change) => {
    install();
    const fixture = await turn("oncall");
    await createInvestigationRecordTool(fixture.ctx).execute("prepare", {
      action: "prepare_update",
      report: { message: "Done" },
      updates: [fixture.update],
    });
    const annotateAcceptedFinal = vi.fn();
    const reportError = vi.fn();
    const resolvePermalink = vi.fn(
      async () => "https://example.slack.com/archives/C1/p1000000000000000",
    );
    const owner = createInvestigationDelivery({
      turn: fixture.value,
      sourceMessageIds: ["source"],
      resolvePermalink,
      annotateAcceptedFinal,
      reportError,
      deliver: vi.fn(async () => ({ visibleReplySent: true })),
    });
    const projected = owner.queuedCorrelation!.prepareReply!(
      { text: "compact: Done" },
      { kind: "final" },
    )!;
    if (change === "mutated-card") {
      const slack = projected.channelData!.slack as { blocks: { text: { text: string } }[] };
      slack.blocks[0]!.text.text = "Policy replacement";
    }
    const accepted =
      change === "mutated-card"
        ? projected
        : change === "text"
          ? { ...projected, text: "Policy replacement" }
          : {
              ...projected,
              channelData:
                change === "missing-card"
                  ? undefined
                  : {
                      slack: {
                        blocks: [
                          {
                            type: "section",
                            text: { type: "plain_text", text: "Policy replacement" },
                          },
                        ],
                      },
                    },
            };
    await owner.queuedCorrelation!.onReplyDelivered!(accepted, {
      kind: "final",
      complete: true,
      messageId: "1000000000.000000",
    });
    expect(
      (await readCatalog({ filePath: fixture.filePath, scope: fixture.scope })).issues,
    ).toEqual([]);
    expect(resolvePermalink).not.toHaveBeenCalled();
    expect(annotateAcceptedFinal).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining("accepted final differs"));
  },
);

it("keeps the captured turn schema if selection changes before tool construction", async () => {
  const builder = install();
  const fixture = await turn("oncall");
  builder.registry.reportProfiles.splice(0, 1);
  builder.registerReportProfile(builder.registry.plugins[0]!, {
    ...profile("later", "oncall"),
    inputSchema: {
      type: "object",
      properties: { incompatible: { type: "boolean" } },
      required: ["incompatible"],
    },
  });
  const tool = createInvestigationRecordTool(fixture.ctx);
  expect(tool.parameters).toMatchObject({ properties: { report: { required: ["message"] } } });
  const result = await tool.execute("prepare", {
    action: "prepare_update",
    report: { message: "Done" },
    updates: [fixture.update],
  });
  expect(result.details).toMatchObject({ finalText: "compact: Done" });
});

it("retains the selected warning profile and exact accepted receipt after selection changes", async () => {
  const builder = install();
  const fixture = await turn("oncall");
  await createInvestigationRecordTool(fixture.ctx).execute("prepare", {
    action: "prepare_update",
    report: { message: "Done" },
    updates: [fixture.update],
  });
  builder.registry.reportProfiles.splice(0, 1);
  builder.registerReportProfile(builder.registry.plugins[0]!, profile("later", "oncall"));
  await fs.rename(fixture.filePath, fixture.filePath + ".retained");
  const annotateAcceptedFinal = vi.fn(async () => {});
  const owner = createInvestigationDelivery({
    turn: fixture.value,
    sourceMessageIds: ["source"],
    resolvePermalink: async () => "https://example.slack.com/archives/C1/p1000000000000000",
    annotateAcceptedFinal,
    reportError: vi.fn(),
    deliver: vi.fn(async () => ({ visibleReplySent: true, messageIds: ["accepted-receipt"] })),
  });
  await owner.deliver({ text: "compact: Done" }, { kind: "final" });
  expect(annotateAcceptedFinal).toHaveBeenCalledWith(
    expect.objectContaining({
      messageId: "accepted-receipt",
      text: expect.stringContaining("compact: the final was delivered"),
    }),
  );
  expect(await fs.readFile(fixture.filePath + ".retained", "utf8")).toBe(serializeCatalog([]));
});

it("constructs an unbound discovery tool without an agent or turn", async () => {
  install();
  const fixture = await turn("oncall");
  expect(() =>
    createInvestigationRecordTool({ ...fixture.ctx, agentId: undefined, toolBindings: {} }),
  ).not.toThrow();
});

it.each(["unchanged", "changed-text", "changed-card"] as const)(
  "annotates only unchanged accepted content when no queued report was prepared (%s)",
  async (change) => {
    install();
    const fixture = await turn("oncall");
    fixture.value.reportExpected = true;
    const annotateAcceptedFinal = vi.fn();
    const owner = createInvestigationDelivery({
      turn: fixture.value,
      sourceMessageIds: ["source"],
      resolvePermalink: vi.fn(),
      annotateAcceptedFinal,
      reportError: vi.fn(),
      deliver: vi.fn(async () => ({ visibleReplySent: true })),
    });
    const projected = owner.queuedCorrelation?.prepareReply?.(
      { text: "**Finding:** Unprepared final" },
      { kind: "final" },
    );
    const accepted = structuredClone(projected!);
    if (change === "changed-text") {
      accepted.text = "Policy replacement";
    }
    if (change === "changed-card") {
      accepted.channelData = { slack: { blocks: [{ type: "divider" }] } };
    }
    await owner.queuedCorrelation?.onReplyDelivered?.(accepted, {
      kind: "final",
      complete: true,
      messageId: "1000000000.000000",
    });
    expect(
      (await readCatalog({ filePath: fixture.filePath, scope: fixture.scope })).issues,
    ).toEqual([]);
    if (change === "unchanged") {
      expect(annotateAcceptedFinal).toHaveBeenCalledExactlyOnceWith({
        messageId: "1000000000.000000",
        text: expect.stringContaining("no matching completed record"),
      });
    } else {
      expect(annotateAcceptedFinal).not.toHaveBeenCalled();
    }
  },
);

it.each(["immediate", "queued", "changed", "partial", "no projector", "unauthorized"] as const)(
  "amends one existing case through %s delivery",
  async (mode) => {
    install();
    const f = await turn("oncall");
    const root = "1793000000.000001",
      ts = "1793000001.000001";
    const url = "https://example.slack.com/archives/C1/p1793000001000001?thread_ts=" + root;
    const req = {
      threadId: root,
      messageId: "1793000002.000001",
      text: "I'll own this; make it Medium.",
    };
    await commitInvestigations({
      filePath: f.filePath,
      scope: f.scope,
      updates: [f.update],
      reportUrl: url,
      now: new Date(),
      assertCurrent() {},
    });
    f.value.snapshot = await readCatalog({ filePath: f.filePath, scope: f.scope });
    f.value.amendmentRequest = req;
    const tool = createInvestigationRecordTool(f.ctx);
    await tool.execute("stage", {
      action: "amend_current_report",
      changes: { priority: "Medium", acceptOwnership: true },
    });
    const payload = { text: f.value.amendment!.finalText };
    const original = { text: "existing report", blocks: [], attachments: [] };
    const projectedChanges: ReportAmendment[] = [];
    const amend = vi.fn<NonNullable<AgentReportProfile["amend"]>>((content, changes) => {
      projectedChanges.push({ ...changes });
      changes.priority = "High";
      return content;
    });
    f.value.reportProfile = {
      ...f.value.reportProfile!,
      amend: mode === "no projector" ? undefined : amend,
    };
    if (mode === "unauthorized") {
      f.value.amendmentRequest = { ...req, text: "I'll own this; make it High." };
    }
    const amendOwnReport = vi.fn<NonNullable<ReplyTurnDeliveryHost["amendOwnReport"]>>(
      async (edit) => {
        edit.project(original);
        return ts;
      },
    );
    const send = vi.fn(async () => ({ visibleReplySent: true }));
    const reportError = vi.fn();
    const owner = createInvestigationDelivery({
      turn: f.value,
      sourceMessageIds: [root, req.messageId],
      amendOwnReport,
      resolvePermalink: vi.fn(),
      reportError,
      annotateAcceptedFinal: vi.fn(),
      deliver: send,
    });
    if (mode === "immediate" || mode === "no projector" || mode === "unauthorized") {
      await owner.deliver(payload, { kind: "final" });
    } else {
      owner.queuedCorrelation!.prepareReply!(payload, { kind: "final" });
      await owner.queuedCorrelation!.onReplyDelivered!(
        mode === "changed" ? { text: "Policy replacement" } : payload,
        { kind: "final", complete: mode !== "partial", messageId: "1793000003.000001" },
      );
    }
    const applied = mode === "immediate" || mode === "queued";
    expect(amendOwnReport).toHaveBeenCalledTimes(applied ? 1 : 0);
    if (applied) {
      expect(amendOwnReport.mock.calls[0]?.[0]).toMatchObject({ url });
      expect(amend).toHaveBeenCalledWith(original, expect.any(Object), "U1");
      expect(projectedChanges).toEqual([{ priority: "Medium", acceptOwnership: true }]);
      expect(send).not.toHaveBeenCalled();
    }
    if (mode === "no projector" || mode === "unauthorized") {
      expect(reportError).toHaveBeenCalledWith(expect.stringContaining("Could not confirm"));
    }
    const issue = (await readCatalog({ filePath: f.filePath, scope: f.scope })).issues[0]!;
    expect(issue.whatWeDidLast).toHaveLength(applied ? 2 : 1);
    if (applied) {
      expect(issue.whatWeDidLast.at(-1)!.facts).toMatchObject({
        priority: "Medium",
        owner: { name: "U1" },
      });
    }
  },
);

it("answers a status question without a report, warning, or write", async () => {
  install();
  const f = await turn("oncall");
  const send = vi.fn(async () => ({ visibleReplySent: true }));
  const owner = createInvestigationDelivery({
    turn: f.value,
    sourceMessageIds: [],
    resolvePermalink: vi.fn(),
    annotateAcceptedFinal: vi.fn(),
    reportError: vi.fn(),
    deliver: send,
  });
  const payload = { text: "The last check found one blocked job." };
  await owner.deliver(payload, { kind: "final" });
  expect(send).toHaveBeenCalledWith(payload, { kind: "final" });
  expect(owner.queuedCorrelation?.prepareReply?.(payload, { kind: "final" })).toBeUndefined();
  expect((await readCatalog({ filePath: f.filePath, scope: f.scope })).issues).toHaveLength(0);
});

it.each(["immediate", "queued", "wrong-thread", "changed-answer", "partial"] as const)(
  "saves an evidence-backed trend on its existing case only after %s delivery",
  async (mode) => {
    install();
    const f = await turn("oncall"),
      request = "1793000003.000001",
      root = "1793000000.000001",
      report = "https://example.slack.com/archives/C1/p1793000001000001",
      answer = "https://example.slack.com/archives/C1/p1793000004000001";
    await commitInvestigations({
      filePath: f.filePath,
      scope: f.scope,
      updates: [f.update],
      reportUrl: report,
      now: new Date(),
      assertCurrent() {},
    });
    f.value.amendmentRequest = { text: "is this increasing?", messageId: request, threadId: root };
    const tool = createInvestigationRecordTool(f.ctx);
    await tool.execute("lookup", { action: "lookup" });
    const original = f.value.snapshot.issues[0]!,
      issueIds = [original.issueId];
    await tool.execute("begin", { action: "begin_trend", issueIds });
    const registry = getInvestigationTurnRegistry(),
      hook = { agentId: "oncall", sessionKey: f.value.sessionKey, runId: "run-A" };
    registry.observeTrendTool(
      {
        toolName: "slack_investigation_record",
        toolCallId: "begin",
        params: { action: "begin_trend" },
      },
      hook,
    );
    const log = (minute: string, n: number) => {
      const start = "2026-01-01T10:" + minute + ":00.000Z",
        end = start.replace("00.000", "59.999");
      const filter =
        'resource.labels.service_name="api" AND timestamp>="' +
        start +
        '" AND timestamp<="' +
        end +
        '"';
      const evidence =
        "https://console.cloud.google.com/logs/query?" +
        new URLSearchParams({ project: "synthetic-prod", query: filter });
      registry.observeTrendTool(
        {
          toolName: "livex_gcp_logs_read",
          params: {},
          result: {
            details: {
              project: "synthetic-prod",
              mode: "errors",
              resourceLabels: { service_name: "api" },
              start,
              end,
              retrievedAt: "2026-01-01T11:00:00Z",
              logsExplorerUrl: evidence,
              entries: Array.from({ length: n }, () => ({
                textPayload: "mapping: missing variant_name",
              })),
              returnedRows: n,
              invalidRows: 0,
              truncationReasons: [],
              truncated: false,
              windowExhausted: true,
              nextCursor: null,
            },
          },
        },
        hook,
      );
      return evidence;
    };
    const args = {
      action: "record_trend",
      issueIds,
      earlierEvidenceUrl: log("00", 2),
      laterEvidenceUrl: log("01", 5),
    };
    await expect(
      tool.execute("forged", { ...args, laterEvidenceUrl: "https://example.org/missing" }),
    ).rejects.toThrow();
    const result = await tool.execute("stage", args);
    const payload = { text: (result.details as { finalText: string }).finalText };
    expect(payload.text).toContain("increased");
    expect(payload.text).not.toMatch(/\*Priority|\*Summary/);
    const send = vi.fn(async () => ({ visibleReplySent: true, messageIds: ["1793000004.000001"] }));
    const annotate = vi.fn();
    const owner = createInvestigationDelivery({
      turn: f.value,
      sourceMessageIds: [root, request],
      resolvePermalink: async () => answer,
      verifyTrendSource: async () => (mode === "wrong-thread" ? undefined : report),
      annotateAcceptedFinal: annotate,
      reportError: vi.fn(),
      deliver: send,
    });
    if (mode === "immediate" || mode === "wrong-thread") {
      await owner.deliver(payload, { kind: "final" });
      expect(send).toHaveBeenCalledWith(payload, { kind: "final" });
    } else {
      const projected = owner.queuedCorrelation!.prepareReply!(payload, { kind: "final" });
      expect(projected).toEqual(payload);
      await owner.queuedCorrelation!.onReplyDelivered!(
        mode === "changed-answer" ? { text: "changed by policy" } : payload,
        { complete: mode !== "partial", kind: "final", messageId: "1793000004.000001" },
      );
    }
    expect(annotate).not.toHaveBeenCalled();
    const saved = mode === "immediate" || mode === "queued";
    const issue = (await readCatalog({ filePath: f.filePath, scope: f.scope })).issues[0]!;
    expect(issue.whatWeDidLast).toHaveLength(saved ? 2 : 1);
    expect(issue.slackThreads).toEqual(original.slackThreads);
    expect(issue.status).toBe(original.status);
    expect(issue.whatWeDidLast.at(-1)?.facts).toEqual(original.whatWeDidLast[0]?.facts);
    if (saved) {
      const nextSession = "agent:oncall:slack:channel:c1:thread:another";
      registry.register({
        id: "next",
        scope: f.scope,
        sessionKey: nextSession,
        filePath: f.filePath,
        snapshot: { ...f.value.snapshot, issues: [] },
        assertCurrent() {},
      });
      const recall = await createInvestigationRecordTool({
        ...f.ctx,
        sessionKey: nextSession,
        toolBindings: { slack_investigation: { turnId: "next" } },
      }).execute("recall", { action: "lookup", issueIds });
      expect(recall.details).toMatchObject({
        issues: [{ lastRecordedTrend: { earlier: { count: 2 }, later: { count: 5 } } }],
      });
    }
  },
);

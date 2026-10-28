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
import type { AgentReportProfile } from "openclaw/plugin-sdk/report-profiles";
import { resolveAgentReportProfile } from "openclaw/plugin-sdk/report-profiles";
import { afterEach, expect, it, vi } from "vitest";
import { createInvestigationDelivery } from "./delivery.js";
import { createInvestigationRecordTool } from "./report-tool.js";
import { closeInvestigationTurnRegistry, getInvestigationTurnRegistry } from "./runtime.js";
import { serializeCatalog, type CompletedInvestigation } from "./schema.js";
import { readCatalog } from "./store.js";

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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPluginRuntimeMock,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginRecord,
  createPluginRegistry,
  disposePluginRegistryInstances,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createReplyTurnDelivery, prepareAgentReplyTurn } from "openclaw/plugin-sdk/reply-turns";
import { resolveAgentReportProfile } from "openclaw/plugin-sdk/report-profiles";
import { expect, it, vi } from "vitest";
import { reportEntry } from "../livex-oncall-reports/test-api.js";
import investigationEntry from "./index.js";
import { getInvestigationTurnRegistry, tryGetInvestigationTurnRegistry } from "./runtime.js";
import { serializeCatalog, type CompletedInvestigation, type HistoryScope } from "./schema.js";
import { readCatalog } from "./store.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as { id: string; contracts: { tools: string[] } };
const scope: HistoryScope = {
  agentId: "oncall",
  accountId: "default",
  teamId: "T1",
  channelId: "C1",
  senderId: "U1",
};
const sessionKey = "agent:oncall:slack:channel:c1";
const context: OpenClawPluginToolContext<2> = {
  agentId: scope.agentId,
  agentAccountId: scope.accountId,
  messageChannel: "slack",
  nativeChannelId: scope.channelId,
  requesterSenderId: scope.senderId,
  sessionKey,
  toolBindings: { slack_investigation: { turnId: "managed-turn" } },
  assertInvocationCurrent() {},
};
const update: CompletedInvestigation = {
  signature: {
    scope,
    service: "api",
    environment: "prod",
    operation: "variant",
    error: "variant_name",
  },
  task: "Variant lookup",
  status: "open",
  historySummary: "Verified variant_name persists",
  waitingOn: "Owner unknown",
  prs: [],
  slackThreads: [],
  jiraTickets: [],
  facts: { finding: "Unknown variant_name", impact: "One job", nextAction: "Fix field mapping" },
  evidenceUrls: [],
};

function createManagedInvestigationOwner(config: OpenClawConfig = {}) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: manifest.id,
    source: fileURLToPath(new URL("./index.ts", import.meta.url)),
    rootDir: fileURLToPath(new URL("./", import.meta.url)),
    origin: "bundled",
    contracts: manifest.contracts,
  });
  builder.registry.plugins.push(record);
  const reportRecord = createPluginRecord({
    id: "livex-oncall-reports",
    source: "/fixture/reports/index.ts",
  });
  builder.registry.plugins.push(reportRecord);
  reportEntry.register(
    builder.createApi(reportRecord, {
      config: {},
      pluginConfig: { agentProfiles: { oncall: "compact-v1" } },
      registrationMode: "tool-discovery",
    }),
  );
  const api = builder.createApi(record, { config, registrationMode: "tool-discovery" });
  investigationEntry.register(api);
  expect(builder.registry.diagnostics).toEqual([]);
  expect(builder.registry.tools).toHaveLength(1);
  expect(builder.registry.tools[0]).toMatchObject({
    pluginId: "livex-investigations",
    names: ["slack_investigation_record"],
    contextVersion: 2,
    optional: true,
  });
  assert(api.lifecycle.runInBackgroundContext);
  return { ...builder, run: api.lifecycle.runInBackgroundContext };
}

it("hands prepared findings to the exact managed investigation owner and refuses unrelated or retired owners", async () => {
  const owner = createManagedInvestigationOwner();
  const unrelated = createManagedInvestigationOwner();
  try {
    // The real ingress preparation is covered separately. Register its host-owned turn
    // through the existing managed lifecycle boundary, without Slack, files or a model.
    const turn = owner.run(() =>
      getInvestigationTurnRegistry().register({
        id: "managed-turn",
        scope,
        sessionKey,
        filePath: "/synthetic/investigations.md",
        snapshot: { status: "ready", scope, revision: "r", issues: [] },
        reportProfile: resolveAgentReportProfile("oncall", "slack"),
        assertCurrent() {},
      }),
    );
    expect(tryGetInvestigationTurnRegistry()?.get("managed-turn")).toBeUndefined();
    expect(unrelated.run(() => getInvestigationTurnRegistry().get("managed-turn"))).toBeUndefined();

    // This is the actual entry's managed registration/factory. The generic framework
    // tool-registry-adoption suite owns resolver/adoption proof; no resolver is mocked here.
    const boundProfile = owner.registry.reportProfiles[0]!;
    owner.registry.reportProfiles[0] = {
      ...boundProfile,
      profile: {
        ...boundProfile.profile,
        inputSchema: {
          type: "object",
          properties: { incompatible: { type: "boolean" } },
          required: ["incompatible"],
        },
      },
    };
    const tool = owner.registry.tools[0]!.factory(context);
    assert(tool && !Array.isArray(tool));
    expect(tool.parameters).toMatchObject({
      properties: {
        report: { required: ["title", "priority", "summary", "nextAction", "evidence"] },
      },
    });
    const foreignTool = unrelated.registry.tools[0]!.factory(context);
    assert(tool && !Array.isArray(tool));
    assert(foreignTool && !Array.isArray(foreignTool));
    const input = { action: "prepare_update", finalText: "Final finding", updates: [update] };
    await expect(foreignTool.execute("foreign", input)).rejects.toThrow(
      /No active Slack investigation turn/,
    );
    expect(await tool.execute("owned", input)).toMatchObject({
      details: { status: "prepared", findings: [{ kind: "new" }] },
    });
    expect(owner.run(() => turn.matchFinal("Final finding"))?.updates).toEqual([update]);
    expect(unrelated.run(() => getInvestigationTurnRegistry().get("managed-turn"))).toBeUndefined();

    await disposePluginRegistryInstances(owner.registry);
    expect(() => tool.execute("retired", input)).toThrow(/reloaded or disabled|no longer active/);
  } finally {
    await Promise.all([
      disposePluginRegistryInstances(owner.registry),
      disposePluginRegistryInstances(unrelated.registry),
    ]);
  }
});

it.each(["immediate", "queued"] as const)(
  "publishes the real managed provider's %s final into its configured catalog",
  async (mode) => {
    const agentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "investigation-provider-"));
    const filePath = path.join(agentDir, "investigations.md");
    await fs.promises.writeFile(filePath, serializeCatalog([]));
    const config: OpenClawConfig = {
      agents: { entries: { oncall: { agentDir, workspace: agentDir } } },
      plugins: {
        entries: {
          "livex-investigations": {
            enabled: true,
            config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
          },
        },
      },
    };
    const owner = createManagedInvestigationOwner(config);
    try {
      // Use the production provider resolver and managed registrar: no synthetic turn,
      // mocked lookup, or private Slack investigation import supplies the binding.
      const turn = await withPluginRuntimeRegistryScope(owner.registry, () =>
        prepareAgentReplyTurn({
          config,
          agentId: scope.agentId,
          channel: "slack",
          accountId: scope.accountId,
          workspaceId: scope.teamId,
          nativeChannelId: scope.channelId,
          senderId: scope.senderId,
          sessionKey,
          isDirectMessage: false,
          query: "Investigate variant_name in api/prod",
          assertCurrent() {},
        }),
      );
      assert(turn);
      expect(turn.context).toContain("Catalog status: ready");
      const tool = owner.registry.tools[0]!.factory({
        ...context,
        toolBindings: turn.toolBindings,
      });
      assert(tool && !Array.isArray(tool));
      const lifecycle = turn.lifecycle();
      if (mode === "queued") {
        lifecycle.onDeferred?.();
        turn.releaseImmediate();
      } else {
        await lifecycle.onAdopted?.();
      }
      const result = await tool.execute("prepare", {
        action: "prepare_update",
        finalText: "Exact legacy acknowledgement",
        updates: [update],
      });
      expect(result).toMatchObject({ details: { status: "prepared", historyStatus: "ready" } });
      expect((await readCatalog({ filePath, scope })).issues).toEqual([]);

      const resolvePermalink = vi.fn(
        async () => "https://example.slack.com/archives/C1/p1000000000000000",
      );
      const deliver = vi.fn(async () => ({
        visibleReplySent: true,
        messageIds: ["1000000000.000000"],
      }));
      const reportError = vi.fn();
      const delivery = createReplyTurnDelivery(turn, {
        sourceMessageIds: ["999999999.000000"],
        resolvePermalink,
        annotateAcceptedFinal: vi.fn(async () => {}),
        reportError,
        deliver,
      });
      if (mode === "queued") {
        const payload = delivery.queuedCorrelation?.prepareReply?.(
          { text: "Exact legacy acknowledgement" },
          { kind: "final" },
        );
        assert(payload);
        expect(payload.text).toContain("Unknown variant_name");
        await delivery.queuedCorrelation?.onReplyDelivered?.(payload, {
          kind: "final",
          messageId: "1000000000.000000",
          complete: true,
        });
        await lifecycle.onSettled?.();
      } else {
        // Model settlement precedes immediate transport; the host cleanup owns final release.
        await lifecycle.onSettled?.();
        await delivery.deliver({ text: "Exact legacy acknowledgement" }, { kind: "final" });
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining("Unknown variant_name"),
            channelData: expect.any(Object),
          }),
          { kind: "final" },
          true,
        );
        turn.releaseImmediate();
      }
      const catalog = await readCatalog({ filePath, scope });
      expect(catalog.status).toBe("ready");
      expect(catalog.issues).toHaveLength(1);
      expect(catalog.issues[0]).toMatchObject({
        signature: update.signature,
        slackThreads: ["https://example.slack.com/archives/C1/p1000000000000000"],
        whatWeDidLast: [expect.objectContaining({ facts: update.facts })],
      });
      expect(resolvePermalink).toHaveBeenCalledExactlyOnceWith("1000000000.000000");
      expect(reportError).not.toHaveBeenCalled();
      await expect(tool.execute("released", { action: "lookup" })).rejects.toThrow(
        /No active Slack investigation turn/,
      );
    } finally {
      await disposePluginRegistryInstances(owner.registry);
      await fs.promises.rm(agentDir, { recursive: true, force: true });
    }
  },
);

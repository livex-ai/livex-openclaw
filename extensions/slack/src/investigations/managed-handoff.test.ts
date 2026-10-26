import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginRecord,
  createPluginRegistry,
  disposePluginRegistryInstances,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import slackEntry from "../../index.js";
import { getInvestigationTurnRegistry, tryGetInvestigationTurnRegistry } from "./runtime.js";
import type { CompletedInvestigation, HistoryScope } from "./schema.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
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

function createManagedSlackOwner() {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: manifest.id,
    source: fileURLToPath(new URL("../../index.ts", import.meta.url)),
    rootDir: fileURLToPath(new URL("../../", import.meta.url)),
    origin: "bundled",
    contracts: manifest.contracts,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, registrationMode: "tool-discovery" });
  slackEntry.register(api);
  expect(builder.registry.diagnostics).toEqual([]);
  expect(builder.registry.tools).toHaveLength(1);
  expect(builder.registry.tools[0]).toMatchObject({
    pluginId: "slack",
    names: ["slack_investigation_record"],
    contextVersion: 2,
    optional: true,
  });
  assert(api.lifecycle.runInBackgroundContext);
  return { ...builder, run: api.lifecycle.runInBackgroundContext };
}

it("hands prepared findings to the exact managed Slack owner and refuses unrelated or retired owners", async () => {
  const owner = createManagedSlackOwner();
  const unrelated = createManagedSlackOwner();
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
        assertCurrent() {},
      }),
    );
    expect(tryGetInvestigationTurnRegistry()?.get("managed-turn")).toBeUndefined();
    expect(unrelated.run(() => getInvestigationTurnRegistry().get("managed-turn"))).toBeUndefined();

    // This is the actual entry's managed registration/factory. The generic framework
    // tool-registry-adoption suite owns resolver/adoption proof; no resolver is mocked here.
    const tool = owner.registry.tools[0]!.factory(context);
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

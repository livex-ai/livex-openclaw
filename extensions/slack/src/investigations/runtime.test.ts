import { describe, expect, it } from "vitest";
import { createInvestigationTurnRegistry } from "./runtime.js";
import type { CatalogSnapshot, CompletedInvestigation, HistoryScope } from "./schema.js";

const scope: HistoryScope = {
  agentId: "oncall",
  accountId: "default",
  teamId: "T1",
  channelId: "C1",
  senderId: "U1",
};
const snapshot: CatalogSnapshot = { status: "ready", scope, revision: "r1", issues: [] };
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
function register(
  registry: ReturnType<typeof createInvestigationTurnRegistry>,
  id: string,
  assertCurrent = () => {},
) {
  return registry.register({
    id,
    scope,
    sessionKey: "agent:oncall:slack:channel:c1",
    filePath: "/tmp/synthetic-investigations.md",
    snapshot,
    assertCurrent,
  });
}

describe("Slack investigation turn handoff", () => {
  it("keeps simultaneous turns separate through serializable bindings", () => {
    const registry = createInvestigationTurnRegistry();
    register(registry, "first");
    register(registry, "second");
    const binding = structuredClone({ turnId: "first" });
    registry.stage(binding.turnId, scope, "final one", [update]);
    expect(registry.matchFinal("second", "final one")).toBeUndefined();
    expect(registry.matchFinal("first", "changed final")).toBeUndefined();
    expect(registry.matchFinal("first", "final one")?.updates).toEqual([update]);
  });
  it("captures staged facts and rejects mismatched scope", () => {
    const registry = createInvestigationTurnRegistry();
    register(registry, "first");
    const input = structuredClone(update);
    registry.stage("first", scope, "final", [input]);
    input.facts.impact = "mutated";
    expect(registry.matchFinal("first", "final")?.updates[0]?.facts.impact).toBe("One job");
    expect(() => registry.stage("first", { ...scope, channelId: "C2" }, "final", [update])).toThrow(
      /scope/,
    );
  });
  it("retains immediate findings after model settlement until final delivery cleanup", async () => {
    const registry = createInvestigationTurnRegistry();
    const turn = register(registry, "first");
    const lifecycle = turn.lifecycle();
    await lifecycle.onAdopted?.();
    registry.stage("first", scope, "final", [update]);

    // The model owner settles before Slack receives the returned final payload.
    await lifecycle.onSettled?.();
    expect(turn.matchFinal("final")?.updates).toEqual([update]);

    turn.releaseImmediate();
    expect(registry.get("first")).toBeUndefined();
    expect(() => turn.matchFinal("final")).toThrow(/active/);
  });
  it("retains deferred turns and releases them only when their owner settles", async () => {
    const registry = createInvestigationTurnRegistry();
    const turn = register(registry, "first");
    const lifecycle = turn.lifecycle();
    lifecycle.onDeferred?.();
    turn.releaseImmediate();
    expect(registry.get("first")).toBeDefined();
    await lifecycle.onSettled?.();
    expect(registry.get("first")).toBeUndefined();
    expect(() => registry.stage("first", scope, "final", [update])).toThrow(/active/);
  });
  it("rechecks current owner authority and retires the whole registry", () => {
    const registry = createInvestigationTurnRegistry();
    let current = true;
    register(registry, "first", () => {
      if (!current) {
        throw new Error("revoked");
      }
    });
    current = false;
    expect(() => registry.stage("first", scope, "final", [update])).toThrow("revoked");
    current = true;
    registry.close();
    expect(() => registry.stage("first", scope, "final", [update])).toThrow(/active/);
  });
});

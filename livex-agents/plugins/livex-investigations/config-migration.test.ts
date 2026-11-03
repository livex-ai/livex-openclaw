import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { migrateInvestigationConfig } from "./config-migration.js";
import { prepareInvestigationUpgrade } from "./upgrade.js";

function legacy(enabled = true): OpenClawConfig {
  return {
    plugins: {
      entries: {
        slack: { enabled: true, config: { investigationCatalog: { enabled, agentId: "oncall" } } },
      },
    },
    logging: { level: "warn" },
  };
}

describe("investigation owner migration", () => {
  it("moves explicit settings without activating a default or mutating the source", () => {
    for (const enabled of [false, true]) {
      const source = legacy(enabled);
      const original = structuredClone(source);
      const result = migrateInvestigationConfig(source)!;
      expect(source).toEqual(original);
      expect(result.config.plugins?.entries?.slack).toEqual({ enabled: true, config: {} });
      expect(result.config.plugins?.entries?.["livex-investigations"]).toEqual({
        config: { investigationCatalog: { enabled, agentId: "oncall" } },
      });
      expect(result.config.logging).toEqual(source.logging);
      expect(migrateInvestigationConfig(result.config)).toBeNull();
      const settings = result.config.plugins?.entries?.["livex-investigations"]?.config
        ?.investigationCatalog as { agentId: string };
      settings.agentId = "candidate-only-edit";
      expect(source).toEqual(original);
    }
    expect(migrateInvestigationConfig({})).toBeNull();
  });

  it("retains matching destination settings and refuses conflicts before changing anything", () => {
    const source = legacy();
    source.plugins!.entries!["livex-investigations"] = {
      enabled: true,
      config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
    };
    expect(
      migrateInvestigationConfig(source)?.config.plugins?.entries?.["livex-investigations"]
        ?.enabled,
    ).toBe(true);
    source.plugins!.entries!["livex-investigations"]!.config = {
      investigationCatalog: { enabled: true, agentId: "another" },
    };
    const original = structuredClone(source);
    expect(() => migrateInvestigationConfig(source)).toThrow(/conflict/);
    expect(source).toEqual(original);
  });

  it("refuses denied, disabled and unallowlisted destinations for an enabled legacy catalog", () => {
    for (const policy of [
      { deny: ["livex-investigations"] },
      { allow: ["slack"] },
      { entries: { "livex-investigations": { enabled: false } } },
    ]) {
      const source = legacy();
      source.plugins = {
        ...source.plugins,
        ...policy,
        entries: { ...source.plugins!.entries, ...("entries" in policy ? policy.entries : {}) },
      };
      const original = structuredClone(source);
      expect(() => migrateInvestigationConfig(source)).toThrow(/denied|disabled|Allow/);
      expect(source).toEqual(original);
    }
    const disabled = legacy(false);
    disabled.plugins!.entries!["livex-investigations"] = { enabled: false };
    expect(
      migrateInvestigationConfig(disabled)?.config.plugins?.entries?.["livex-investigations"]
        ?.enabled,
    ).toBe(false);
  });

  it("preserves wildcard owner denials globally and in nested scopes without widening wildcard grants", () => {
    const source = legacy();
    const tool = "slack_investigation_record";
    source.tools = {
      allow: ["*"],
      deny: ["*lack"],
      byProvider: { example: { allow: ["*lack"], deny: [" S*ACK "] } },
      sandbox: { tools: { allow: ["*"], deny: ["s*a*c*k"] } },
      subagents: { tools: { deny: ["slac*"] } },
    };
    source.agents = {
      entries: { oncall: { tools: { allow: ["*lack"], alsoAllow: ["s*"], deny: ["*ACK"] } } },
    };
    source.channels = {
      slack: {
        accounts: {
          oncall: {
            channels: {
              C1: {
                tools: { deny: ["sl*ck"] },
                toolsBySender: { "id:sender": { deny: ["*lack"] } },
              },
            },
          },
        },
      },
    };
    const original = structuredClone(source);
    const migrated = migrateInvestigationConfig(source)!;
    const next = migrated.config;
    expect(source).toEqual(original);
    expect(next.tools?.allow).toEqual(["*"]);
    expect(next.tools?.deny).toEqual(["*lack", tool]);
    expect(next.tools?.byProvider?.example).toEqual({ allow: ["*lack"], deny: [" S*ACK ", tool] });
    expect(next.tools?.sandbox?.tools?.deny).toEqual(["s*a*c*k", tool]);
    expect(next.tools?.subagents?.tools?.deny).toEqual(["slac*", tool]);
    expect(next.agents?.entries?.oncall?.tools).toEqual({
      allow: ["*lack"],
      alsoAllow: ["s*"],
      deny: ["*ACK", tool],
    });
    expect(next.channels?.slack?.accounts?.oncall?.channels?.C1?.tools?.deny).toEqual([
      "sl*ck",
      tool,
    ]);
    expect(
      next.channels?.slack?.accounts?.oncall?.channels?.C1?.toolsBySender?.["id:sender"]?.deny,
    ).toEqual(["*lack", tool]);
    expect(migrateInvestigationConfig(next)).toBeNull();
    for (const pattern of ["slac?", "[s]lack", "slack+", "other*", "*slack*"]) {
      const candidate = legacy();
      candidate.tools = { allow: ["*"], deny: [pattern] };
      expect(migrateInvestigationConfig(candidate)?.config.tools?.deny).toEqual(
        pattern === "*slack*" ? [pattern, tool] : [pattern],
      );
    }
  });

  it("preserves grants and denials at supported tool-policy layers without modifying unrelated arrays", () => {
    const source = legacy();
    source.tools = {
      allow: ["slack", "read"],
      deny: ["slack"],
      byProvider: { example: { alsoAllow: ["SLACK"] } },
      toolsBySender: { "id:sender": { deny: ["slack"] } },
      sandbox: { tools: { allow: ["slack"] } },
      subagents: { tools: { deny: ["slack"] } },
      agentToAgent: { allow: ["slack"] },
    };
    source.agents = {
      entries: {
        oncall: { tools: { alsoAllow: ["slack"], sandbox: { tools: { deny: ["slack"] } } } },
      },
    };
    source.channels = {
      slack: {
        channels: {
          C1: { tools: { allow: ["slack"] }, toolsBySender: { "id:sender": { deny: ["slack"] } } },
        },
        accounts: { oncall: { channels: { C2: { tools: { deny: ["slack"] } } } } },
      },
    };
    const next = migrateInvestigationConfig(source)!.config;
    const tool = "slack_investigation_record";
    expect(next.tools?.allow).toEqual(["slack", "read", tool]);
    expect(next.tools?.deny).toEqual(["slack", tool]);
    expect(next.tools?.byProvider?.example?.alsoAllow).toEqual(["SLACK", tool]);
    expect(next.tools?.toolsBySender?.["id:sender"]?.deny).toEqual(["slack", tool]);
    expect(next.tools?.sandbox?.tools?.allow).toEqual(["slack", tool]);
    expect(next.tools?.subagents?.tools?.deny).toEqual(["slack", tool]);
    expect(next.tools?.agentToAgent?.allow).toEqual(["slack"]);
    expect(next.agents?.entries?.oncall?.tools?.alsoAllow).toEqual(["slack", tool]);
    expect(next.channels?.slack?.accounts?.oncall?.channels?.C2?.tools?.deny).toEqual([
      "slack",
      tool,
    ]);
  });
});

describe("source-only investigation discovery", () => {
  it("appends the source path and requires explicit review of an equivalent allowlist grant", () => {
    const source = legacy();
    source.plugins!.load = { paths: ["/existing/plugin"] };
    source.plugins!.allow = ["slack", "existing"];
    expect(() => prepareInvestigationUpgrade(source, "/new/investigations")).toThrow(/Allow/);
    const prepared = prepareInvestigationUpgrade(source, "/new/investigations", {
      allowPlugin: true,
    });
    expect(prepared.config.plugins?.load?.paths).toEqual([
      "/existing/plugin",
      "/new/investigations",
    ]);
    expect(prepared.config.plugins?.allow).toEqual(["slack", "existing", "livex-investigations"]);
    expect(prepared.config.plugins?.entries?.slack?.config?.investigationCatalog).toEqual({
      enabled: true,
      agentId: "oncall",
    });
    expect(source.plugins?.allow).toEqual(["slack", "existing"]);
    expect(prepareInvestigationUpgrade(prepared.config, "/new/investigations").changes).toEqual([]);
  });

  it("preserves unconfigured defaults and refuses policy overrides even with the grant flag", () => {
    const prepared = prepareInvestigationUpgrade({}, "/new/investigations");
    expect(prepared.config.plugins?.entries).toBeUndefined();
    expect(prepared.config.plugins?.allow).toBeUndefined();
    expect(() =>
      prepareInvestigationUpgrade({}, "/new/investigations", { allowPlugin: true }),
    ).toThrow(/explicitly enabled/);
    const denied = legacy();
    denied.plugins!.deny = ["livex-investigations"];
    expect(() =>
      prepareInvestigationUpgrade(denied, "/new/investigations", { allowPlugin: true }),
    ).toThrow(/denied/);
  });
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveInvestigationCatalogPath, investigationPluginConfigSchema } from "./config.js";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveAgentDir: (_cfg: unknown, agentId: string) => `/synthetic/agents/${agentId}/agent`,
}));

describe("optional investigation catalog configuration", () => {
  it("declares the catalog tool to the real plugin registrar", async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    );
    expect(manifest.contracts?.tools).toContain("slack_investigation_record");
  });
  it("is off unless the exact routed agent is explicitly selected", () => {
    expect(resolveInvestigationCatalogPath({}, "oncall")).toBeNull();
    const cfg: OpenClawConfig = {
      plugins: {
        entries: {
          "livex-investigations": {
            config: {
              investigationCatalog: { enabled: true, agentId: "oncall" },
            },
          },
        },
      },
    };
    expect(resolveInvestigationCatalogPath(cfg, "debugger")).toBeNull();
    expect(resolveInvestigationCatalogPath(cfg, "oncall")).toBe(
      "/synthetic/agents/oncall/agent/investigations.md",
    );
  });
  it("rejects caller-selected paths or extra capability settings", () => {
    expect(
      investigationPluginConfigSchema.safeParse?.({
        investigationCatalog: {
          enabled: true,
          agentId: "oncall",
          path: "/unrelated/secret.md",
        },
      }),
    ).toMatchObject({ success: false });
    expect(
      investigationPluginConfigSchema.safeParse?.({
        investigationCatalog: {
          enabled: true,
        },
      }),
    ).toMatchObject({ success: false });
  });
});
import fs from "node:fs/promises";

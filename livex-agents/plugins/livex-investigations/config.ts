import path from "node:path";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { investigationConfigSchema } from "./config-schema.js";

export { investigationPluginConfigSchema } from "./config-schema.js";

export function resolveInvestigationAgentId(cfg: OpenClawConfig): string | null {
  const parsed = investigationConfigSchema.safeParse(
    resolvePluginConfigObject(cfg, "livex-investigations") ?? {},
  );
  return parsed.success && parsed.data.investigationCatalog?.enabled === true
    ? (parsed.data.investigationCatalog.agentId ?? null)
    : null;
}

/** The operator selects an agent, never a model-supplied host path. */
export function resolveInvestigationCatalogPath(
  cfg: OpenClawConfig,
  agentId: string,
): string | null {
  return resolveInvestigationAgentId(cfg) === agentId
    ? path.join(resolveAgentDir(cfg, agentId), "investigations.md")
    : null;
}

import path from "node:path";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
const source = z.strictObject({
  investigationCatalog: z
    .strictObject({
      enabled: z.boolean().optional(),
      agentId: z.string().trim().min(1).max(64).optional(),
    })
    .refine((entry) => entry.enabled !== true || Boolean(entry.agentId), {
      message: "An enabled investigation catalog requires an explicit agentId.",
    })
    .optional(),
});
export const slackInvestigationPluginConfigSchema = buildPluginConfigSchema(source);
/** The operator selects an agent, never a model-supplied host path. */
export function resolveInvestigationCatalogPath(
  cfg: OpenClawConfig,
  agentId: string,
): string | null {
  const parsed = source.safeParse(resolvePluginConfigObject(cfg, "slack") ?? {});
  if (
    !parsed.success ||
    parsed.data.investigationCatalog?.enabled !== true ||
    parsed.data.investigationCatalog.agentId !== agentId
  ) {
    return null;
  }
  return path.join(resolveAgentDir(cfg, agentId), "investigations.md");
}

import { buildPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";

export const investigationCatalogSettingsSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    agentId: z.string().trim().min(1).max(64).optional(),
  })
  .refine((entry) => entry.enabled !== true || Boolean(entry.agentId), {
    message: "An enabled investigation catalog requires an explicit agentId.",
  });

export const investigationConfigSchema = z.strictObject({
  investigationCatalog: investigationCatalogSettingsSchema.optional(),
});

export const investigationPluginConfigSchema = buildPluginConfigSchema(investigationConfigSchema);

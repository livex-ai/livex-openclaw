import { buildPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { createOncallReportProfile } from "./profile.js";
const config = z
  .object({ agentProfiles: z.record(z.string().min(1).max(64), z.literal("compact-v1")) })
  .strict();
export default {
  id: "livex-oncall-reports",
  name: "LiveX oncall reports",
  configSchema: buildPluginConfigSchema(config),
  register(api: OpenClawPluginApi) {
    const selected = config.parse(api.pluginConfig ?? { agentProfiles: {} });
    const agentIds = Object.keys(selected.agentProfiles);
    if (agentIds.length) {
      api.registerReportProfile(createOncallReportProfile(agentIds));
    }
  },
};

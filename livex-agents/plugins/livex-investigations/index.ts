import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { investigationPluginConfigSchema, resolveInvestigationAgentId } from "./config.js";
import { createInvestigationRecordTool } from "./report-tool.js";
import { closeInvestigationTurnRegistry } from "./runtime.js";
import { prepareInvestigationReplyTurn } from "./turn.js";

export default {
  id: "livex-investigations",
  name: "LiveX investigations",
  configSchema: investigationPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    api.registerTool(
      { contextVersion: 2, create: createInvestigationRecordTool },
      { names: ["slack_investigation_record"], optional: true },
    );
    const agentId = resolveInvestigationAgentId(api.config);
    if (agentId) {
      api.registerReplyTurnProvider({
        id: "livex-investigations",
        agentIds: [agentId],
        channels: ["slack"],
        prepare: prepareInvestigationReplyTurn,
      });
    }
    api.lifecycle.registerRuntimeLifecycle({
      id: "livex-investigation-turns",
      cleanup: ({ reason, sessionKey, runId }) => {
        if (!sessionKey && !runId && (reason === "disable" || reason === "restart")) {
          closeInvestigationTurnRegistry();
        }
      },
    });
  },
};

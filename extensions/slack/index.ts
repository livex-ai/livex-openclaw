import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { createInvestigationRecordTool } from "./src/investigations/report-tool.js";
import { closeInvestigationTurnRegistry } from "./src/investigations/runtime.js";

export default defineBundledChannelEntry({
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  importMetaUrl: import.meta.url,
  registerFull(api) {
    api.registerTool(
      { contextVersion: 2, create: createInvestigationRecordTool },
      { names: ["slack_investigation_record"], optional: true },
    );
    api.lifecycle.registerRuntimeLifecycle({
      id: "slack-investigation-turns",
      cleanup: ({ reason, sessionKey, runId }) => {
        if (!sessionKey && !runId && (reason === "disable" || reason === "restart")) {
          closeInvestigationTurnRegistry();
        }
      },
    });
  },
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "slackPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setSlackRuntime",
  },
  accountInspect: {
    specifier: "./account-inspect-api.js",
    exportName: "inspectSlackReadOnlyAccount",
  },
});

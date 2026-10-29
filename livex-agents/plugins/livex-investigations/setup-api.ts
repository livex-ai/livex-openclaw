import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { migrateInvestigationConfig } from "./config-migration.js";

export default definePluginEntry({
  id: "livex-investigations",
  name: "LiveX investigation setup",
  description: "Moves legacy catalog settings through Doctor's config publication flow.",
  register(api) {
    api.registerConfigMigration(migrateInvestigationConfig);
  },
});

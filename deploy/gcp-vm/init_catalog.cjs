// Run inside the candidate CLI container with the Gateway's uid and state mount.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");

function initialize(config, stateDir, resolveAgentDir) {
  const id = "livex-investigations";
  const plugins = config.plugins ?? {};
  const plugin = plugins.entries?.[id];
  const owner = plugin?.config?.investigationCatalog;
  if (
    plugins.enabled === false ||
    plugin?.enabled === false ||
    plugins.deny?.includes(id) ||
    (plugins.allow?.length && !plugins.allow.includes(id)) ||
    owner?.enabled !== true ||
    owner.agentId !== "oncall"
  ) {
    return "disabled";
  }

  const dir = resolveAgentDir(config, "oncall");
  if (!dir.startsWith(path.resolve(stateDir) + path.sep) || fs.realpathSync(dir) !== dir) {
    throw new Error("Expected an existing oncall directory inside the persistent state mount");
  }
  const catalog = path.join(dir, "investigations.md");
  function existing() {
    const file = fs.lstatSync(catalog, { throwIfNoEntry: false });
    if (file && !file.isFile()) {
      throw new Error("Expected a regular investigation catalog");
    }
    return Boolean(file);
  }
  if (existing()) {
    return "preserved";
  }

  const temporary = path.join(dir, ".init-catalog-" + randomUUID());
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(
        fd,
        "# Investigation catalog\n\n<!-- openclaw-investigations:v1 -->\n\n## Investigations\n",
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporary, catalog);
    } catch (error) {
      if (error.code === "EEXIST" && existing()) {
        return "preserved";
      }
      throw error;
    }
    return "initialized";
  } finally {
    fs.unlinkSync(temporary);
  }
}

function initializeOncallCatalog() {
  const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  const resolveDir = (cfg, agent) =>
    createRequire("/app/package.json")("openclaw/plugin-sdk/agent-runtime").resolveAgentDir(
      cfg,
      agent,
    );
  console.log(initialize(config, process.env.OPENCLAW_STATE_DIR, resolveDir));
}

module.exports = { initialize, initializeOncallCatalog };

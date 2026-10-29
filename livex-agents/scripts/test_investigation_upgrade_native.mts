import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

// Exercise the shipped CLI, real manifest discovery and actual setup entry without
// a Gateway, model, credentials or access to an operator's configured state.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const plugin = path.join(root, "livex-agents/plugins/livex-investigations");
const temp = await mkdtemp(path.join(os.tmpdir(), "investigation-upgrade-native-"));
const env = {
  ...process.env,
  HOME: temp,
  OPENCLAW_HOME: temp,
  OPENCLAW_STATE_DIR: path.join(temp, "state"),
  OPENCLAW_CONFIG_PATH: path.join(temp, "unused-live-config.json"),
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "extensions"),
};
const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);
try {
  await mkdir(env.OPENCLAW_STATE_DIR);
  await mkdir(path.join(temp, "agent"));
  const catalogPath = path.join(temp, "agent/investigations.md");
  const catalogBytes = "# Synthetic retained catalog\n\nExact pre-migration bytes.\n";
  await writeFile(catalogPath, catalogBytes, { mode: 0o600 });
  const { runPluginSetupConfigMigrations } = await import("../../src/plugins/setup-registry.js");
  const { createToolPolicyMatcher } = await import("../../src/agents/tool-policy-match.js");
  const { validateConfigObjectWithPlugins } = await import("../../src/config/validation.js");
  const { loadPluginMetadataSnapshot } =
    await import("../../src/plugins/plugin-metadata-snapshot.js");
  const { resolveInvestigationCatalogPath } =
    await import("../plugins/livex-investigations/config.js");
  const source: OpenClawConfig = {
    plugins: {
      allow: ["slack"],
      load: { paths: [] },
      entries: {
        slack: {
          enabled: true,
          config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
        },
      },
    },
    agents: {
      entries: {
        oncall: {
          agentDir: path.join(temp, "agent"),
          workspace: path.join(temp, "workspace"),
          tools: { allow: ["slack", "read"], deny: ["*ACK", "write"] },
        },
      },
    },
    tools: { allow: ["*"], deny: ["*lack"] },
    logging: { level: "warn" },
  };
  const input = path.join(temp, "snapshot.json");
  const output = path.join(temp, "discovery.json");
  const bytes = JSON.stringify(source, null, 2) + "\n";
  await writeFile(input, bytes, { mode: 0o600 });
  const cli = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", path.join(plugin, "prepare-upgrade.mts"), ...args],
      { cwd: root, env, encoding: "utf8", timeout: 90_000 },
    );
  const run = cli(["--source", input, "--output", output]);
  assert.notEqual(
    run.status,
    0,
    "an enabled legacy catalog needs review before extending an existing allowlist",
  );
  await assert.rejects(stat(output), { code: "ENOENT" });
  const approved = cli(["--source", input, "--output", output, "--allow-plugin"]);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const prepared: OpenClawConfig = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(prepared.plugins?.load?.paths, [plugin]);
  assert.deepEqual(prepared.plugins?.allow, ["slack", "livex-investigations"]);
  assert.deepEqual(
    prepared.plugins?.entries,
    source.plugins?.entries,
    "bootstrap prepares discovery; Doctor owns migration",
  );
  const candidateBytes = await readFile(output, "utf8");
  assert.notEqual(cli(["--source", input, "--output", output, "--allow-plugin"]).status, 0);
  assert.equal(
    await readFile(output, "utf8"),
    candidateBytes,
    "existing output is never overwritten",
  );
  assert.notEqual(cli(["--source", input]).status, 0);
  await assert.rejects(stat(env.OPENCLAW_CONFIG_PATH), { code: "ENOENT" });

  const validate = (config: OpenClawConfig) =>
    validateConfigObjectWithPlugins(config, {
      env,
      loadPluginMetadataSnapshot: (candidate) =>
        loadPluginMetadataSnapshot({
          config: candidate,
          env,
          stateDir: env.OPENCLAW_STATE_DIR,
          allowCurrent: false,
          preferPersisted: false,
        }),
    });
  assert.equal(
    validate(prepared).ok,
    false,
    "strict Slack schema rejects the legacy key before Doctor",
  );
  const migrated = runPluginSetupConfigMigrations({ config: prepared, env, workspaceDir: temp });
  assert.equal(migrated.warnings, undefined);
  assert.ok(
    migrated.changes.some((change) => change.includes("investigationCatalog")),
    "real setup entry must run",
  );
  assert.equal(migrated.config.plugins?.entries?.slack?.config?.investigationCatalog, undefined);
  assert.deepEqual(
    migrated.config.plugins?.entries?.["livex-investigations"]?.config?.investigationCatalog,
    { enabled: true, agentId: "oncall" },
  );
  assert.deepEqual(migrated.config.agents?.entries?.oncall?.tools?.allow, [
    "slack",
    "read",
    "slack_investigation_record",
  ]);
  assert.deepEqual(migrated.config.tools?.deny, ["*lack", "slack_investigation_record"]);
  assert.deepEqual(migrated.config.tools?.allow, ["*"]);
  assert.deepEqual(migrated.config.agents?.entries?.oncall?.tools?.deny, [
    "*ACK",
    "write",
    "slack_investigation_record",
  ]);
  // The old owner is denied while the unchanged tool name alone was not. After
  // extraction, the carried denial must still suppress it through the real matcher.
  assert.equal(createToolPolicyMatcher(source.tools)("slack"), false);
  assert.equal(createToolPolicyMatcher(source.tools)("slack_investigation_record"), true);
  assert.equal(createToolPolicyMatcher(migrated.config.tools)("slack_investigation_record"), false);
  assert.equal(
    createToolPolicyMatcher(migrated.config.agents?.entries?.oncall?.tools)(
      "slack_investigation_record",
    ),
    false,
  );
  assert.equal(migrated.config.logging?.level, "warn");
  assert.equal(
    resolveInvestigationCatalogPath(migrated.config, "oncall"),
    path.join(temp, "agent/investigations.md"),
  );
  assert.equal(resolveInvestigationCatalogPath(migrated.config, "other"), null);
  const checked = validate(migrated.config);
  assert.equal(checked.ok, true, checked.ok ? undefined : JSON.stringify(checked.issues));
  assert.deepEqual(
    runPluginSetupConfigMigrations({ config: migrated.config, env, workspaceDir: temp }),
    { config: migrated.config, changes: [] },
  );
  assert.equal(await readFile(input, "utf8"), bytes);
  assert.equal(await readFile(catalogPath, "utf8"), catalogBytes);

  for (const enabled of [false, undefined]) {
    const config = structuredClone(prepared);
    config.plugins!.entries!.slack!.config =
      enabled === undefined ? {} : { investigationCatalog: { enabled: false, agentId: "oncall" } };
    const result = runPluginSetupConfigMigrations({ config, env, workspaceDir: temp });
    assert.equal(resolveInvestigationCatalogPath(result.config, "oncall"), null);
    assert.equal(validate(result.config).ok, true);
  }
  const conflict = structuredClone(prepared);
  conflict.plugins!.entries!["livex-investigations"] = {
    config: { investigationCatalog: { enabled: true, agentId: "other" } },
  };
  const before = structuredClone(conflict);
  const rejected = runPluginSetupConfigMigrations({ config: conflict, env, workspaceDir: temp });
  assert.deepEqual(rejected.config, before);
  assert.deepEqual(conflict, before);
  assert.ok(rejected.warnings?.some((warning) => warning.includes("conflict")));
  const conflictInput = path.join(temp, "conflict.json");
  const conflictOutput = path.join(temp, "conflict-output.json");
  await writeFile(conflictInput, JSON.stringify(conflict), { mode: 0o600 });
  assert.notEqual(cli(["--source", conflictInput, "--output", conflictOutput]).status, 0);
  await assert.rejects(stat(conflictOutput), { code: "ENOENT" });
  console.log(
    "Native investigation bootstrap, setup discovery, Doctor migration, strict validation, policy/path/default preservation and private non-overwrite checks passed.",
  );
} finally {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(temp, { recursive: true, force: true });
}

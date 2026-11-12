// Idempotent release apply, run inside the cli container as the node user:
//   node /opt/livex-native/deploy/apply.mjs
// remote.sh runs `openclaw config validate` afterwards and aborts the cutover on failure.
//
// It (1) backs up openclaw.json once per release, (2) makes sure the external
// slack/codex plugins exist, (3) deep-merges config/openclaw.fragment.json5
// into openclaw.json WITHOUT resolving ${VARS} (OpenClaw resolves them from the
// container env at runtime), and (4) copies each agent's AGENTS.md and skills
// into its persistent workspace. It never prints secrets.
//
// Test overrides (defaults are the container paths):
//   LIVEX_NATIVE_DIR, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, LIVEX_JSON5_FROM,
//   LIVEX_OPENCLAW_CMD (the openclaw CLI as "cmd arg ..."), LIVEX_SLACK_TARBALL.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const nativeDir = process.env.LIVEX_NATIVE_DIR ?? "/opt/livex-native";
const stateDir = process.env.OPENCLAW_STATE_DIR ?? "/home/node/.openclaw";
const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
const releaseSha = process.env.LIVEX_RELEASE_SHA ?? "unversioned";
const stageOnly = process.env.LIVEX_STAGE_ONLY === "1";
const slackSpec = process.env.SLACK_PLUGIN_SPEC ?? "";
const slackTarball = process.env.LIVEX_SLACK_TARBALL ?? "/opt/livex-plugins/slack.tgz";
const openclawCmd = (process.env.LIVEX_OPENCLAW_CMD ?? "node /app/openclaw.mjs").split(" ");
const json5 = createRequire(process.env.LIVEX_JSON5_FROM ?? "/app/package.json")("json5");

const GCP_PLUGIN = "livex-gcp-readonly";
const managedPluginIds = [GCP_PLUGIN, "livex-slack-summary"];
const GATEWAY_PORT = 18789;
const priorOncallWildcard = {
  agentId: "oncall",
  match: { channel: "slack", accountId: "default", peer: { kind: "channel", id: "*" } },
};
// Arrays that accumulate (existing entries stay, fragment entries are added once).
// `bindings` is handled separately: see mergeFragmentBindings.
const UNION_ARRAYS = new Set(["plugins.allow", "plugins.load.paths"]);
// Arrays an operator may fill in on the VM; a non-empty existing value is kept.
const KEEP_IF_SET = new Set([`plugins.entries.${GCP_PLUGIN}.config.repositories`]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function merge(base, patch, at = "") {
  if (Array.isArray(patch)) {
    if (UNION_ARRAYS.has(at)) {
      const out = Array.isArray(base) ? [...base] : [];
      for (const item of patch) {
        if (!out.some((existing) => same(existing, item))) out.push(clone(item));
      }
      return out;
    }
    if (KEEP_IF_SET.has(at) && Array.isArray(base) && base.length > 0) return base;
    return clone(patch);
  }
  if (isObject(patch)) {
    const out = isObject(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch)) {
      out[key] = merge(out[key], value, at ? `${at}.${key}` : key);
    }
    return out;
  }
  return patch;
}

// Keep operator bindings in source order. Exact peers beat wildcards in routing;
// for equally specific routes the earlier operator binding keeps precedence.
function mergeFragmentBindings(current, fragment) {
  const shipped = fragment.bindings ?? [];
  const kept = current.filter(
    (binding) => !shipped.some((route) => isDeepStrictEqual(binding, route)),
  );
  return [...kept, ...clone(shipped)];
}

function readJson5(file) {
  return json5.parse(fs.readFileSync(file, "utf8"));
}

function writeConfigAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function runCli(args) {
  const [cmd, ...head] = openclawCmd;
  return spawnSync(cmd, [...head, ...args], { encoding: "utf8", env: process.env });
}

function listedPlugins() {
  const result = runCli(["plugins", "list", "--json"]);
  if (result.status !== 0) throw new Error("`plugins list --json` failed");
  const start = result.stdout.indexOf("{");
  const parsed = JSON.parse(result.stdout.slice(start));
  return new Map((parsed.plugins ?? []).map((plugin) => [plugin.id, plugin]));
}

// codex is bundled in the official image; apply never installs it. Slack ships
// outside the image: the build baked a sha512-verified tarball of the pinned
// version, and this installs that local file whenever Slack is absent or its
// installed version differs from the pin. OpenClaw's managed npm project still
// resolves the package's own dependencies, which may need the network (README).
function ensurePlugins() {
  const pinned = /^@openclaw\/slack@(\d{4}\.\d+\.\d+)$/.exec(slackSpec)?.[1];
  if (!pinned) throw new Error("SLACK_PLUGIN_SPEC must be @openclaw/slack@<exact version>");
  const records = listedPlugins();
  if (!records.has("codex")) {
    throw new Error("codex plugin is missing from the image; refusing to install it from the network");
  }
  console.log("plugin codex: present");
  const have = records.get("slack")?.version;
  if (have === pinned) {
    console.log(`plugin slack: present at ${pinned}`);
    return;
  }
  if (!fs.existsSync(slackTarball)) throw new Error(`Slack plugin tarball missing: ${slackTarball}`);
  console.log(`plugin slack: ${have ?? "absent"} -> ${pinned} (local tarball)`);
  // A local tarball is an unverified source to OpenClaw, so it asks for capability
  // consent even for the official package. The tarball is the sha512-pinned
  // @openclaw/slack build, so consent is given here and the accepted surface is
  // checked below: anything beyond the Slack channel and its skills fails the deploy.
  const result = runCli(["plugins", "install", `npm-pack:${slackTarball}`, "--force", "--accept-capabilities"]);
  if (result.status !== 0) {
    // CLI output carries no secrets; show it so the cause is visible in the deploy log.
    process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    throw new Error(`slack plugin install failed (exit ${result.status})`);
  }
  const after = listedPlugins().get("slack")?.version;
  if (after !== pinned) throw new Error(`slack plugin is ${after ?? "absent"} after install, expected ${pinned}`);
  const inspected = runCli(["plugins", "inspect", "slack", "--json"]);
  if (inspected.status !== 0) throw new Error("`plugins inspect slack --json` failed");
  const info = JSON.parse(inspected.stdout.slice(inspected.stdout.indexOf("{")));
  const capabilities = JSON.stringify(info.capabilities ?? []);
  const surface = info.install?.acceptedSurface ?? {};
  const extra = ["providers", "tools", "contracts", "hooks", "mcpServers", "cliCommands", "cliBackends", "dangerousConfigFlags"]
    .filter((key) => (surface[key] ?? []).length > 0);
  if (capabilities !== '[{"kind":"channel","ids":["slack"]}]' || extra.length > 0) {
    throw new Error(`slack plugin declares more than the Slack channel (capabilities ${capabilities}; extra ${extra.join(",") || "none"}); refusing`);
  }
  console.log("plugin slack: installed, capabilities = Slack channel only");
}

function backupConfig() {
  if (!fs.existsSync(configPath)) return;
  const backup = `${configPath}.pre-${releaseSha}`;
  // First run per release wins, so a re-run never overwrites the pre-release copy.
  if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
}

function agentIds(fragment) {
  const ids = Object.keys(fragment.agents?.entries ?? {});
  return ids.filter((id) => fs.existsSync(path.join(nativeDir, "agents", id, "AGENTS.md")));
}

function workspaceFor(id) {
  return path.join(stateDir, `workspace-${id}`);
}

function hasPriorOncallWorkspace(entry) {
  if (
    entry?.workspace !== workspaceFor("oncall") ||
    entry.name !== "LiveX Debugger" ||
    entry.identity?.name !== "LiveX Reporting · Debugger"
  ) {
    return false;
  }
  const marker = path.join(entry.workspace, "skills", ".livex-shipped");
  return (
    fs.existsSync(marker) &&
    fs.readFileSync(marker, "utf8").split("\n").includes("investigate-alerts")
  );
}

function shadowsDebugger(binding) {
  const { channel, accountId, peer } = binding?.match ?? {};
  const account = accountId?.trim().toLowerCase() ?? "";
  // Routing can canonicalize nonstandard IDs to "default". Only exclude accounts
  // that are already canonical and cannot fall back to it.
  const otherAccount =
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(account) &&
    !["default", "constructor", "prototype"].includes(account);
  return (
    binding?.agentId !== "debugger" &&
    binding?.type !== "acp" &&
    channel?.trim().toLowerCase() === "slack" &&
    !otherAccount &&
    ["channel", "group"].includes(peer?.kind?.trim().toLowerCase()) &&
    peer?.id?.trim() === "*"
  );
}

function prepareConfig(fragment) {
  const current = fs.existsSync(configPath) ? readJson5(configPath) : {};
  let existing = Array.isArray(current.bindings) ? current.bindings : [];
  const debuggerWildcard = { ...priorOncallWildcard, agentId: "debugger" };
  const hasDebuggerDefault = fragment.bindings?.some((binding) =>
    isDeepStrictEqual(binding, debuggerWildcard),
  );
  const retiredOncallWildcard =
    hasDebuggerDefault &&
    !Object.hasOwn(fragment.agents?.entries ?? {}, "oncall") &&
    existing.some((binding) => isDeepStrictEqual(binding, priorOncallWildcard)) &&
    hasPriorOncallWorkspace(current.agents?.entries?.oncall);
  if (retiredOncallWildcard) {
    // Explicit heartbeat, Talk, cron, and other consumers can still use the installed agent.
    existing = existing.filter((binding) => !isDeepStrictEqual(binding, priorOncallWildcard));
  }

  const bindings = mergeFragmentBindings(existing, fragment);
  if (hasDebuggerDefault && bindings.some(shadowsDebugger)) {
    throw new Error(
      "An existing Slack wildcard can shadow the LiveX Debugger default. Review the Slack wildcard bindings for the default account in openclaw.json before retrying.",
    );
  }
  return { current, bindings, retiredOncallWildcard };
}

function applyConfig(fragment, ids) {
  const { current, bindings, retiredOncallWildcard } = prepareConfig(fragment);
  if (retiredOncallWildcard) {
    console.log("config: retired the previous managed OnCall Slack wildcard");
  }
  const { bindings: _bindings, ...fragmentRest } = fragment;
  const next = merge(current, fragmentRest);
  if (bindings.length > 0) next.bindings = bindings;

  next.gateway = merge(next.gateway ?? {}, {
    mode: "local",
    bind: "lan",
    port: GATEWAY_PORT,
    auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
    // The Control UI is reached through an SSH tunnel on these origins.
    controlUi: {
      allowedOrigins: [`http://127.0.0.1:${GATEWAY_PORT}`, `http://localhost:${GATEWAY_PORT}`],
    },
  });

  for (const id of ids) next.agents.entries[id].workspace = workspaceFor(id);

  // Keep one load path per managed plugin from this release.
  const paths = (next.plugins?.load?.paths ?? []).filter(
    (p) => !managedPluginIds.some((id) => p.endsWith(`/plugins/${id}`)),
  );
  for (const id of managedPluginIds) {
    paths.push(path.join(nativeDir, "plugins", id));
  }
  next.plugins ??= {};
  next.plugins.load = { ...next.plugins.load, paths };

  if (stageOnly) {
    // Drop inherited Slack accounts and credentials from staging config.
    next.channels.slack = { enabled: false };
  } else if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    // Documented SecretRef form (docs/channels/slack/setup.md): tokens stay in the env file.
    next.channels.slack = merge(next.channels.slack ?? {}, {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    });
  } else {
    console.log("slack tokens: SLACK_BOT_TOKEN/SLACK_APP_TOKEN not both set; token config skipped");
  }

  writeConfigAtomic(configPath, next);
  const digest = createHash("sha256").update(JSON.stringify(next)).digest("hex");
  console.log(`config: written (${path.basename(configPath)}, sha256 ${digest.slice(0, 16)})`);
}

// Overwrite the tracked files of each release; never touch SOUL/IDENTITY/USER/memory.
function copyWorkspaces(ids) {
  for (const id of ids) {
    const src = path.join(nativeDir, "agents", id);
    const dst = workspaceFor(id);
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(src, "AGENTS.md"), path.join(dst, "AGENTS.md"));
    const skillsSrc = path.join(src, "skills");
    if (fs.existsSync(skillsSrc)) {
      fs.mkdirSync(path.join(dst, "skills"), { recursive: true });
      const shipped = new Set(
        fs.readdirSync(skillsSrc, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
      );
      // Prune only skills an earlier release shipped (recorded in .livex-shipped) and
      // this one no longer does. Operator- or agent-created skills are never touched,
      // and the first deploy with no manifest prunes nothing.
      const manifest = path.join(dst, "skills", ".livex-shipped");
      const before = fs.existsSync(manifest)
        ? fs.readFileSync(manifest, "utf8").split("\n").filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n))
        : [];
      for (const name of before) {
        if (shipped.has(name)) continue;
        fs.rmSync(path.join(dst, "skills", name), { recursive: true, force: true });
        console.log(`workspace ${id}: pruned skill ${name}`);
      }
      fs.writeFileSync(manifest, `${[...shipped].sort().join("\n")}\n`);
      for (const skill of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
        if (!skill.isDirectory()) continue;
        const target = path.join(dst, "skills", skill.name);
        fs.rmSync(target, { recursive: true, force: true });
        fs.cpSync(path.join(skillsSrc, skill.name), target, { recursive: true });
      }
    }
    console.log(`workspace ${id}: ${dst}`);
  }
}

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const fragment = readJson5(path.join(nativeDir, "config", "openclaw.fragment.json5"));
const ids = agentIds(fragment);
// Installing the Slack plugin may write config. Reject existing conflicts before that step.
prepareConfig(fragment);
backupConfig();
ensurePlugins();
applyConfig(fragment, ids);
copyWorkspaces(ids);
console.log(`apply: done for ${releaseSha}`);

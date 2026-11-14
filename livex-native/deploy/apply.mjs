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
//   LIVEX_OPENCLAW_CMD (the openclaw CLI as "cmd arg ..."), LIVEX_SLACK_TARBALL,
//   LIVEX_REPOS_MANIFEST (default: $LIVEX_NATIVE_DIR/repos/manifest.json).
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

// Agents the operator explicitly keeps out of this release's management (LIVE deploys:
// remote.sh forwards LIVEX_UNMANAGED_AGENTS). apply never writes their entry,
// workspace or bindings. Strict (empty) when unset.
function parseUnmanagedAgents(raw) {
  if (!raw) return new Set();
  if (!/^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*)*$/.test(raw) || raw.split(",").length > 5) {
    throw new Error(
      "LIVEX_UNMANAGED_AGENTS must be 1 to 5 comma-separated agent ids like oncall,other (lowercase letters, digits, hyphens).",
    );
  }
  return new Set(raw.split(","));
}
if (process.env.LIVEX_UNMANAGED_AGENTS && process.env.LIVEX_LIVE_GUARD !== "1") {
  throw new Error("LIVEX_UNMANAGED_AGENTS is only valid with LIVEX_LIVE_GUARD=1 (a live deploy).");
}
const unmanagedAgents = parseUnmanagedAgents(process.env.LIVEX_UNMANAGED_AGENTS);

const GCP_PLUGIN = "livex-gcp-readonly";
const managedPluginIds = [GCP_PLUGIN, "livex-slack-summary", "livex-investigations-lite"];
const GATEWAY_PORT = 18789;
// Host-side port the Control UI tunnel uses (remote.sh passes it; 18790 on the live
// install). Defaults to the container port.
const rawHostPort = process.env.LIVEX_HOST_PORT ?? "";
if (rawHostPort && !(/^[1-9][0-9]{0,4}$/.test(rawHostPort) && Number(rawHostPort) <= 65535)) {
  throw new Error("LIVEX_HOST_PORT must be a port number from 1 to 65535.");
}
const HOST_PORT = rawHostPort ? Number(rawHostPort) : GATEWAY_PORT;
// Where the plugins live in the image. Defaults to the release dir; a standalone
// preview run from a temp dir sets LIVEX_PLUGIN_ROOT=/opt/livex-native.
const pluginRoot = process.env.LIVEX_PLUGIN_ROOT ?? nativeDir;
const priorOncallWildcard = {
  agentId: "oncall",
  match: { channel: "slack", accountId: "default", peer: { kind: "channel", id: "*" } },
};
// Arrays that accumulate (existing entries stay, fragment entries are added once).
// `bindings` is handled separately: see mergeFragmentBindings.
const UNION_ARRAYS = new Set(["plugins.allow", "plugins.load.paths"]);
// Arrays an operator may fill in on the VM; a non-empty existing value is kept.
const REPOSITORIES_KEY = `plugins.entries.${GCP_PLUGIN}.config.repositories`;
const KEEP_IF_SET = new Set([REPOSITORIES_KEY]);

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

// Source snapshots (repos/manifest.json, written by `make repos_pin`). Entries with a
// 40-hex commit become `{ id, path: "/repos/<id>", commit }`. With at least one pin the
// list is MANAGED: it replaces whatever the VM has. With none, the VM's list is kept.
function pinnedRepositories() {
  const file = process.env.LIVEX_REPOS_MANIFEST ?? path.join(nativeDir, "repos", "manifest.json");
  if (!fs.existsSync(file)) return [];
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(entries) || entries.length > 64) {
    throw new Error(`${file} must be a JSON array of at most 64 entries.`);
  }
  const seen = new Set();
  const pinned = [];
  for (const entry of entries) {
    const ok =
      isObject(entry) &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(entry.id ?? "") &&
      typeof entry.branch === "string" &&
      /^([0-9a-f]{40})?$/.test(entry.commit ?? "x");
    if (!ok) throw new Error(`${file}: every entry needs a valid id, a branch and a commit that is empty or 40 hex.`);
    if (seen.has(entry.id)) throw new Error(`${file}: duplicate id ${entry.id}.`);
    seen.add(entry.id);
    if (entry.commit) pinned.push({ id: entry.id, path: `/repos/${entry.id}`, commit: entry.commit });
  }
  return pinned;
}
let renderedRepositories = { pinned: [], replaced: undefined };

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

function inspectSlack() {
  const inspected = runCli(["plugins", "inspect", "slack", "--json"]);
  if (inspected.status !== 0) throw new Error("`plugins inspect slack --json` failed");
  return JSON.parse(inspected.stdout.slice(inspected.stdout.indexOf("{")));
}

// A stock install can have the pinned version without the PR #34 backport.
// Compare the local archive's integrity to the managed npm install record.
function ensurePlugins() {
  const pinned = /^@openclaw\/slack@(\d{4}\.\d+\.\d+)$/.exec(slackSpec)?.[1];
  if (!pinned) throw new Error("SLACK_PLUGIN_SPEC must be @openclaw/slack@<exact version>");
  const records = listedPlugins();
  if (!records.has("codex")) {
    throw new Error("codex plugin is missing from the image; refusing to install it from the network");
  }
  console.log("plugin codex: present");
  if (!fs.existsSync(slackTarball)) throw new Error(`Slack plugin tarball missing: ${slackTarball}`);
  const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(slackTarball)).digest("base64")}`;
  const have = records.get("slack")?.version;
  let info = have === pinned ? inspectSlack() : undefined;
  if (info?.install?.integrity !== integrity) {
    console.log(`plugin slack: installing ${pinned} from the release tarball`);
    // OpenClaw asks for capability consent for local archives. Verify the
    // installed identity and accepted surface before using the package.
    const result = runCli(["plugins", "install", `npm-pack:${slackTarball}`, "--force", "--accept-capabilities"]);
    if (result.status !== 0) {
      process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
      throw new Error(`slack plugin install failed (exit ${result.status})`);
    }
    info = inspectSlack();
  }
  if (info.plugin?.version !== pinned || info.install?.integrity !== integrity) {
    throw new Error(`Slack plugin must match release tarball for ${pinned}`);
  }
  const capabilities = JSON.stringify(info.capabilities ?? []);
  const surface = info.install?.acceptedSurface ?? {};
  const extra = ["providers", "tools", "contracts", "hooks", "mcpServers", "cliCommands", "cliBackends", "dangerousConfigFlags"]
    .filter((key) => (surface[key] ?? []).length > 0);
  if (capabilities !== '[{"kind":"channel","ids":["slack"]}]' || extra.length > 0) {
    throw new Error(`slack plugin declares more than the Slack channel (capabilities ${capabilities}; extra ${extra.join(",") || "none"}); refusing`);
  }
  console.log("plugin slack: release tarball verified, capabilities = Slack channel only");
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
    !unmanagedAgents.has("oncall") &&
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

// Pure: reads the current config and returns the config apply would write. No writes.
function buildNextConfig(fragment, ids) {
  const { current, bindings, retiredOncallWildcard } = prepareConfig(fragment);
  if (retiredOncallWildcard) {
    console.log("config: retired the previous managed OnCall Slack wildcard");
  }
  const { bindings: _bindings, ...fragmentRest } = fragment;
  const next = merge(current, fragmentRest);
  if (bindings.length > 0) next.bindings = bindings;

  // Origins for the container port and the host port, added to any the operator
  // already has (existing first, then missing computed ones).
  const existingOrigins = next.gateway?.controlUi?.allowedOrigins;
  const origins = Array.isArray(existingOrigins) ? [...existingOrigins] : [];
  for (const port of new Set([GATEWAY_PORT, HOST_PORT])) {
    for (const host of ["127.0.0.1", "localhost"]) {
      const origin = `http://${host}:${port}`;
      if (!origins.includes(origin)) origins.push(origin);
    }
  }
  next.gateway = merge(next.gateway ?? {}, {
    mode: "local",
    bind: "lan",
    port: GATEWAY_PORT,
    auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
    // The Control UI is reached through an SSH tunnel on these origins.
    controlUi: { allowedOrigins: origins },
  });

  for (const id of ids) next.agents.entries[id].workspace = workspaceFor(id);

  const pinnedRepos = pinnedRepositories();
  if (pinnedRepos.length > 0) {
    const had = current.plugins?.entries?.[GCP_PLUGIN]?.config?.repositories;
    next.plugins ??= {};
    next.plugins.entries ??= {};
    next.plugins.entries[GCP_PLUGIN] ??= {};
    next.plugins.entries[GCP_PLUGIN].config ??= {};
    next.plugins.entries[GCP_PLUGIN].config.repositories = pinnedRepos;
    renderedRepositories = { pinned: pinnedRepos, replaced: Array.isArray(had) ? had.length : 0 };
  }

  // Keep one load path per managed plugin from this release.
  const paths = (next.plugins?.load?.paths ?? []).filter(
    (p) => !managedPluginIds.some((id) => p.endsWith(`/plugins/${id}`)),
  );
  for (const id of managedPluginIds) {
    paths.push(path.join(pluginRoot, "plugins", id));
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
  refuseUnguardedMessageEdit(next);
  return next;
}

// The debugger may edit only its own summary card because the livex-slack-summary
// before_tool_call guard blocks every other edit. Allowing message "edit" without that
// guard loaded would let it edit any message the bot can, so refuse before writing.
const EDIT_GUARD_PLUGIN = "livex-slack-summary";
function refuseUnguardedMessageEdit(next) {
  const scopes = [
    ["tools", next.tools],
    ["agents.defaults", next.agents?.defaults?.tools],
    ...Object.entries(next.agents?.entries ?? {}).map(([id, entry]) => [`agents.entries.${id}`, entry?.tools]),
  ];
  const editors = scopes
    .filter(([, tools]) => {
      const allow = tools?.message?.actions?.allow;
      return Array.isArray(allow) && allow.some((action) => String(action).trim().toLowerCase() === "edit");
    })
    .map(([where]) => where);
  if (editors.length === 0) return;
  const entry = next.plugins?.entries?.[EDIT_GUARD_PLUGIN];
  const allowed = Array.isArray(next.plugins?.allow) && next.plugins.allow.includes(EDIT_GUARD_PLUGIN);
  if (entry && typeof entry === "object" && entry.enabled !== false && allowed) return;
  throw new Error(
    `message action "edit" is allowed for ${editors.join(", ")} but the ${EDIT_GUARD_PLUGIN} plugin that restricts edits ` +
      `to the agent's own summary card is not ${allowed ? "enabled in plugins.entries" : "in plugins.allow"}. ` +
      `Enable it (plugins.allow and plugins.entries["${EDIT_GUARD_PLUGIN}"].enabled) or remove "edit" from tools.message.actions.allow.`,
  );
}

function applyConfig(fragment, ids) {
  const next = buildNextConfig(fragment, ids);
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

// LIVE deploys only (remote.sh sets LIVEX_LIVE_GUARD=1): never drop a LiveX agent that
// is already serving from the live config. apply keeps an agent the fragment no
// longer ships frozen and unmanaged, so refuse instead. LIVEX_CHECK_AGENTS_ONLY=1
// makes remote.sh run just this check, read-only, before it stops anything.
const KNOWN_LIVEX_AGENTS = new Set(["oncall", "debugger"]);
function refuseDroppedLivexAgents(fragment) {
  if (process.env.LIVEX_LIVE_GUARD !== "1" || !fs.existsSync(configPath)) return;
  const shipped = new Set(Object.keys(fragment.agents?.entries ?? {}));
  const conflicting = [...unmanagedAgents].filter((id) => shipped.has(id));
  if (conflicting.length > 0) {
    throw new Error(
      `LIVEX_UNMANAGED_AGENTS lists ${conflicting.join(", ")}, but this release ships and manages it. Remove it from the list ` +
        "(`make deploy_dev` defaults the list to oncall; override with `make deploy_dev LIVEX_UNMANAGED_AGENTS= ...`).",
    );
  }
  const dropped = Object.entries(readJson5(configPath).agents?.entries ?? {})
    .filter(
      ([id, entry]) =>
        !shipped.has(id) &&
        !unmanagedAgents.has(id) &&
        (KNOWN_LIVEX_AGENTS.has(id) ||
          fs.existsSync(
            path.join(entry?.workspace ?? workspaceFor(id), "skills", ".livex-shipped"),
          )),
    )
    .map(([id]) => id);
  if (unmanagedAgents.size > 0) {
    console.log(`live guard: leaving unmanaged agent(s) untouched: ${[...unmanagedAgents].join(", ")}`);
  }
  if (dropped.length > 0) {
    throw new Error(
      `The live config serves LiveX agent(s) ${dropped.join(", ")} that this release does not ship. ` +
        "Deploy a commit that includes them (for example the PR that adds OnCall), or list them in LIVEX_UNMANAGED_AGENTS to leave them untouched.",
    );
  }
}

// ---- read-only preview of what apply would change (secret-safe, deterministic) ----
const SENSITIVE = /token|secret|passw|key|auth|credential|cookie|bearer|webhook|dsn|private|signing/i;
// Values that carry credentials whatever their key is called.
const SENSITIVE_VALUE = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*@|hooks\.slack\.com|^(bearer|basic)\s|xox[a-z]-|xapp-/i;
const SHARED_SETTINGS = /^(plugins\.|channels\.slack\.|tools\.)/;
const PREVIEW_CAP = 80;

function isSecretRef(v) {
  return isObject(v) && "source" in v && "id" in v && ("provider" in v || Object.keys(v).length <= 3);
}
function shortHash(v) {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 8);
}
function show(pathKey, v) {
  if (v === undefined) return "";
  if (SENSITIVE.test(pathKey) || isSecretRef(v)) return "<changed>";
  if (typeof v === "string" && SENSITIVE_VALUE.test(v)) return "<changed>";
  if (Array.isArray(v)) return `[${v.length} items #${shortHash(v)}]`;
  // Objects reach here only on a type change; never print their contents.
  if (isObject(v)) return `{${Object.keys(v).length} keys #${shortHash(v)}}`;
  const text = JSON.stringify(v);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
function collectChanges(a, b, at, out) {
  if (isObject(a) || isObject(b)) {
    const left = isObject(a) ? a : {};
    const right = isObject(b) ? b : {};
    if ((isObject(a) || a === undefined) && (isObject(b) || b === undefined)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) collectChanges(left[key], right[key], at ? `${at}.${key}` : key, out);
      if (keys.length === 0 && a === undefined && b !== undefined && at) out.added.push([at, "{}"]);
      return;
    }
  }
  if (same(a, b)) return;
  if (a === undefined) out.added.push([at, show(at, b)]);
  else if (b === undefined) out.removed.push([at, ""]);
  else out.changed.push([at, `${show(at, a)} -> ${show(at, b)}`]);
}
function printPreview(live, next) {
  const out = { added: [], removed: [], changed: [] };
  collectChanges(live, next, "", out);
  const lines = [];
  for (const [group, label] of [["added", "+"], ["changed", "~"], ["removed", "-"]]) {
    for (const [p, detail] of out[group]) lines.push({ p, text: `${label} ${p}${detail ? (group === "added" ? ` = ${detail}` : `: ${detail}`) : ""}` });
  }
  // One list sorted by path (+ added, ~ changed, - removed), so the output is stable.
  lines.sort((x, y) => (x.p < y.p ? -1 : x.p > y.p ? 1 : 0));
  console.log(
    `preview: apply would change ${lines.length} path(s) in openclaw.json (${out.added.length} added, ${out.changed.length} changed, ${out.removed.length} removed)`,
  );
  for (const line of lines.slice(0, PREVIEW_CAP)) console.log(`  ${line.text}`);
  if (lines.length > PREVIEW_CAP) console.log(`  ... and ${lines.length - PREVIEW_CAP} more`);
  const shared = lines.filter((l) => SHARED_SETTINGS.test(l.p)).map((l) => l.p);
  const who = unmanagedAgents.size > 0 ? [...unmanagedAgents].join(", ") : "unmanaged agents";
  console.log(
    `preview: shared settings ${who} rely on (plugins.*, channels.slack.*, tools.*, incl. plugins.entries.codex.*): ${shared.length} changed`,
  );
  for (const p of shared.slice(0, PREVIEW_CAP)) console.log(`  ${p}`);
  if (shared.length > PREVIEW_CAP) console.log(`  ... and ${shared.length - PREVIEW_CAP} more`);
  if (renderedRepositories.pinned.length > 0) {
    const { pinned, replaced } = renderedRepositories;
    console.log(
      `preview: repositories: ${pinned.length} pinned from the manifest (replaces the ${replaced} the live config lists)`,
    );
    for (const repo of pinned.slice(0, PREVIEW_CAP)) console.log(`  ${repo.id} @ ${repo.commit.slice(0, 12)}`);
  }
  console.log("preview: end (read-only; nothing was written; plugin installs that apply runs first are not reflected)");
}

const fragment = readJson5(path.join(nativeDir, "config", "openclaw.fragment.json5"));
refuseDroppedLivexAgents(fragment);
if (process.env.LIVEX_CHECK_AGENTS_ONLY === "1") {
  // Read-only dry run: run the same config preparation and merge as the real apply
  // (so its refusals surface before anything is stopped), print what would change,
  // and write nothing. Needs only this file and config/openclaw.fragment.json5.
  console.log("agents: live config matches this release's agents");
  const live = fs.existsSync(configPath) ? readJson5(configPath) : {};
  const next = buildNextConfig(fragment, Object.keys(fragment.agents?.entries ?? {}));
  printPreview(live, next);
  process.exit(0);
}
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const ids = agentIds(fragment);
// Installing the Slack plugin may write config. Reject existing conflicts before that step.
prepareConfig(fragment);
backupConfig();
ensurePlugins();
applyConfig(fragment, ids);
copyWorkspaces(ids);
console.log(`apply: done for ${releaseSha}`);

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginId = "livex-gcp-readonly";
const loginRequired =
  /invalid_grant|invalid_rapt|reauthentication|reauth required|does not have any\s+valid credentials|no credentials.*account|no access token could be obtained/i;

async function readSettings(configPath) {
  let current;
  try {
    current = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    throw new Error("Could not read the runtime OpenClaw configuration.");
  }
  const entry = current.plugins?.entries?.[pluginId];
  if (
    current.plugins?.enabled === false ||
    entry?.enabled !== true ||
    (Array.isArray(current.plugins?.allow) && !current.plugins.allow.includes(pluginId))
  ) {
    throw new Error("The local gcloud reader plugin must be enabled before startup.");
  }
  const settings = entry.config;
  if (
    !settings ||
    !["gcloudPath", "cloudSdkConfig"].every(
      (key) =>
        typeof settings[key] === "string" &&
        path.isAbsolute(settings[key]) &&
        !/[\r\n\0]/.test(settings[key]),
    )
  ) {
    throw new Error(
      "Configure absolute gcloudPath and cloudSdkConfig paths in the local gcloud reader plugin.",
    );
  }
  if (
    typeof settings.gcloudAccount !== "string" ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(settings.gcloudAccount)
  ) {
    throw new Error("Configure an explicit gcloudAccount email in the local gcloud reader plugin.");
  }
  if (
    typeof settings.project !== "string" ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(settings.project)
  ) {
    throw new Error("Configure a valid Google Cloud project ID in the local gcloud reader plugin.");
  }
  try {
    await fs.access(settings.gcloudPath, constants.X_OK);
    if (!(await fs.stat(settings.cloudSdkConfig)).isDirectory()) throw new Error();
  } catch {
    throw new Error("The configured gcloud executable or configuration directory is unavailable.");
  }
  return settings;
}

function gcloudEnvironment(settings) {
  return {
    HOME: process.env.HOME ?? "",
    PATH: `${path.dirname(settings.gcloudPath)}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8",
    ...(process.env.TERM ? { TERM: process.env.TERM } : {}),
    CLOUDSDK_CONFIG: settings.cloudSdkConfig,
    CLOUDSDK_CORE_ACCOUNT: settings.gcloudAccount,
    CLOUDSDK_CORE_PROJECT: settings.project,
    CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "true",
    CLOUDSDK_CORE_LOG_HTTP: "false",
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "true",
    CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: "",
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "",
    CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "",
    CLOUDSDK_AUTH_ACCESS_TOKEN: "",
    CLOUDSDK_AUTH_DISABLE_CREDENTIALS: "false",
  };
}

// Credential stdout goes directly to /dev/null. Only bounded diagnostic text is
// inspected in memory to distinguish sign-in failures; it is never returned.
function runGcloud(
  settings,
  args,
  { interactive = false, inspectAuth = false, timeoutMs, killGraceMs },
) {
  return new Promise((resolve) => {
    const child = spawn(settings.gcloudPath, args, {
      env: gcloudEnvironment(settings),
      detached: true,
      stdio: interactive ? "inherit" : ["ignore", "ignore", inspectAuth ? "pipe" : "ignore"],
    });
    let diagnostic = "";
    let stopped = false;
    let killTimer;
    const killGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* Already exited. */
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    };
    const onInterrupt = () => {
      process.exitCode = 130;
      stop();
    };
    const onTerminate = () => {
      process.exitCode = 143;
      stop();
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    const timer = setTimeout(stop, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      diagnostic += chunk.toString();
      if (diagnostic.length > 16384) {
        diagnostic = "";
        stop();
      }
    });
    child.once("error", stop);
    child.once("close", (code) => {
      if (stopped) killGroup("SIGKILL");
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      resolve({
        ok: code === 0 && !stopped,
        needsLogin: !stopped && inspectAuth && code !== 0 && loginRequired.test(diagnostic),
      });
      diagnostic = "";
    });
  });
}

export async function runPreflight({
  configPath,
  checkOnly = false,
  interactive = Boolean(process.stdin.isTTY),
  commandTimeoutMs = 60000,
  loginTimeoutMs = 300000,
  killGraceMs = 1000,
}) {
  const settings = await readSettings(configPath);
  const options = { timeoutMs: commandTimeoutMs, killGraceMs };
  const tokenArgs = [
    "auth",
    "print-access-token",
    settings.gcloudAccount,
    `--account=${settings.gcloudAccount}`,
    "--quiet",
    "--verbosity=error",
  ];
  let auth = await runGcloud(settings, tokenArgs, { ...options, inspectAuth: true });
  if (!auth.ok) {
    if (!auth.needsLogin)
      throw new Error(
        "The gcloud credential check failed. Check connectivity and local gcloud configuration; no sign-in was attempted.",
      );
    if (checkOnly || !interactive)
      throw new Error(
        "Google sign-in is required. Run start-gateway.sh in an interactive terminal.",
      );
    console.log(
      `Google sign-in is required for ${settings.gcloudAccount}. Complete consent in the browser.`,
    );
    const login = await runGcloud(
      settings,
      ["auth", "login", settings.gcloudAccount, "--no-activate", "--brief", "--force"],
      {
        interactive: true,
        timeoutMs: loginTimeoutMs,
        killGraceMs,
      },
    );
    if (!login.ok) throw new Error("Google sign-in did not complete. Gateway was not started.");
    auth = await runGcloud(settings, tokenArgs, { ...options, inspectAuth: true });
    if (!auth.ok)
      throw new Error(
        "The configured account is still unavailable after sign-in. Gateway was not started.",
      );
  }
  const read = await runGcloud(
    settings,
    [
      "logging",
      "read",
      `insertId="openclaw-preflight-${randomUUID()}"`,
      `--account=${settings.gcloudAccount}`,
      `--project=${settings.project}`,
      "--limit=1",
      "--freshness=1m",
      "--format=value(insertId)",
      "--quiet",
      "--verbosity=error",
    ],
    options,
  );
  if (!read.ok)
    throw new Error(
      "Cloud Logging read preflight failed. Check the configured project, Logging API, IAM permissions, and connectivity. Gateway was not started.",
    );
  console.log("gcloud authentication and Cloud Logging read access are ready.");
}

async function main(argv) {
  let configPath;
  let checkOnly = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--config" && argv[index + 1]) configPath = argv[++index];
    else if (argv[index] === "--check") checkOnly = true;
    else throw new Error("Usage: preflight.mjs --config <runtime/openclaw.json> [--check]");
  }
  if (!configPath) throw new Error("Pass --config <runtime/openclaw.json>.");
  await runPreflight({ configPath, checkOnly });
}

if (
  process.argv[1] &&
  (await fs.realpath(process.argv[1]).catch(() => "")) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode ||= 1;
  });
}

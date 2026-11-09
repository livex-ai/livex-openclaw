import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withPluginRuntimeRegistryScope } from "openclaw/plugin-sdk/channel-test-helpers";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { serializeCatalog } from "../../../../livex-agents/plugins/livex-investigations/schema.js";
import { resolvePreparedRunAdmission } from "../../../../src/agents/admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "../../../../src/agents/harness/host-capability.js";
import { loadPreparedInboundPluginRegistry } from "../../../../src/agents/prepared-model-runtime.inbound-registry.js";
import {
  setAppliedRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../../src/config/runtime-snapshot.js";
import {
  createCronServiceWithStateForTest,
  createNoopLogger,
} from "../../../../src/cron/service.test-harness.js";
import { waitForCronRunQueue } from "../../../../src/cron/service/run-queue.js";
import { captureCronSchedulerWakeForTest } from "../../../../src/cron/service/scheduler-actor.test-support.js";
import { createCronScriptRuntime } from "../../../../src/cron/trigger-script.js";
import { createScheduledGatewayRunner } from "../../../../src/gateway/scheduled-run-gateway-context.js";
import type { GatewayRequestContext } from "../../../../src/gateway/server-methods/types.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../../../../src/plugins/legacy-sdk-resource-host.js";
import { loadAndActivateRootPluginRegistry } from "../../../../src/plugins/loader.js";
import {
  clearActivePluginRegistry,
  createPluginRegistryOwner,
} from "../../../../src/plugins/runtime.js";
import { runPluginEmbeddedAgent } from "../../../../src/plugins/runtime/runtime-embedded-agent.runtime.js";
import { startPluginServices } from "../../../../src/plugins/services.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../../../src/test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import {
  createParams,
  buildDynamicToolsForTest,
  createCodexRuntimePlanFixture,
} from "./dynamic-tool-build.test-support.js";

// Connected-component proof only: replace the model dispatcher, retaining actual
// plugin admission, service scheduling, loader ownership and Codex tool construction.
const core = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/agents/embedded-agent.js", () => ({ runEmbeddedAgent: core }));
const SERVICE_TOOLS = ["livex_oncall_logs_read", "livex_oncall_assessment_submit"];
let state: any;
let config: any;
let debuggerTools: any;
let coordinatorTools: any;
let globalTools: any;
let runCounter = 0;
const closers: Array<() => void> = [];
beforeAll(async () => {
  state = await createOpenClawTestState({
    scenario: "minimal",
    label: "oncall-native-grant-probe",
  });
  const template = JSON.parse(
    await fs.readFile(
      new URL("../../../../livex-agents/config/openclaw.template.json", import.meta.url),
      "utf8",
    ),
  );
  debuggerTools = {
    ...template.agents.entries.oncall.tools,
    allow: template.agents.entries.oncall.tools.allow.filter(
      (name: string) => !SERVICE_TOOLS.includes(name),
    ),
  };
  coordinatorTools = template.agents.entries["oncall-coordinator"].tools;
  globalTools = template.tools;
  await writeFixture(state.path("probe-plugin"));
});
afterAll(async () => {
  for (const close of closers) {
    close();
  }
  await state?.cleanup();
});
async function owner(addServiceNames = true, restrictiveGlobal = false) {
  const allowed = [...debuggerTools.allow];
  if (addServiceNames) {
    allowed.push(...SERVICE_TOOLS);
  }
  config = {
    agents: {
      entries: {
        oncall: { workspace: state.workspaceDir, tools: { ...debuggerTools, allow: allowed } },
        other: { workspace: state.workspaceDir },
      },
    },
    tools: { ...globalTools, toolSearch: false, ...(restrictiveGlobal ? { allow: ["read"] } : {}) },
    plugins: {
      allow: ["native-readiness-probe"],
      load: { paths: [state.path("probe-plugin/index.mjs")] },
      slots: { memory: "none" },
      entries: { "native-readiness-probe": { enabled: true } },
    },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config, config);
  const registry = await loadAndActivateRootPluginRegistry({
    config,
    workspaceDir: state.workspaceDir,
    cache: false,
    throwOnLoadError: true,
  });
  expect(
    registry.plugins.find((record: any) => record.id === "native-readiness-probe")?.status,
  ).toBe("loaded");
  const probe = (registry.services[0]!.service as any).probe;
  return { registry, probe };
}
async function buildSurface(
  scope: any,
  binding: object | undefined,
  sessionKey = "agent:oncall:oncall-service:alert1",
  agentId = "oncall",
  workspaceDir = state.workspaceDir,
) {
  const params = createParams(state.path("session.jsonl"), workspaceDir, {
    agentId,
    sessionKey,
    runId: `probe-run-${++runCounter}`,
    config,
    disableTools: false,
    runtimePlan: createCodexRuntimePlanFixture(),
    toolBindings: { livex_oncall: binding },
  });
  return withPluginRuntimeRegistryScope(scope.registry, async () => {
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: params,
      pluginId: "codex",
    });
    params.hostCapabilities = host.capabilities;
    closers.push(host.close);
    return buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null,
      sessionAgentId: agentId,
      policyAgentId: agentId,
    });
  });
}
function serviceTool(tools: any[]) {
  return tools.find((tool: any) => tool.name === SERVICE_TOOLS[0]);
}
function visibleNames(tools: any[]) {
  return tools
    .map((tool: any) => tool.name)
    .toSorted((left: string, right: string) => left.localeCompare(right));
}
async function assertUnavailable(
  scope: any,
  binding: object | undefined,
  sessionKey?: string,
  agentId?: string,
) {
  const tools = await buildSurface(scope, binding, sessionKey, agentId);
  expect(serviceTool(tools)).toBeUndefined();
  expect(tools.find((tool: any) => tool.name === SERVICE_TOOLS[1])).toBeUndefined();
}
it("configured Debugger needs exact service-name additions and leaves ordinary human tools unchanged", async () => {
  const key = "agent:oncall:oncall-service:alert1";
  const before = await owner(false);
  const ordinaryBefore = visibleNames(await buildSurface(before, undefined));
  await assertUnavailable(before, before.probe.mint(key));
  await clearActivePluginRegistry(before.registry);
  const after = await owner();
  expect(visibleNames(await buildSurface(after, undefined))).toEqual(ordinaryBefore);
  const grant = after.probe.mint(key);
  const tools = await buildSurface(after, grant);
  expect(after.probe.same(grant)).toBe(true);
  expect(SERVICE_TOOLS.every((name) => tools.some((tool: any) => tool.name === name))).toBe(true);
  await serviceTool(tools)!.execute("authorized", {});
  expect(after.probe.calls()).toEqual([key]);
  await clearActivePluginRegistry(after.registry);
});
it("private service grants reject missing, cloned, forged, wrong-agent/session, revoked and retired ownership", async () => {
  const scope = await owner();
  const key = "agent:oncall:oncall-service:alert1";
  const grant = scope.probe.mint(key);
  await assertUnavailable(scope, undefined);
  await assertUnavailable(scope, structuredClone(grant));
  await assertUnavailable(scope, {});
  await assertUnavailable(scope, grant, "agent:oncall:oncall-service:other-run");
  const otherKey = "agent:other:oncall-service:alert1";
  await assertUnavailable(scope, scope.probe.mint(otherKey), otherKey, "other");
  const tool = serviceTool(await buildSurface(scope, grant))!;
  scope.probe.revoke(grant);
  await expect(tool.execute("revoked", {})).rejects.toThrow("service grant denied");
  expect(scope.probe.calls()).toEqual([]);
  const fresh = scope.probe.mint(key);
  const retained = serviceTool(await buildSurface(scope, fresh))!;
  await clearActivePluginRegistry(scope.registry);
  await expect(retained.execute("retired", {})).rejects.toThrow();
  const next = await owner();
  await assertUnavailable(next, fresh);
  const nextTool = serviceTool(await buildSurface(next, next.probe.mint(key)))!;
  await nextTool.execute("new-generation", {});
  expect(next.probe.calls()).toEqual([key]);
  await clearActivePluginRegistry(next.registry);
});
it("an explicit restrictive global allowlist still denies service tools", async () => {
  const scope = await owner(true, true);
  await assertUnavailable(scope, scope.probe.mint("agent:oncall:oncall-service:alert1"));
  expect(scope.probe.calls()).toEqual([]);
  await clearActivePluginRegistry(scope.registry);
});
it("native scheduling connects real plugin run admission to native Codex construction under the same grant owner", async () => {
  const scope = await owner();
  const key = "agent:oncall:oncall-service:scheduled";
  const time = createGatewaySchedulerClock(1000);
  const gateway = createTestGatewayScheduler(time.clock);
  core.mockImplementation(async (run: any) => {
    const grant = run.toolBindings.livex_oncall;
    const admitted = await resolvePreparedRunAdmission({ ...run, runtimeKind: "embedded" });
    const attempt = {
      ...createParams(state.path("scheduled.jsonl"), state.workspaceDir, {
        ...run,
        model: createParams("", state.workspaceDir).model,
        modelId: "gpt-5.4-codex",
        disableTools: false,
        runtimePlan: createCodexRuntimePlanFixture(),
        admittedRunContext: admitted,
      }),
      admittedRunContext: admitted,
    };
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    attempt.hostCapabilities = host.capabilities;
    try {
      const tools = await buildDynamicToolsForTest(attempt, state.workspaceDir, {
        sandbox: null,
        sessionAgentId: "oncall",
        policyAgentId: "oncall",
      });
      expect(scope.probe.same(grant)).toBe(true);
      expect(visibleNames(tools)).toEqual(
        [...SERVICE_TOOLS].toSorted((left: string, right: string) => left.localeCompare(right)),
      );
      await serviceTool(tools)!.execute("scheduled", {});
      return { payloads: [], meta: { durationMs: 0 } };
    } finally {
      host.close();
    }
  });
  scope.probe.setDispatch((params: any) => runPluginEmbeddedAgent(params));
  const services = await startPluginServices({
    registry: scope.registry,
    config,
    scheduler: gateway,
  });
  await time.wake();
  await services.stop();
  await gateway.stop();
  expect(scope.probe.error()?.stack).toBeUndefined();
  expect(core).toHaveBeenCalledOnce();
  expect(scope.probe.calls()).toEqual([key]);
  await clearActivePluginRegistry(scope.registry);
});

it("the Oncall script runs headlessly across workspaces and admits only eligible Debugger work", async () => {
  const root = state.path("actual-oncall-plugin");
  const gcloud = state.path("synthetic-gcloud");
  const currentTime = Date.parse("2026-11-07T10:00:00Z");
  const audit = state.path("gcloud-argv.txt");
  const time = createGatewaySchedulerClock(currentTime);
  const gateway = createTestGatewayScheduler(time.clock);
  const runIsolatedAgentJob = vi.fn(async () => {
    throw new Error("Oncall Automation must not start a model-backed cron run");
  });
  const { cron, state: cronState } = createCronServiceWithStateForTest({
    scheduler: gateway,
    storePath: state.path("cron/jobs.json"),
    cronEnabled: true,
    defaultAgentId: "oncall-coordinator",
    nowMs: time.clock.now,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob,
    runScriptJob: async (params) => {
      const result = await runScript(params);
      return result.kind === "completed"
        ? { status: "ok" }
        : { status: "error", error: result.error };
    },
  });
  const script = await fs.readFile(
    new URL(
      "../../../../livex-agents/plugins/livex-gcp-readonly/workflows/oncall/tick.automation.js",
      import.meta.url,
    ),
    "utf8",
  );
  const jobInput = {
    agentId: "oncall-coordinator",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "script", script, toolsAllow: ["livex_oncall_tick"], toolBudget: 1 },
    delivery: { mode: "none" },
  } as const;
  const addJob = (name: string) =>
    cron.add({
      ...jobInput,
      name,
      payload: { ...jobInput.payload, toolsAllow: [...jobInput.payload.toolsAllow] },
    });
  const job = await addJob("LiveX Oncall");
  const otherJob = await addJob("Unbound Oncall job");
  const row = {
    timestamp: new Date(currentTime - 1000).toISOString(),
    severity: "ERROR",
    insertId: "row-1",
    resource: { type: "k8s_container", labels: { namespace_name: "prd-worker" } },
    jsonPayload: { message: "failed", job_id: "job-1" },
  };
  await fs.writeFile(
    gcloud,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${audit}'\nprintf '%s' '${JSON.stringify([row])}'\n`,
    { mode: 0o700 },
  );
  await writeProductionWrapper(root);
  const source = {
    enabled: true,
    automationJobId: job.id,
    accountId: "default",
    teamId: "T123456",
    channelId: "C123456",
    publisherBotId: "B123456",
    historicalSenderId: "U123456",
    environment: "prd",
    resourceType: "k8s_container",
    resourceLabels: { namespace_name: "prd-worker" },
    broadcastChannelId: "C765432",
  };
  config = {
    agents: {
      entries: {
        oncall: {
          workspace: state.workspaceDir,
          agentDir: state.path("oncall-agent"),
          tools: { ...debuggerTools, allow: [...debuggerTools.allow, ...SERVICE_TOOLS] },
        },
        "oncall-coordinator": {
          workspace: state.path("coordinator-workspace"),
          identity: { name: "Configured Oncall" },
          tools: coordinatorTools,
        },
      },
    },
    tools: { ...globalTools, toolSearch: false },
    channels: { slack: { enabled: true, botToken: "xoxb-synthetic-oncall-test" } },
    plugins: {
      allow: ["livex-gcp-readonly", "livex-investigations"],
      load: { paths: [path.join(root, "index.mjs")] },
      slots: { memory: "none" },
      entries: {
        "livex-gcp-readonly": {
          enabled: true,
          config: {
            gcloudPath: gcloud,
            cloudSdkConfig: state.path("synthetic-sdk"),
            gcloudAccount: "investigator@example.test",
            project: "example-prd",
            allowedChannelId: "C123456",
            allowedSenderId: "U123456",
            oncall: source,
          },
        },
        "livex-investigations": {
          enabled: true,
          config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
        },
      },
    },
  };
  await fs.mkdir(state.path("oncall-agent"), { recursive: true });
  await fs.writeFile(state.path("oncall-agent/investigations.md"), serializeCatalog([]));
  await state.writeConfig(config);
  await setAppliedRuntimeConfigSnapshot(config, config);
  const calls: Array<{ method: string; args: any }> = [];
  let alertAvailable = false;
  const slack = await localSlackServer(currentTime, calls, () => alertAvailable);
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("SLACK_API_URL", slack.url);
  const registry = await loadAndActivateRootPluginRegistry({
    config,
    workspaceDir: state.workspaceDir,
    cache: false,
    throwOnLoadError: true,
  });
  const registryOwner = createPluginRegistryOwner(registry, state.workspaceDir);
  // This fixture only supplies the Gateway's live Cron facade to the script runner.
  const gatewayContext = { cron } as unknown as GatewayRequestContext;
  const resolveGatewayContext = () => gatewayContext;
  const sdkResourceHost = new LegacyPluginSdkResourceHost();
  sdkResourceHost.bindScheduler(gateway);
  bindLegacyPluginSdkResourceHost(resolveGatewayContext, sdkResourceHost);
  const inGateway = createScheduledGatewayRunner(
    resolveGatewayContext,
    () => registryOwner.registry,
  );
  const scriptRuntime = createCronScriptRuntime({
    config,
    loadPluginRegistry: loadPreparedInboundPluginRegistry,
    resolveGatewayContext,
  });
  const runScript: ReturnType<typeof createCronScriptRuntime>["executePayload"] = (params) =>
    inGateway(() => scriptRuntime.executePayload(params));
  const control = (
    registry.services.find((record: any) => record.service.id === "actual-test-control")!
      .service as any
  ).control;
  expect(control.current().plugins.entries["livex-gcp-readonly"].config).toEqual(
    config.plugins.entries["livex-gcp-readonly"].config,
  );
  core.mockReset();
  core.mockImplementation((run: any) => executeProductionRun(run));
  control.setDispatcher((run: any) => runPluginEmbeddedAgent(run));
  let services: Awaited<ReturnType<typeof startPluginServices>> | undefined;
  const assertJobStatus = async (id: string, expected: "ok" | "error") => {
    const latest = await cron.readJob(id);
    expect(latest?.state.lastRunStatus, latest?.state.lastError).toBe(expected);
  };
  const runJob = async (id: string, expected: "ok" | "error") => {
    await expect(cron.run(id, "force")).resolves.toMatchObject({ ok: true, ran: true });
    await assertJobStatus(id, expected);
  };
  try {
    await startPluginServices({
      registry,
      config,
      scheduler: gateway,
      getCronService: () => cron,
      throwOnStartError: true,
      onHandle: (handle) => {
        services = handle;
      },
    });
    const { wake } = await captureCronSchedulerWakeForTest(() => cron.start());
    expect(calls).toEqual([]);
    await runJob(otherJob.id, "error");
    expect((await cron.readJob(otherJob.id))?.state.lastError).toContain(
      "livex_oncall_tick is not defined",
    );
    expect(calls).toEqual([]);
    await cron.update(otherJob.id, { enabled: false });
    const idleDueAt = (await cron.readJob(job.id))?.state.nextRunAtMs;
    expect(idleDueAt).toBeTypeOf("number");
    time.setTime(idleDueAt! + 5);
    await wake(cronState);
    await waitForCronRunQueue(cronState);
    await assertJobStatus(job.id, "ok");
    expect(calls.some((call) => call.method === "conversations.history")).toBe(true);
    expect(core).not.toHaveBeenCalled();

    alertAvailable = true;
    await runJob(job.id, "ok");
    await time.wake();
    await vi.waitFor(
      () => {
        expect(control.health()).toEqual([]);
        expect(control.error()?.stack).toBeUndefined();
        expect(control.completed()).toBe(1);
      },
      { timeout: 10000 },
    );
    await runJob(job.id, "ok");
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2),
    );
    const posts = calls.filter((call) => call.method === "chat.postMessage");
    expect(posts[0]!.args.text).not.toContain("<@");
    expect(posts[1]!.args.text).toContain("<@U123456>");
    expect(
      posts.every(
        (post) =>
          post.args.username === "Configured Oncall" &&
          post.args.metadata.event_type === "livex_oncall",
      ),
    ).toBe(true);
    expect(await fs.readFile(audit, "utf8")).toContain("--project=example-prd");
    expect(core).toHaveBeenCalledOnce();
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  } finally {
    cron.stop();
    await cron.waitForIdle();
    await services?.stop();
    await gateway.stop();
    await registryOwner.close();
    await sdkResourceHost.close();
    await slack.close();
    vi.unstubAllEnvs();
  }
});

async function localSlackServer(
  currentTime: number,
  calls: Array<{ method: string; args: any }>,
  alertAvailable: () => boolean,
) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const args: any = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    if (args.metadata) {
      args.metadata = JSON.parse(args.metadata);
    }
    const method = request.url!.slice(1);
    calls.push({ method, args });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(slackResponse(method, currentTime, alertAvailable())));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Synthetic Slack server did not bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function slackResponse(method: string, currentTime: number, alertAvailable: boolean): any {
  const responses: Record<string, unknown> = {
    "auth.test": { ok: true, team_id: "T123456", bot_id: "B123456" },
    "conversations.history": {
      ok: true,
      messages: alertAvailable
        ? [
            {
              ts: (currentTime / 1000).toFixed(6),
              bot_id: "B123456",
              team: "T123456",
              text: "job_id=job-1 failed",
            },
            {
              ts: (currentTime / 1000 + 1).toFixed(6),
              bot_id: "B123456",
              metadata: { event_type: "livex_oncall" },
              text: "coordinator output",
            },
          ]
        : [],
    },
    "conversations.info": { ok: true, channel: { properties: { canvas: { file_id: "F123456" } } } },
    "files.info": {
      ok: true,
      file: {
        id: "F123456",
        content: "P1: <@U123456>\nP2: <@U765432>",
        size: Buffer.byteLength("P1: <@U123456>\nP2: <@U765432>"),
      },
    },
    "reactions.get": { ok: true, message: { reactions: [] } },
    "chat.postMessage": { ok: true, ts: (currentTime / 1000 + 2).toFixed(6) },
  };
  if (!(method in responses)) {
    throw new Error(`Unexpected Slack request ${method}`);
  }
  return responses[method];
}

async function executeProductionRun(run: any) {
  const admitted = await resolvePreparedRunAdmission({ ...run, runtimeKind: "embedded" });
  const attempt = {
    ...createParams(state.path("actual.jsonl"), state.workspaceDir, {
      ...run,
      model: createParams("", state.workspaceDir).model,
      modelId: "gpt-5.4-codex",
      disableTools: false,
      runtimePlan: createCodexRuntimePlanFixture(),
      admittedRunContext: admitted,
    }),
    admittedRunContext: admitted,
  };
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
  attempt.hostCapabilities = host.capabilities;
  try {
    const tools = await buildDynamicToolsForTest(attempt, state.workspaceDir, {
      sandbox: null,
      sessionAgentId: "oncall",
      policyAgentId: "oncall",
    });
    expect(visibleNames(tools)).toEqual(SERVICE_TOOLS.toSorted());
    const request = JSON.parse(run.prompt.slice(run.prompt.indexOf("\n") + 1));
    const result = await serviceTool(tools)!.execute("actual-logs", {
      start: request.start,
      end: request.end,
      resourceType: request.resourceType,
      resourceLabels: request.resourceLabels,
      jobId: "job-1",
    });
    await tools
      .find((tool: any) => tool.name === SERVICE_TOOLS[1])!
      .execute("actual-submit", {
        findings: [
          {
            id: "failure",
            signature: {
              service: "worker",
              environment: "prd",
              operation: "process",
              error: "failed",
              resource: "job-1",
            },
            priority: "Critical",
            summary: "Failed job <@U666666>",
            nextAction: "Inspect worker",
            evidence: [result.details.logsExplorerUrl],
          },
        ],
      });
    return { payloads: [], meta: { durationMs: 0 } };
  } finally {
    host.close();
  }
}

async function writeProductionWrapper(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  const entry = fileURLToPath(
    new URL("../../../../livex-agents/plugins/livex-gcp-readonly/index.ts", import.meta.url),
  );
  await fs.copyFile(
    new URL(
      "../../../../livex-agents/plugins/livex-gcp-readonly/openclaw.plugin.json",
      import.meta.url,
    ),
    path.join(dir, "openclaw.plugin.json"),
  );
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "livex-gcp-readonly",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  await fs.writeFile(
    path.join(dir, "index.mjs"),
    `import production from ${JSON.stringify(entry)};
export default {id:'livex-gcp-readonly', register(api){
  let dispatcher; let completed=0; let failure; const health=[];
  const agent=new Proxy(api.runtime.agent,{get(target,key){if(key==='runEmbeddedAgent')return async(params)=>{try{const result=await dispatcher(params);completed++;return result;}catch(error){failure=error;throw error;}};return Reflect.get(target,key);}});
  const runtime=new Proxy(api.runtime,{get(target,key){return key==='agent'?agent:Reflect.get(target,key);}});
  const logger={...api.logger,warn(message){health.push(message);}};
  const wrapped=new Proxy(api,{get(target,key){if(key==='logger')return logger;return key==='runtime'?runtime:Reflect.get(target,key);}});
  production.register(wrapped);
  api.registerService({id:'actual-test-control',apiVersion:2,control:{setDispatcher(callback){dispatcher=callback;},completed:()=>completed,error:()=>failure,health:()=>health,current:()=>api.runtime.config.current()},start(){}});
}};`,
  );
}

// This private fixture owns its map in register(), shared by service and factories.
// The test callback replaces native lazy-runtime loading at the runner boundary;
// native API facade routing remains source-traced, not full-backend coverage.
const fixtureSource = String.raw`export default {id:'native-readiness-probe',register(api){
  const names=['livex_oncall_logs_read','livex_oncall_assessment_submit'];
  const grants=new WeakMap();
  const calls=[];
  const contexts=[];
  const mint=(sessionKey)=>{const grant=Object.freeze({});grants.set(grant,{sessionKey,agentId:'oncall'});return grant;};
  const authorize=(ctx)=>{
    const grant=ctx.toolBindings?.livex_oncall;
    const record=grant && grants.get(grant);
    return record && record.sessionKey===ctx.sessionKey && record.agentId===ctx.agentId;
  };
  api.registerTool({contextVersion:2,create(ctx){
    contexts.push(ctx);
    if(!authorize(ctx))return null;
    return names.map((name)=>({name,label:name,description:'Synthetic bounded evidence',parameters:{type:'object',properties:{}},async execute(){
      ctx.assertInvocationCurrent();
      if(!authorize(ctx))throw new Error('service grant denied');
      calls.push(ctx.sessionKey);
      return {content:[{type:'text',text:'authorized'}],details:{}};
    }}));
  }},{names,optional:true,workspaceAccess:false});
  let failure;
  let dispatch;
  api.registerService({apiVersion:2,id:'native-readiness-probe',
    probe:{setDispatch:(callback)=>{dispatch=callback;},mint,revoke:(grant)=>grants.delete(grant),calls:()=>calls.slice(),same:(grant)=>contexts.at(-1)?.toolBindings?.livex_oncall===grant,error:()=>failure},
    start({scheduler}){
      const sessionKey='agent:oncall:oncall-service:scheduled';
      const grant=mint(sessionKey);
      scheduler.schedule({id:'one-alert',delayMs:0,run:async()=>{
        try{await dispatch({config:api.config,agentId:'oncall',runId:'scheduled-run',sessionId:'scheduled-session',sessionKey,prompt:'Check synthetic alert',workspaceDir:api.config.agents.entries.oncall.workspace,timeoutMs:1000,toolsAllow:names,toolBindings:{livex_oncall:grant}});}
        catch(error){failure=error;}
      }});
    }
  });
}};`;
async function writeFixture(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.mjs"), fixtureSource);
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "native-readiness-probe",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  await fs.writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "native-readiness-probe",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { tools: SERVICE_TOOLS },
    }),
  );
}

import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import { registerOncall } from "./service.js";
import { createOncallSlack } from "./slack.js";
import { config, gcpConfig, message, nativeStore, now, slackStub } from "./test-support.js";

vi.mock("./slack.js", { spy: true });

const jobId = "live-oncall-script";
const agentId = "oncall-coordinator";

async function fixture() {
  const time = createGatewaySchedulerClock(now);
  const gateway = createTestGatewayScheduler(time.clock);
  const scheduler = createTestPluginServiceScheduler(gateway);
  const { open, source, root } = nativeStore();
  const slack = slackStub();
  vi.mocked(createOncallSlack).mockReturnValue(slack);
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const runEmbeddedAgent = vi.fn();
  const pluginConfig = { ...gcpConfig, oncall: { ...config, automationJobId: jobId } };
  const sourceConfig = { plugins: { entries: { "livex-gcp-readonly": { config: pluginConfig } } } };
  const runtime = createTestPluginApi().runtime;
  const api = createTestPluginApi({
    config: sourceConfig,
    pluginConfig,
    registerTool,
    registerService,
    lifecycle: { signal: scheduler.signal, registerRuntimeLifecycle: vi.fn() },
    runtime: {
      ...runtime,
      config: { ...runtime.config, current: () => sourceConfig },
      state: {
        ...runtime.state,
        openKeyedStoreV2: <T>(
          ...[, authority]: Parameters<typeof runtime.state.openKeyedStoreV2>
        ) => open<T>(() => authority?.assertCurrent()),
      },
      agent: { ...runtime.agent, runEmbeddedAgent },
    },
  });
  const list = vi.fn(async () => [
    { id: jobId, agentId, enabled: true, payload: { kind: "script" } },
  ]);
  const serviceContext = {
    config: sourceConfig,
    stateDir: root,
    logger: api.logger,
    scheduler,
    getCron: () => ({
      list,
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      removeStaleJobFamily: vi.fn(),
    }),
  };
  registerOncall(api);
  const service = registerService.mock.calls[0]?.[0];
  const factory = registerTool.mock.calls.find(
    ([, options]) => options?.name === "livex_oncall_tick",
  )?.[0];
  if (!service || service.apiVersion !== 2 || !factory || !("contextVersion" in factory)) {
    throw new Error("Expected an Oncall service and V2 tick tool");
  }
  await service.start(serviceContext);
  const createTickTool = factory.create;
  function tool(scriptAutomation?: OpenClawPluginToolContext<2>["scriptAutomation"]) {
    const candidate = createTickTool({ agentId, scriptAutomation, assertInvocationCurrent() {} });
    if (Array.isArray(candidate)) {
      throw new Error("Expected a single tick tool");
    }
    return candidate;
  }
  return {
    tool,
    slack,
    list,
    source,
    runEmbeddedAgent,
    async stop() {
      await service.stop?.(serviceContext);
      await scheduler.stop();
      await gateway.stop();
    },
  };
}

it("only exposes the tick to the exact job and admits one call per occurrence", async () => {
  const app = await fixture();
  const occurrence = { jobId, agentId, assertCurrent() {} };
  try {
    expect(app.tool()).toBeNull();
    expect(app.tool({ ...occurrence, agentId: "oncall" })).toBeNull();
    expect(app.tool({ ...occurrence, jobId: "other-job" })).toBeNull();
    const first = app.tool(occurrence);
    const duplicate = app.tool(occurrence);
    await expect(first?.execute("first", {})).resolves.toBeDefined();
    await expect(duplicate?.execute("duplicate", {})).rejects.toThrow("already ran its tick");
    expect(app.slack.verify).toHaveBeenCalledOnce();
    expect(app.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(app.slack.send).not.toHaveBeenCalled();
    const retained = app.tool({ ...occurrence });
    await app.stop();
    await expect(retained?.execute("retired", {})).rejects.toThrow("binding changed");
  } finally {
    await app.stop();
  }
});

it("fences a disabled job and an occurrence cancelled during Slack intake", async () => {
  const app = await fixture();
  const occurrence = new AbortController();
  const assertCurrent = () => occurrence.signal.throwIfAborted();
  try {
    app.list.mockResolvedValueOnce([
      { id: jobId, agentId, enabled: false, payload: { kind: "script" } },
    ]);
    await expect(
      app.tool({ jobId, agentId, assertCurrent })?.execute("disabled", {}),
    ).rejects.toThrow("configured, enabled Script Automation");
    expect(app.slack.verify).not.toHaveBeenCalled();
    vi.mocked(app.slack.history).mockImplementation(async () => {
      occurrence.abort();
      return { messages: [message] };
    });
    await expect(
      app.tool({ jobId, agentId, assertCurrent })?.execute("cancelled", {}),
    ).rejects.toThrow();
    expect(await app.source.entries()).toEqual([]);
    expect(app.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(app.slack.send).not.toHaveBeenCalled();
  } finally {
    await app.stop();
  }
});

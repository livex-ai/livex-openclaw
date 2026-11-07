import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CALENDAR_SCOPE,
  CALENDAR_SECRET_PATHS,
} from "../../livex-agents/plugins/livex-gcp-readonly/oncall/calendar-config.js";
import { createCalendarRoster } from "../../livex-agents/plugins/livex-gcp-readonly/oncall/calendar.js";
import type { ServiceCapabilities } from "../../livex-agents/plugins/livex-gcp-readonly/oncall/capability.js";
import { parseOncallConfig } from "../../livex-agents/plugins/livex-gcp-readonly/oncall/config.js";
import {
  createConfigCurrency,
  registerOncall,
} from "../../livex-agents/plugins/livex-gcp-readonly/oncall/service.js";
import {
  config as oncall,
  finding,
  gcpConfig,
  message,
  now,
} from "../../livex-agents/plugins/livex-gcp-readonly/oncall/test-support.js";
import type { RunAgent } from "../../livex-agents/plugins/livex-gcp-readonly/oncall/types.js";
import { serializeCatalog } from "../../livex-agents/plugins/livex-investigations/schema.js";
import { readRuntimeConfig } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { startPluginServices } from "../plugins/services.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { clearSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { activateSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } from "./runtime.js";

const boundary = vi.hoisted(() => ({
  fetch: vi.fn(),
  command: vi.fn(),
  write: vi.fn(),
  client: {
    auth: { test: vi.fn() },
    conversations: { history: vi.fn(), info: vi.fn() },
    files: { info: vi.fn() },
    reactions: { get: vi.fn() },
  },
  inputs: [] as unknown[],
  validated: [] as unknown[],
  prompts: [] as unknown[],
  stores: [] as Array<{ entries(): Promise<unknown> }>,
  capabilities: undefined as ServiceCapabilities | undefined,
  warnings: [] as string[],
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: boundary.fetch }));
vi.mock("@openclaw/slack/api.js", () => ({
  resolveSlackAccount: () => ({ enabled: true, botToken: "xoxb-native-calendar-synthetic" }),
  createSlackWebClient: () => boundary.client,
  createSlackWriteClient: (_token: string, _options: unknown, guard: () => void) => ({
    chat: {
      postMessage: async (input: unknown) => {
        guard();
        boundary.write(input);
        return { ok: true, ts: "1794045602.000001" };
      },
    },
  }),
}));
vi.mock("../../livex-agents/plugins/livex-gcp-readonly/oncall/capability.js", async (original) => {
  const actual =
    await original<
      typeof import("../../livex-agents/plugins/livex-gcp-readonly/oncall/capability.js")
    >();
  return {
    ...actual,
    createServiceCapabilities: (params: Parameters<typeof actual.createServiceCapabilities>[0]) => {
      boundary.inputs.push({ gcpConfig: params.gcpConfig, config: params.config });
      const capabilities = actual.createServiceCapabilities({
        ...params,
        runCommand: boundary.command,
      });
      boundary.capabilities = capabilities;
      return capabilities;
    },
  };
});

vi.mock("../../livex-agents/plugins/livex-gcp-readonly/core.mjs", async (original) => {
  const actual =
    await original<typeof import("../../livex-agents/plugins/livex-gcp-readonly/core.mjs")>();
  return {
    ...actual,
    validateConfig: (value: unknown) => {
      const validated = actual.validateConfig(value);
      boundary.validated.push(validated);
      return validated;
    },
  };
});

const id = "livex-gcp-readonly";
const registration = Symbol.for("openclaw.test.livex-calendar-native-register");
const clientRef = { source: "env", provider: "default", id: "NATIVE_CALENDAR_CLIENT_A" } as const;
const refreshRef = { source: "env", provider: "default", id: "NATIVE_CALENDAR_REFRESH_A" } as const;
const canaries = [
  "CLIENT_CANARY_A",
  "REFRESH_CANARY_A",
  "CLIENT_CANARY_B",
  "REFRESH_CANARY_B",
  "ACCESS_CANARY",
];
const closers: Array<() => Promise<unknown>> = [];
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({
    scenario: "empty",
    label: "livex-calendar-native",
    prepareProfileCatalog: false,
  });
  useNoBundledPlugins();
  vi.clearAllMocks();
  boundary.inputs.length = 0;
  boundary.validated.length = 0;
  boundary.prompts.length = 0;
  boundary.stores.length = 0;
  boundary.warnings.length = 0;
  boundary.capabilities = undefined;
  syntheticBoundaries();
});

afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) {
    await close();
  }
  clearSecretsRuntimeSnapshotState();
  Reflect.deleteProperty(globalThis, registration);
  resetPluginLoaderTestStateForTest();
  await state.cleanup();
});

function syntheticBoundaries() {
  boundary.client.auth.test.mockResolvedValue({ ok: true, team_id: oncall.teamId });
  boundary.client.conversations.history.mockResolvedValue({ messages: [] });
  boundary.client.conversations.info.mockResolvedValue({
    channel: { properties: { canvas: { file_id: "F123456" } } },
  });
  const content = "P1: <@U123456>\nP2: <@U765432>";
  boundary.client.files.info.mockResolvedValue({
    file: { id: "F123456", content, size: Buffer.byteLength(content) },
  });
  boundary.client.reactions.get.mockResolvedValue({ message: { reactions: [] } });
  boundary.command.mockResolvedValue({
    stdout: JSON.stringify([
      {
        timestamp: new Date(now - 1000).toISOString(),
        severity: "ERROR",
        resource: { type: oncall.resourceType, labels: oncall.resourceLabels },
        jsonPayload: { message: "failed", job_id: "job-1" },
      },
    ]),
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  });
  boundary.fetch.mockImplementation(async (options) => {
    const hostname = new URL(options.url).hostname;
    expect(["oauth2.googleapis.com", "www.googleapis.com"]).toContain(hostname);
    expect(options.policy).toEqual({ hostnameAllowlist: [hostname] });
    expect(options).toMatchObject({ requireHttps: true, maxRedirects: 0, capture: false });
    options.beforeRequest();
    const value =
      new URL(options.url).hostname === "oauth2.googleapis.com"
        ? {
            access_token: canaries[4],
            token_type: "Bearer",
            expires_in: 3600,
            scope: CALENDAR_SCOPE,
          }
        : { items: roleEvents() };
    return { response: Response.json(value), release: vi.fn(async () => {}) };
  });
}

function roleEvents() {
  return [
    {
      summary: "Oncall P1",
      status: "confirmed",
      start: { dateTime: "2026-11-07T09:00:00Z" },
      end: { dateTime: "2026-11-07T11:00:00Z" },
      description: "Slack-User-ID: U654321",
    },
  ];
}

function registerFixture(api: OpenClawPluginApi) {
  const agent = new Proxy(api.runtime.agent, {
    get(target, key) {
      return key === "runEmbeddedAgent" ? runPrivateDebugger : Reflect.get(target, key);
    },
  });
  const storage = new Proxy(api.runtime.state, {
    get(target, key) {
      if (key !== "openKeyedStoreV2") {
        return Reflect.get(target, key);
      }
      return (...args: Parameters<typeof target.openKeyedStoreV2>) => {
        const store = target.openKeyedStoreV2(...args);
        boundary.stores.push(store);
        return store;
      };
    },
  });
  const runtime = new Proxy(api.runtime, {
    get(target, key) {
      if (key === "agent") {
        return agent;
      }
      if (key === "state") {
        return storage;
      }
      return Reflect.get(target, key);
    },
  });
  const logger = { ...api.logger, warn: (value: string) => boundary.warnings.push(value) };
  registerOncall(
    new Proxy(api, {
      get(target, key) {
        if (key === "runtime") {
          return runtime;
        }
        if (key === "logger") {
          return logger;
        }
        return Reflect.get(target, key);
      },
    }),
  );
}

async function runPrivateDebugger(run: Parameters<RunAgent>[0]) {
  boundary.prompts.push({
    prompt: run.prompt,
    grants: run.toolBindings,
    toolsAllow: run.toolsAllow,
  });
  const capabilities = boundary.capabilities!;
  const context = {
    agentId: run.agentId,
    sessionKey: run.sessionKey,
    sessionId: run.sessionId,
    toolBindings: run.toolBindings,
    assertInvocationCurrent() {
      run.abortSignal?.throwIfAborted();
    },
  };
  const request = JSON.parse(run.prompt.slice(run.prompt.indexOf("\n") + 1));
  const tool = capabilities.createTool(context, "livex_oncall_logs_read")!;
  const result = await tool.execute("native-calendar-evidence", {
    start: request.start,
    end: request.end,
    resourceType: request.resourceType,
    resourceLabels: request.resourceLabels,
    jobId: "job-1",
  });
  const details = result.details as { logsExplorerUrl: string };
  await capabilities
    .createTool(context, "livex_oncall_assessment_submit")!
    .execute("native-calendar-assessment", {
      findings: [{ ...finding, evidence: [details.logsExplorerUrl] }],
    });
  return { payloads: [], meta: { durationMs: 0 } };
}

function fixtureConfig(file: string): OpenClawConfig {
  return {
    agents: {
      entries: { oncall: { agentDir: state.agentDir("oncall"), workspace: state.workspaceDir } },
    },
    channels: { slack: { enabled: true, botToken: "xoxb-native-calendar-synthetic" } },
    plugins: {
      allow: [id, "livex-investigations"],
      load: { paths: [file] },
      slots: { memory: "none" },
      entries: {
        [id]: {
          enabled: true,
          config: {
            ...gcpConfig,
            oncall: {
              ...oncall,
              googleCalendar: {
                enabled: true,
                calendarId: "native@example.test",
                oauth: {
                  clientId: "public-client",
                  clientSecret: clientRef,
                  refreshToken: refreshRef,
                },
              },
            },
          },
        },
        "livex-investigations": {
          enabled: true,
          config: { investigationCatalog: { enabled: true, agentId: "oncall" } },
        },
      },
    },
  };
}

type Owner = Awaited<ReturnType<typeof owner>>;
async function owner(mode = "ready") {
  Reflect.set(globalThis, registration, registerFixture);
  const plugin = writePlugin({
    id,
    body: `module.exports = {
  id: "livex-gcp-readonly",
  register(api) {
    globalThis[Symbol.for("openclaw.test.livex-calendar-native-register")](api);
  },
};
`,
  });
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "../../livex-agents/plugins/livex-gcp-readonly/openclaw.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  writeFileSync(path.join(plugin.dir, "openclaw.plugin.json"), JSON.stringify(manifest));
  const source = fixtureConfig(plugin.file);
  if (mode === "missing") {
    delete oauthConfig(source).refreshToken;
  }
  const manifests = loadPluginManifestRegistryCore({
    config: source,
    workspaceDir: state.workspaceDir,
  });
  const snapshot = await prepare(
    source,
    manifests,
    mode === "degraded"
      ? { NATIVE_CALENDAR_CLIENT_A: canaries[0] }
      : { NATIVE_CALENDAR_CLIENT_A: canaries[0], NATIVE_CALENDAR_REFRESH_A: canaries[1] },
  );
  const registry = loadOpenClawPlugins({
    config: snapshot.config,
    activationSourceConfig: snapshot.sourceConfig,
    activate: false,
    cache: false,
  });
  closers.push(() => disposePluginRegistryInstances(registry));
  const record = registry.plugins.find((entry) => entry.id === id);
  expect(record?.status, record?.error).toBe("loaded");
  const instance = record && getPluginInstance(record);
  if (!instance) {
    throw new Error("Native Calendar owner did not load");
  }
  return { source, manifests, snapshot, registry, instance };
}

async function prepare(
  source: OpenClawConfig,
  manifests: ReturnType<typeof loadPluginManifestRegistryCore>,
  env: NodeJS.ProcessEnv,
) {
  const snapshot = await prepareSecretsRuntimeSnapshot({
    config: source,
    env,
    manifestRegistry: manifests,
    includeConfigRefs: true,
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: new Map([[id, "config"]]),
  });
  activateSecretsRuntimeSnapshot(snapshot);
  return snapshot;
}

function resolver(value: Owner, canvas = vi.fn(async () => ({ p1: "U123456", p2: "U765432" }))) {
  const currency = createConfigCurrency(value.snapshot.config, () => readRuntimeConfig());
  const config = parseOncallConfig(value.snapshot.config.plugins!.entries![id]!.config!.oncall)!;
  const resolve = createCalendarRoster({
    config,
    signal: value.instance.lifecycle.signal,
    now: () => now,
    assertCurrent() {
      value.instance.lifecycle.signal.throwIfAborted();
      currency();
    },
    canvas,
  });
  return { resolve: () => value.instance.run(resolve), canvas, currency, config };
}

function assertNoCanaries(value: unknown) {
  const text = JSON.stringify(value);
  for (const canary of canaries) {
    expect(text).not.toContain(canary);
  }
  expect(text).not.toContain("NATIVE_CALENDAR_CLIENT_");
  expect(text).not.toContain("NATIVE_CALENDAR_REFRESH_");
}

it.each(["missing", "degraded"])(
  "prepares two isolated capability paths and keeps GCP/coordinator/fresh Canvas alive with %s credential",
  async (mode) => {
    const value = await owner(mode);
    const record = value.manifests.plugins.find((entry) => entry.id === id)!;
    expect(record.configContracts?.secretInputs?.paths).toEqual(
      Object.values(CALENDAR_SECRET_PATHS).map((secretPath) => ({
        path: secretPath,
        expected: "string",
        ownerKind: "capability",
      })),
    );
    if (mode === "degraded") {
      expect(value.snapshot.degradedOwners).toMatchObject([
        {
          ownerKind: "capability",
          ownerId: `plugins.entries.${id}.config.${CALENDAR_SECRET_PATHS.refreshToken}`,
          state: "unavailable",
        },
      ]);
    } else {
      expect(value.snapshot.degradedOwners).toEqual([]);
    }
    const client = value.instance.run(() =>
      getPreparedPluginSecretInput(id, CALENDAR_SECRET_PATHS.clientSecret),
    );
    const refresh = value.instance.run(() =>
      getPreparedPluginSecretInput(id, CALENDAR_SECRET_PATHS.refreshToken),
    );
    expect(client.value).toBe(canaries[0]);
    expect(refresh.value).toBeUndefined();
    expect(client.revision).toBe(refresh.revision);
    const direct = resolver(value);
    expect(await direct.resolve()).toMatchObject({ provider: "canvas", p1: "U123456" });
    expect(await direct.resolve()).toMatchObject({ provider: "canvas", p2: "U765432" });
    expect(direct.canvas).toHaveBeenCalledTimes(2);
    expect(boundary.fetch).not.toHaveBeenCalled();
    await exerciseService(value);
  },
);

async function exerciseService(value: Owner) {
  const directory = state.agentDir("oncall");
  await import("node:fs/promises").then((fs) => fs.mkdir(directory, { recursive: true }));
  writeFileSync(path.join(directory, "investigations.md"), serializeCatalog([]));
  boundary.client.conversations.history.mockResolvedValue({ messages: [message] });
  const time = createGatewaySchedulerClock(now);
  const gateway = createTestGatewayScheduler(time.clock);
  closers.push(() => gateway.stop());
  await startPluginServices({
    registry: value.registry,
    config: value.snapshot.config,
    scheduler: gateway,
    throwOnStartError: true,
    onHandle: (handle) => {
      closers.push(() => handle.stop());
    },
  });

  await time.wake();
  await time.wake();
  expect(boundary.command).toHaveBeenCalledOnce();
  time.setTime(now + 60_000);
  await time.wake();
  expect(boundary.write).toHaveBeenCalledTimes(2);
  expect(boundary.client.files.info).toHaveBeenCalledTimes(2);
  expect(boundary.write.mock.calls[1]?.[0].text).toContain("<@U123456>");
  assertNoCanaries(boundary.inputs);
  assertNoCanaries(boundary.validated);
  assertNoCanaries(boundary.prompts);
  assertNoCanaries(boundary.warnings);
  assertNoCanaries(await value.instance.run(() => boundary.stores[0]!.entries()));
}

it.each(["value", "ref", "revision"])(
  "native %s rotation advances revision without invalidating public source currency or retaining a stale Calendar roster",
  async (mode) => {
    const value = await owner();
    const active = resolver(value);
    const roster = await active.resolve();
    expect(roster).toMatchObject({ provider: "googleCalendar", p1: "U654321" });
    const before = value.instance.run(() =>
      getPreparedPluginSecretInput(id, CALENDAR_SECRET_PATHS.clientSecret),
    );
    const source = structuredClone(value.source);
    if (mode === "ref") {
      replaceRefs(source);
    }
    const clientValue = mode === "revision" ? canaries[0] : canaries[2];
    const refreshValue = mode === "revision" ? canaries[1] : canaries[3];
    await prepare(source, value.manifests, {
      NATIVE_CALENDAR_CLIENT_A: clientValue,
      NATIVE_CALENDAR_REFRESH_A: refreshValue,
      NATIVE_CALENDAR_CLIENT_B: canaries[2],
      NATIVE_CALENDAR_REFRESH_B: canaries[3],
    });
    const after = value.instance.run(() =>
      getPreparedPluginSecretInput(id, CALENDAR_SECRET_PATHS.clientSecret),
    );
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.value).toBe(clientValue);
    expect(() => active.currency()).not.toThrow();
    expect(() => value.instance.run(() => roster.assertFresh?.())).toThrow();
    expect(await active.resolve()).toMatchObject({ provider: "googleCalendar", p1: "U654321" });
    assertNoCanaries(active.config);
    const serialization = vi.spyOn(JSON, "stringify");
    createConfigCurrency(value.snapshot.config, () => readRuntimeConfig())();
    const fingerprints = serialization.mock.results.map((entry) => entry.value);
    serialization.mockRestore();
    assertNoCanaries(fingerprints);
  },
);

function oauthConfig(source: OpenClawConfig) {
  const config = source.plugins!.entries![id]!.config!;
  return (config.oncall as { googleCalendar: { oauth: Record<string, unknown> } }).googleCalendar
    .oauth;
}

function replaceRefs(source: OpenClawConfig) {
  const oauth = oauthConfig(source);
  oauth.clientSecret = { ...clientRef, id: "NATIVE_CALENDAR_CLIENT_B" };
  oauth.refreshToken = {
    ...refreshRef,
    id: "NATIVE_CALENDAR_REFRESH_B",
  };
}

it("discards an in-flight lookup after real prepared-snapshot rotation and fetches whole Canvas freshly", async () => {
  const value = await owner();
  const active = resolver(value);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  boundary.fetch.mockImplementationOnce(async (options) => {
    options.beforeRequest();
    entered.resolve();
    await release.promise;
    return {
      response: Response.json({
        access_token: canaries[4],
        token_type: "Bearer",
        expires_in: 3600,
      }),
      release: vi.fn(async () => {}),
    };
  });
  const pending = active.resolve();
  await entered.promise;
  await prepare(value.source, value.manifests, {
    NATIVE_CALENDAR_CLIENT_A: canaries[2],
    NATIVE_CALENDAR_REFRESH_A: canaries[3],
  });
  release.resolve();
  expect(await pending).toMatchObject({ provider: "canvas", p1: "U123456" });
  expect(active.canvas).toHaveBeenCalledOnce();
  expect(boundary.fetch).toHaveBeenCalledOnce();
  expect(() => active.currency()).not.toThrow();
});

it("actual service stop and completed owner retirement prevent every late Calendar and Canvas effect", async () => {
  const value = await owner();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  boundary.fetch.mockImplementationOnce(async (options) => {
    options.beforeRequest();
    entered.resolve();
    await release.promise;
    return {
      response: Response.json({
        access_token: canaries[4],
        token_type: "Bearer",
        expires_in: 3600,
      }),
      release: vi.fn(async () => {}),
    };
  });
  const time = createGatewaySchedulerClock(now);
  const gateway = createTestGatewayScheduler(time.clock);
  closers.push(() => gateway.stop());
  const services = await startPluginServices({
    registry: value.registry,
    config: value.snapshot.config,
    scheduler: gateway,
    throwOnStartError: true,
    onHandle: (handle) => {
      closers.push(() => handle.stop());
    },
  });
  const running = time.wake();
  await entered.promise;
  const stopping = services.stop();
  const retiring = value.instance.dispose();
  release.resolve();
  await running;
  await stopping;
  await retiring;
  expect(value.instance.lifecycle.signal.aborted).toBe(true);
  expect(
    getPreparedPluginSecretInput(id, CALENDAR_SECRET_PATHS.clientSecret).value,
  ).toBeUndefined();
  expect(boundary.client.files.info).not.toHaveBeenCalled();
  expect(boundary.fetch).toHaveBeenCalledOnce();
  expect(boundary.write).not.toHaveBeenCalled();
  expect(boundary.command).not.toHaveBeenCalled();
  assertNoCanaries(boundary.inputs);
  assertNoCanaries(boundary.validated);
  assertNoCanaries(boundary.warnings);
});

it.each(["oauth2.googleapis.com", "www.googleapis.com"])(
  "real public guarded fetch rejects private DNS for allowlisted %s before transport",
  async (hostname) => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
      "openclaw/plugin-sdk/ssrf-runtime",
    );
    const transport = vi.fn(async () => Response.json({}));
    await expect(
      actual.fetchWithSsrFGuard({
        url: `https://${hostname}/native-proof`,
        requireHttps: true,
        maxRedirects: 0,
        capture: false,
        policy: { hostnameAllowlist: [hostname] },
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
        fetchImpl: transport,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(transport).not.toHaveBeenCalled();
  },
);

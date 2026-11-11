import { createOncallCatalogReader } from "@livex/investigations/oncall-catalog";
import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { validateConfig } from "../../core.mjs";
import { createServiceCapabilities, type ServiceCapabilities } from "./capability.js";
import { parseOncallConfig, type OncallConfig } from "./config.js";
import { debuggerIdentity, runDebugger, type DebuggerIdentity } from "./debugger.js";
import { scanAlerts } from "./intake.js";
import { notifyReceipt, reconcileNotifications } from "./notifications.js";
import { createOncallSlack } from "./slack.js";
import { createReceiptScope, createReceiptStore, type ReceiptStore } from "./state.js";
import {
  SERVICE_TOOLS,
  type Assessment,
  type Finding,
  type Receipt,
  type SlackTransport,
  type SourceConfig,
} from "./types.js";
import { startOncallSlackWake } from "./wake.js";

type Catalog = Pick<ReturnType<typeof createOncallCatalogReader>, "lookup">;
type TickScope = {
  store: ReceiptStore;
  slack: SlackTransport;
  assertCurrent(): void;
};
type CoordinatorParams = Omit<TickScope, "slack"> & {
  config: OncallConfig;
  scheduler: PluginServiceSchedulerV1;
  investigate(
    receipt: Receipt,
    identity: DebuggerIdentity,
    signal: AbortSignal,
  ): Promise<Assessment>;
  catalog: Catalog;
  health(message: string): void;
};

function unclassified(reason: string): Finding[] {
  return [{ classification: "unclassified", reason }];
}

async function classify(assessment: Assessment, catalog: Catalog): Promise<Finding[]> {
  const matches = await catalog.lookup(assessment.findings.map((finding) => finding.signature));
  return assessment.findings.map((finding, index) => {
    const match = matches[index];
    if (!match) {
      throw new Error("Catalog classification is incomplete");
    }
    return {
      ...finding,
      classification: match.classification,
      caseId: match.issueId,
      caseUrl: match.canonicalUrl,
      reason: match.reason,
    };
  });
}

export function createCoordinator(params: CoordinatorParams) {
  const running = new Set<string>();
  let ticking = false;

  async function diagnose(
    receipt: Receipt,
    identity: DebuggerIdentity,
    child: PluginServiceSchedulerV1,
  ) {
    try {
      params.assertCurrent();
      const assessment = await params.investigate(receipt, identity, child.signal);
      child.signal.throwIfAborted();
      params.assertCurrent();
      const findings = await classify(assessment, params.catalog);
      child.signal.throwIfAborted();
      params.assertCurrent();
      await complete(receipt, identity, findings);
    } catch {
      if (!child.signal.aborted) {
        await complete(
          receipt,
          identity,
          unclassified("Debugger or case lookup failed. Human review is required."),
        );
      }
    } finally {
      running.delete(receipt.alert.key);
      child.beginClose();
    }
  }

  async function complete(receipt: Receipt, identity: DebuggerIdentity, findings: Finding[]) {
    await params.store.change(receipt.alert.key, (current) => {
      if (current.runId !== identity.runId || current.phase !== "dispatch_reserved") {
        throw new Error("Late assessment belongs to a different dispatch receipt");
      }
      return { ...current, phase: "assessed", findings };
    });
  }

  async function dispatch(receipt: Receipt, scope: TickScope) {
    if (running.size >= params.config.maxConcurrent || running.has(receipt.alert.key)) {
      return;
    }
    const child = params.scheduler.scope();
    const identity = debuggerIdentity(receipt.alert);
    running.add(receipt.alert.key);
    try {
      scope.assertCurrent();
      await scope.store.change(receipt.alert.key, (current) => {
        if (current.phase !== "queued") {
          throw new Error("Investigation already reserved");
        }
        return { ...current, phase: "dispatch_reserved", runId: identity.runId };
      });
      // The live tick admitted this investigation. Its child belongs to the service
      // so ordinary Script completion does not cancel legitimate Debugger work.
      child.schedule({ id: "debugger", delayMs: 0, run: () => diagnose(receipt, identity, child) });
    } catch (error) {
      running.delete(receipt.alert.key);
      child.beginClose();
      throw error;
    }
  }

  async function processTick(scope: TickScope) {
    const { slack, store, assertCurrent } = scope;
    const now = params.scheduler.now();
    await slack.verify();
    try {
      await scanAlerts({ ...scope, config: params.config, now, clock: params.scheduler.now });
    } catch {
      assertCurrent();
      params.health("Oncall intake incomplete or unavailable. Check source and receipt capacity.");
    }
    const roster = await slack.roster();
    assertCurrent();
    if (roster.error) {
      params.health(roster.error);
    }
    for (const receipt of await store.list()) {
      assertCurrent();
      try {
        if (receipt.phase === "queued") {
          await dispatch(receipt, scope);
        } else if (receipt.phase === "assessed" || receipt.phase === "dispatch_uncertain") {
          await notifyReceipt(receipt, roster, {
            ...scope,
            config: params.config,
            now,
            clock: params.scheduler.now,
            health: params.health,
            settlementStore: params.store,
          });
        }
      } catch {
        assertCurrent();
        params.health(
          "Oncall receipt processing failed; later independent receipts remain eligible.",
        );
      }
    }
    assertCurrent();
  }

  return {
    async tick(scope: TickScope) {
      scope.assertCurrent();
      if (ticking) {
        return false;
      }
      ticking = true;
      try {
        await processTick(scope);
        return true;
      } finally {
        ticking = false;
      }
    },
    start: () => reconcileNotifications(params.store, params.health),
  };
}

type SourceAuthority = {
  readonly agents?: unknown;
  readonly tools?: unknown;
  readonly plugins?: {
    readonly enabled?: boolean;
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
    readonly entries?: Readonly<
      Record<string, { readonly enabled?: boolean; readonly config?: unknown }>
    >;
  };
  readonly channels?: { readonly slack?: unknown };
};

function sourceFingerprint(config: SourceAuthority) {
  return JSON.stringify([
    config.plugins?.entries?.["livex-gcp-readonly"],
    config.plugins?.entries?.["livex-investigations"],
    pluginPolicy(config),
    config.channels?.slack,
    config.agents,
    config.tools,
  ]);
}

function pluginPolicy(config: SourceAuthority) {
  return [config.plugins?.enabled, config.plugins?.allow, config.plugins?.deny];
}

export function createConfigCurrency(source: SourceAuthority, current: () => SourceAuthority) {
  const fingerprint = sourceFingerprint(source);
  return () => {
    if (sourceFingerprint(current()) !== fingerprint) {
      throw new Error("Oncall source configuration changed");
    }
  };
}

const TICK_TOOL = "livex_oncall_tick";
const COORDINATOR_AGENT = "oncall-coordinator";
const AUTOMATION_SCRIPT = "await livex_oncall_tick({});\nreturn {};";
type ActiveTick = {
  jobId: string;
  run(assertCurrent: () => void, signal?: AbortSignal): Promise<boolean>;
};

export function registerOncall(api: OpenClawPluginApi) {
  let capabilities: ServiceCapabilities | undefined;
  let activeTick: ActiveTick | undefined;
  const usedOccurrences = new WeakSet<object>();
  api.registerTool(
    {
      contextVersion: 2,
      create(context) {
        const tick = activeTick;
        const invocation = context.scriptAutomation;
        if (
          !tick ||
          !invocation ||
          invocation.agentId !== COORDINATOR_AGENT ||
          invocation.jobId !== tick.jobId
        ) {
          return null;
        }
        const assertCurrent = () => {
          if (activeTick !== tick) {
            throw new Error("Oncall Automation binding changed");
          }
          context.assertInvocationCurrent();
          invocation.assertCurrent();
        };
        return {
          name: TICK_TOOL,
          label: "Run one LiveX Oncall tick",
          description: "Run the Oncall workflow for the configured Script Automation.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async (_id, _input, signal) => {
            assertCurrent();
            if (usedOccurrences.has(invocation)) {
              throw new Error("Oncall Automation occurrence already ran its tick");
            }
            usedOccurrences.add(invocation);
            const completed = await tick.run(assertCurrent, signal);
            return {
              details: { status: completed ? "completed" : "already-running" },
              content: [
                {
                  type: "text",
                  text: completed ? "Oncall tick completed." : "Oncall tick already running.",
                },
              ],
            };
          },
        };
      },
    },
    { name: TICK_TOOL, optional: true, workspaceAccess: false },
  );
  for (const name of SERVICE_TOOLS) {
    api.registerTool(
      { contextVersion: 2, create: (context) => capabilities?.createTool(context, name) ?? null },
      { name, optional: true, workspaceAccess: false },
    );
  }
  api.registerService({
    id: "livex-oncall-coordinator",
    apiVersion: 2,
    reload: { configPrefixes: ["plugins.entries.livex-gcp-readonly.config.oncall"] },
    async start(context) {
      const pluginConfig = context.config.plugins?.entries?.["livex-gcp-readonly"]?.config;
      const config = parseOncallConfig(pluginConfig?.oncall);
      if (!config) {
        return;
      }
      const jobId = config.automationJobId;
      if (!jobId) {
        api.logger.warn(
          "Oncall is paused. Bind the LiveX Oncall Script Automation before enabling it.",
        );
        return;
      }
      const lifecycle = api.lifecycle.signal;
      if (!lifecycle) {
        throw new Error("Oncall requires current plugin lifecycle authority");
      }
      const assertConfigCurrent = createConfigCurrency(context.config, () =>
        api.runtime.config.current(),
      );
      const assertCurrent = () => {
        lifecycle.throwIfAborted();
        context.scheduler.signal.throwIfAborted();
        assertConfigCurrent();
      };
      const baseGcpConfig = validateConfig(pluginConfig);
      const gcpConfig = { ...baseGcpConfig, project: config.gcpProject ?? baseGcpConfig.project };
      const serviceCapabilities = createServiceCapabilities({
        config,
        gcpConfig,
        signal: lifecycle,
        now: context.scheduler.now,
        assertCurrent,
      });
      const catalog = createOncallCatalogReader({
        config: context.config,
        scope: {
          agentId: "oncall",
          accountId: config.accountId,
          teamId: config.teamId,
          channelId: config.channelId,
          senderId: config.historicalSenderId,
        },
        assertCurrent,
      });
      const sourceId = createReceiptScope(config, gcpConfig, catalog.sourceIdentity);
      let quarantineReported = false;
      const openStore = (assertStoreCurrent: () => void) =>
        createReceiptStore(
          api.runtime.state.openKeyedStoreV2<Receipt | { timestamp: string; sourceId: string }>(
            {
              namespace: "oncall-receipts",
              maxEntries: config.maxReceipts + 1,
              overflowPolicy: "reject-new",
            },
            { assertCurrent: assertStoreCurrent },
          ),
          sourceId,
          (count) => {
            if (!quarantineReported) {
              quarantineReported = true;
              api.logger.warn(
                `Oncall retained ${count} receipts outside the current source; automatic effects are suppressed.`,
              );
            }
          },
        );
      const store = openStore(assertCurrent);
      const coordinator = createCoordinator({
        config,
        store,
        scheduler: context.scheduler,
        catalog,
        assertCurrent,
        health: (message) => api.logger.warn(message),
        investigate: (receipt, identity, signal) =>
          investigate(receipt, identity, signal, {
            api,
            config,
            capabilities: serviceCapabilities,
            sourceConfig: context.config,
            assertCurrent,
          }),
      });
      await coordinator.start();
      assertCurrent();
      capabilities = serviceCapabilities;
      activeTick = {
        jobId,
        async run(assertInvocationCurrent, invocationSignal) {
          const signal = invocationSignal
            ? AbortSignal.any([context.scheduler.signal, invocationSignal])
            : context.scheduler.signal;
          const assertTickCurrent = () => {
            assertCurrent();
            signal.throwIfAborted();
            assertInvocationCurrent();
          };
          assertTickCurrent();
          const jobs = await context.getCron?.()?.list({ includeDisabled: true });
          assertTickCurrent();
          const job = jobs?.find((candidate) => candidate.id === jobId);
          if (
            job?.enabled !== true ||
            job.agentId !== COORDINATOR_AGENT ||
            job.payload?.kind !== "script"
          ) {
            throw new Error("Oncall requires its configured, enabled Script Automation");
          }
          return await coordinator.tick({
            store: openStore(assertTickCurrent),
            slack: createOncallSlack({
              config,
              sourceConfig: context.config,
              signal,
              assertCurrent: assertTickCurrent,
            }),
            assertCurrent: assertTickCurrent,
          });
        },
      };
      startOncallSlackWake({
        api,
        context,
        config,
        jobId,
        expectedScript: {
          agentId: COORDINATOR_AGENT,
          script: AUTOMATION_SCRIPT,
          toolName: TICK_TOOL,
        },
        assertCurrent,
      });
    },
    async stop() {
      activeTick = undefined;
      capabilities = undefined;
    },
  });
}

async function investigate(
  receipt: Receipt,
  identity: DebuggerIdentity,
  signal: AbortSignal,
  owner: {
    api: OpenClawPluginApi;
    config: OncallConfig;
    capabilities: ServiceCapabilities;
    sourceConfig: SourceConfig;
    assertCurrent(): void;
  },
) {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(owner.config.maxRunMs)]);
  const token = owner.capabilities.issue(receipt.alert, {
    ...identity,
    agentId: "oncall",
    signal: lifetime,
  });
  try {
    return await runDebugger({
      ...owner,
      alert: receipt.alert,
      identity,
      token,
      signal: lifetime,
      run: owner.api.runtime.agent.runEmbeddedAgent,
    });
  } finally {
    owner.capabilities.revoke(token);
  }
}

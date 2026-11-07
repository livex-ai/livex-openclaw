import { createOncallCatalogReader } from "@livex/investigations/oncall-catalog";
import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { validateConfig } from "../core.mjs";
import { publicGcpConfig, publicGcpEntry } from "./calendar-config.js";
import { createCalendarRoster } from "./calendar.js";
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
  type Roster,
  type SlackTransport,
  type SourceConfig,
} from "./types.js";

type Catalog = Pick<ReturnType<typeof createOncallCatalogReader>, "lookup">;
type CoordinatorParams = {
  config: OncallConfig;
  store: ReceiptStore;
  slack: SlackTransport;
  scheduler: PluginServiceSchedulerV1;
  assertCurrent(): void;
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
  let roster: Roster = {};
  let lastRosterWarning: string | undefined;

  function reportRosterWarning(message?: string) {
    if (message && message !== lastRosterWarning) {
      params.health(message);
    }
    lastRosterWarning = message;
  }

  async function diagnose(
    receipt: Receipt,
    identity: DebuggerIdentity,
    child: PluginServiceSchedulerV1,
  ) {
    let reserved = false;
    try {
      await params.store.change(receipt.alert.key, (current) => {
        if (current.phase !== "queued") {
          throw new Error("Investigation already reserved");
        }
        return { ...current, phase: "dispatch_reserved", runId: identity.runId };
      });
      reserved = true;
      params.assertCurrent();
      const assessment = await params.investigate(receipt, identity, child.signal);
      child.signal.throwIfAborted();
      params.assertCurrent();
      const findings = await classify(assessment, params.catalog);
      child.signal.throwIfAborted();
      params.assertCurrent();
      await complete(receipt, identity, findings);
    } catch {
      if (reserved && !child.signal.aborted) {
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

  function dispatch(receipt: Receipt) {
    if (running.size >= params.config.maxConcurrent || running.has(receipt.alert.key)) {
      return;
    }
    const child = params.scheduler.scope();
    const identity = debuggerIdentity(receipt.alert);
    running.add(receipt.alert.key);
    child.schedule({ id: "debugger", delayMs: 0, run: () => diagnose(receipt, identity, child) });
  }

  async function tick() {
    params.assertCurrent();
    const now = params.scheduler.now();
    await params.slack.verify();
    try {
      await scanAlerts({ ...params, now, clock: params.scheduler.now });
    } catch {
      params.health("Oncall intake incomplete or unavailable. Check source and receipt capacity.");
    }
    params.assertCurrent();
    roster = await params.slack.roster();
    reportRosterWarning(roster.warning);
    if (roster.error) {
      params.health(roster.error);
    }
    for (const receipt of await params.store.list()) {
      try {
        await processReceipt(receipt, now);
      } catch {
        params.health(
          "Oncall receipt processing failed; later independent receipts remain eligible.",
        );
      }
    }
  }

  async function processReceipt(receipt: Receipt, now: number) {
    params.assertCurrent();
    if (receipt.phase === "queued") {
      dispatch(receipt);
    }
    if (receipt.phase === "assessed" || receipt.phase === "dispatch_uncertain") {
      await notifyReceipt(receipt, roster, {
        ...params,
        now,
        clock: params.scheduler.now,
        reportRosterWarning,
      });
    }
  }

  return {
    tick,
    async start() {
      await reconcileNotifications(params.store, params.health);
      params.scheduler.schedule({
        id: "tick",
        delayMs: 0,
        everyMs: params.config.tickMs,
        run: async () => {
          try {
            await tick();
          } catch {
            params.health("Oncall tick failed. Inspect service state before recovery.");
          }
        },
      });
    },
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
    publicGcpEntry(config.plugins?.entries?.["livex-gcp-readonly"]),
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

export function registerOncall(api: OpenClawPluginApi) {
  let capabilities: ServiceCapabilities | undefined;
  for (const name of SERVICE_TOOLS) {
    api.registerTool(
      { contextVersion: 2, create: (context) => capabilities?.createTool(context, name) ?? null },
      { name, optional: true, workspaceAccess: false },
    );
  }
  api.registerService({
    id: "livex-oncall-coordinator",
    apiVersion: 2,
    async start(context) {
      const config = parseOncallConfig(api.pluginConfig?.oncall);
      if (!config) {
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
      capabilities = createServiceCapabilities({
        config,
        gcpConfig: publicGcpConfig(api.pluginConfig),
        signal: lifecycle,
        now: context.scheduler.now,
        assertCurrent,
      });
      const slack = createOncallSlack({
        config,
        sourceConfig: context.config,
        signal: context.scheduler.signal,
        assertCurrent,
      });
      const resolveRoster = createCalendarRoster({
        config,
        signal: context.scheduler.signal,
        now: context.scheduler.now,
        assertCurrent,
        canvas: () => slack.roster(),
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
      const sourceId = createReceiptScope(
        config,
        validateConfig(publicGcpConfig(api.pluginConfig)),
        catalog.sourceIdentity,
      );
      const source = api.runtime.state.openKeyedStoreV2<
        Receipt | { timestamp: string; sourceId: string }
      >(
        {
          namespace: "oncall-receipts",
          maxEntries: config.maxReceipts + 1,
          overflowPolicy: "reject-new",
        },
        { assertCurrent },
      );
      const store = createReceiptStore(source, sourceId, (count) =>
        api.logger.warn(
          `Oncall retained ${count} receipts outside the current source; automatic effects are suppressed.`,
        ),
      );
      const coordinator = createCoordinator({
        config,
        store,
        slack: { ...slack, roster: resolveRoster },
        scheduler: context.scheduler,
        catalog,
        assertCurrent,
        health: (message) => api.logger.warn(message),
        investigate: (receipt, identity, signal) =>
          investigate(receipt, identity, signal, {
            api,
            config,
            capabilities: capabilities!,
            sourceConfig: context.config,
            assertCurrent,
          }),
      });
      await coordinator.start();
    },
    async stop() {
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

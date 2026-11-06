import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { AgentReportProfile, PreparedAgentReport } from "openclaw/plugin-sdk/report-profiles";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { AmendmentRequest, StagedAmendment } from "./amendment.js";
import type { CatalogSnapshot, CompletedInvestigation, HistoryScope } from "./schema.js";
import { observeLogPage, type TrendCapture } from "./trend-evidence.js";
import type { StagedTrend } from "./trend.js";
export type InvestigationTurnInput = {
  amendmentRequest?: AmendmentRequest;
  id: string;
  scope: HistoryScope;
  sessionKey: string;
  filePath: string;
  snapshot: CatalogSnapshot;
  reportProfile?: AgentReportProfile;
  assertCurrent: () => void;
};
export type StagedInvestigation = {
  trend?: StagedTrend;
  finalText: string;
  updates: CompletedInvestigation[];
  report?: PreparedAgentReport;
  legacyAcknowledgement?: string;
};

function matchStaged(staged: StagedInvestigation | undefined, finalText: string) {
  const acknowledgement = finalText.trim();
  return staged &&
    (staged.finalText === acknowledgement || staged.legacyAcknowledgement === acknowledgement)
    ? staged
    : undefined;
}
export type InvestigationTurn = InvestigationTurnInput & {
  lifecycle: (
    upstream?: GetReplyOptions["turnAdoptionLifecycle"],
  ) => NonNullable<GetReplyOptions["turnAdoptionLifecycle"]>;
  releaseImmediate: () => void;
  reportExpected?: boolean;
  amendment?: StagedAmendment;
  trendCapture?: TrendCapture;
  matchFinal: (finalText: string) => StagedInvestigation | undefined;
};

export function sameInvestigationScope(left: HistoryScope, right: HistoryScope): boolean {
  return (
    left.agentId === right.agentId &&
    left.accountId === right.accountId &&
    left.teamId === right.teamId &&
    left.channelId === right.channelId &&
    left.senderId === right.senderId
  );
}

/** Request entries belong to one investigation plugin instance; queued custody retains its own entry. */
export function createInvestigationTurnRegistry() {
  const entries = new Map<string, { turn: InvestigationTurn; staged?: StagedInvestigation }>();
  let active = true;
  const requireTurn = (id: string) => {
    const entry = active ? entries.get(id) : undefined;
    if (!entry) {
      throw new Error("Slack investigation turn is no longer active");
    }
    entry.turn.assertCurrent();
    return entry;
  };
  return {
    register(input: InvestigationTurnInput): InvestigationTurn {
      if (!active || entries.has(input.id) || entries.size >= 200) {
        throw new Error("Slack investigation turn registry is unavailable or full");
      }
      input.assertCurrent();
      let deferred = false;
      const release = () => {
        entries.delete(input.id);
      };
      const turn: InvestigationTurn = {
        ...input,
        assertCurrent() {
          if (!active || entries.get(input.id)?.turn !== turn) {
            throw new Error("Slack investigation turn is no longer active");
          }
          input.assertCurrent();
        },
        lifecycle(upstream) {
          return {
            ...upstream,
            onAdopted: async () => {
              await upstream?.onAdopted();
            },
            onDeferred: () => {
              const accepted = upstream?.onDeferred?.();
              if (accepted === false) {
                release();
                return false;
              }
              deferred = true;
              return accepted;
            },
            onAbandoned: async () => {
              try {
                await upstream?.onAbandoned?.();
              } finally {
                release();
              }
            },
            onSettled: async () => {
              try {
                await upstream?.onSettled?.();
              } finally {
                // Immediate model settlement precedes Slack final delivery; dispatch owns cleanup.
                if (deferred) {
                  release();
                }
              }
            },
          };
        },
        releaseImmediate() {
          if (!deferred) {
            release();
          }
        },
        matchFinal(finalText) {
          const entry = requireTurn(input.id);
          return matchStaged(entry.staged, finalText);
        },
      };
      entries.set(input.id, { turn });
      return turn;
    },
    observeTrendTool(
      event: {
        toolName: string;
        toolCallId?: string;
        params: Record<string, unknown>;
        result?: unknown;
        error?: string;
      },
      ctx: {
        agentId?: string;
        sessionKey?: string;
        runId?: string;
        requester?: { senderId?: string; accountId?: string; channel?: string };
      },
    ) {
      if (event.error || !ctx.runId || !ctx.sessionKey || !ctx.agentId) return;
      const begin =
        event.toolName === "slack_investigation_record" && event.params.action === "begin_trend";
      if (!begin && event.toolName !== "livex_gcp_logs_read") return;
      const matches = [...entries.values()]
        .map((e) => e.turn)
        .filter(
          (t) =>
            t.trendCapture &&
            t.scope.agentId === ctx.agentId &&
            t.sessionKey === ctx.sessionKey &&
            (!ctx.requester?.senderId || ctx.requester.senderId === t.scope.senderId) &&
            (!ctx.requester?.accountId || ctx.requester.accountId === t.scope.accountId) &&
            (!ctx.requester?.channel || ctx.requester.channel === "slack") &&
            (begin
              ? t.trendCapture.startCall === event.toolCallId
              : t.trendCapture.runId === ctx.runId),
        );
      if (matches.length !== 1) return;
      const turn = matches[0]!;
      turn.assertCurrent();
      if (begin) turn.trendCapture!.runId = ctx.runId;
      else observeLogPage(turn.trendCapture!, event.params, event.result);
    },
    get(id: string): InvestigationTurn | undefined {
      return active ? entries.get(id)?.turn : undefined;
    },
    clearStaged(id: string): void {
      const entry = requireTurn(id);
      delete entry.staged;
      delete entry.turn.amendment;
      delete entry.turn.reportExpected;
    },
    stageTrend(id: string, observation: StagedTrend) {
      requireTurn(id).staged = {
        trend: structuredClone(observation),
        updates: [],
        finalText: observation.finalText,
      };
    },
    stage(
      id: string,
      scope: HistoryScope,
      finalText: string,
      updates: CompletedInvestigation[],
      report?: PreparedAgentReport,
      legacyAcknowledgement?: string,
    ): void {
      const entry = requireTurn(id);
      if (
        !sameInvestigationScope(entry.turn.scope, scope) ||
        updates.some((update) => !sameInvestigationScope(update.signature.scope, scope))
      ) {
        throw new Error("Slack investigation scope does not match this turn");
      }
      if (
        !finalText.trim() ||
        finalText.length > 32_000 ||
        updates.length === 0 ||
        updates.length > 20 ||
        (report !== undefined && report.text.trim() !== finalText.trim()) ||
        (legacyAcknowledgement !== undefined &&
          (!legacyAcknowledgement.trim() || legacyAcknowledgement.length > 32_000))
      ) {
        throw new Error("Stage one to twenty investigations with a bounded exact final reply");
      }
      // Model input crosses the boundary once; later model mutations cannot change prepared facts.
      entry.turn.reportExpected = true;
      entry.staged = structuredClone({
        finalText: finalText.trim(),
        updates,
        ...(report ? { report } : {}),
        ...(legacyAcknowledgement ? { legacyAcknowledgement: legacyAcknowledgement.trim() } : {}),
      });
    },
    matchFinal(id: string, finalText: string): StagedInvestigation | undefined {
      const entry = requireTurn(id);
      return matchStaged(entry.staged, finalText);
    },
    close(): void {
      active = false;
      entries.clear();
    },
  };
}
export type InvestigationTurnRegistry = ReturnType<typeof createInvestigationTurnRegistry>;

const store = createPluginRuntimeStore<InvestigationTurnRegistry>({
  key: "livex:investigation-turns",
  errorMessage: "Slack investigation runtime is not initialized",
});
export function getInvestigationTurnRegistry(): InvestigationTurnRegistry {
  const current = store.tryGetRuntime();
  if (current) {
    return current;
  }
  const registry = createInvestigationTurnRegistry();
  store.setRuntime(registry);
  return registry;
}
export const tryGetInvestigationTurnRegistry = store.tryGetRuntime;
export function closeInvestigationTurnRegistry(): void {
  store.tryGetRuntime()?.close();
  store.clearRuntime();
}

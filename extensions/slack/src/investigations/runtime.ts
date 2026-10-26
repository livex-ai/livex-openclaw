import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { CatalogSnapshot, CompletedInvestigation, HistoryScope } from "./schema.js";

export type InvestigationTurnInput = {
  id: string;
  scope: HistoryScope;
  sessionKey: string;
  filePath: string;
  snapshot: CatalogSnapshot;
  assertCurrent: () => void;
};
export type StagedInvestigation = { finalText: string; updates: CompletedInvestigation[] };
export type InvestigationTurn = InvestigationTurnInput & {
  lifecycle: (
    upstream?: GetReplyOptions["turnAdoptionLifecycle"],
  ) => NonNullable<GetReplyOptions["turnAdoptionLifecycle"]>;
  releaseImmediate: () => void;
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

/** Request entries belong to one Slack runtime instance; queued custody retains its own entry. */
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
                release();
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
          return entry.staged?.finalText === finalText.trim() ? entry.staged : undefined;
        },
      };
      entries.set(input.id, { turn });
      return turn;
    },
    get(id: string): InvestigationTurn | undefined {
      return active ? entries.get(id)?.turn : undefined;
    },
    stage(
      id: string,
      scope: HistoryScope,
      finalText: string,
      updates: CompletedInvestigation[],
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
        updates.length > 20
      ) {
        throw new Error("Stage one to twenty investigations with a bounded exact final reply");
      }
      // Model input crosses the boundary once; later model mutations cannot change prepared facts.
      entry.staged = { finalText: finalText.trim(), updates: structuredClone(updates) };
    },
    matchFinal(id: string, finalText: string): StagedInvestigation | undefined {
      const entry = requireTurn(id);
      return entry.staged?.finalText === finalText.trim() ? entry.staged : undefined;
    },
    close(): void {
      active = false;
      entries.clear();
    },
  };
}
export type InvestigationTurnRegistry = ReturnType<typeof createInvestigationTurnRegistry>;

const store = createPluginRuntimeStore<InvestigationTurnRegistry>({
  key: "slack:investigation-turns",
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

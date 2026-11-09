import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  bindLinkedReportEditAuthority,
  type ReplyTurnProviderRegistration,
} from "./reply-turn-report-edits.js";
import type { PreparedReplyTurn, ReplyTurnInput } from "./reply-turn.types.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";

/** Select one admitted owner without loading plugins or depending on registration order. */
export function resolveReplyTurnProviderRegistration(
  registry: PluginRegistry,
  agentId: string,
  channel: string,
): ReplyTurnProviderRegistration | undefined {
  const active = registry.replyTurnProviders.filter((entry) => {
    const owner = registry.plugins.find((plugin) => plugin.id === entry.pluginId);
    return owner?.enabled && owner.status === "loaded";
  });
  const matches = active.filter(
    (entry) =>
      entry.provider.agentIds.includes(agentId) && entry.provider.channels.includes(channel),
  );
  const selected = matches.length === 1 ? matches[0] : undefined;
  return selected &&
    active.filter((entry) => entry.provider.id === selected.provider.id).length === 1
    ? selected
    : undefined;
}

function onceTerminal(callback?: () => void | Promise<void>): () => Promise<void> {
  let completion: Promise<void> | undefined;
  return () => (completion ??= Promise.resolve().then(callback));
}

/** Host custody must settle even when the plugin can no longer admit cleanup calls. */
function withHostReplyTurnCleanup(
  contribution: PreparedReplyTurn,
  assertHostCurrent: () => void,
): PreparedReplyTurn {
  const owner = getPluginValueInstance(contribution.releaseImmediate);
  const isOwnerRetirement = (error: unknown) =>
    owner &&
    !owner.acceptingCalls &&
    (error instanceof PluginInstanceUnavailableError ||
      (owner.lifecycle.signal.aborted && error === owner.lifecycle.signal.reason));
  return {
    ...contribution,
    assertCurrent() {
      assertHostCurrent();
      contribution.assertCurrent();
    },
    lifecycle(upstream) {
      const abandoned = onceTerminal(upstream?.onAbandoned);
      const settled = onceTerminal(upstream?.onSettled);
      const lifecycle = contribution.lifecycle(
        upstream && { ...upstream, onAbandoned: abandoned, onSettled: settled },
      );
      const terminal = (
        callback: (() => void | Promise<void>) | undefined,
        finishHost: () => Promise<void>,
      ) =>
        onceTerminal(async () => {
          const errors: unknown[] = [];
          try {
            await callback?.();
          } catch (error) {
            if (!isOwnerRetirement(error)) {
              errors.push(error);
            }
          }
          try {
            await finishHost();
          } catch (error) {
            if (!errors.includes(error)) {
              errors.push(error);
            }
          }
          if (errors.length === 1) {
            throw errors[0];
          }
          if (errors.length > 1) {
            throw new AggregateError(errors, "Reply turn terminal cleanup failed");
          }
        });
      return {
        ...lifecycle,
        onAbandoned: terminal(lifecycle.onAbandoned, abandoned),
        onSettled: terminal(lifecycle.onSettled, settled),
      };
    },
    releaseImmediate() {
      try {
        contribution.releaseImmediate();
      } catch (error) {
        if (!isOwnerRetirement(error)) {
          throw error;
        }
      }
    },
  };
}

/** The channel supplies authenticated facts; the selected plugin owns its contribution. */
export async function prepareAgentReplyTurn(
  input: ReplyTurnInput,
): Promise<PreparedReplyTurn | undefined> {
  const { agentId, channel, assertCurrent, signal } = input;
  const assertHostCurrent = () => {
    assertCurrent.call(input);
    signal?.throwIfAborted();
  };
  assertHostCurrent();
  const registry = getPluginRegistryForContext();
  const registration = registry
    ? resolveReplyTurnProviderRegistration(registry, agentId, channel)
    : undefined;
  if (!registration) {
    return undefined;
  }
  const { provider } = registration;
  const { prepare } = provider;
  const contribution = await prepare.call(provider, input);
  const turn = contribution ? withHostReplyTurnCleanup(contribution, assertHostCurrent) : undefined;
  try {
    if (turn) {
      turn.assertCurrent();
      bindLinkedReportEditAuthority(registration, prepare, { agentId, channel }, turn);
    } else {
      assertHostCurrent();
    }
    return turn;
  } catch (error) {
    try {
      turn?.releaseImmediate();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Reply turn preparation and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

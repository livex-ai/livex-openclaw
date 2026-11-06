import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import type { PluginRegistry } from "./registry-types.js";
import type { PreparedReplyTurn, ReplyTurnInput, ReplyTurnProvider } from "./reply-turn.types.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";

/** Select one admitted owner without loading plugins or depending on registration order. */
export function resolveReplyTurnProviderFromRegistry(
  registry: PluginRegistry,
  agentId: string,
  channel: string,
): ReplyTurnProvider | undefined {
  const active = registry.replyTurnProviders.filter((entry) => {
    const owner = registry.plugins.find((plugin) => plugin.id === entry.pluginId);
    return owner?.enabled && owner.status === "loaded";
  });
  const matches = active.filter(
    (entry) =>
      entry.provider.agentIds.includes(agentId) && entry.provider.channels.includes(channel),
  );
  const selected = matches.length === 1 ? matches[0]?.provider : undefined;
  return selected && active.filter((entry) => entry.provider.id === selected.id).length === 1
    ? selected
    : undefined;
}

function onceTerminal(callback?: () => void | Promise<void>): () => Promise<void> {
  let completion: Promise<void> | undefined;
  return () => (completion ??= Promise.resolve().then(callback));
}

/** Host custody must settle even when the plugin can no longer admit cleanup calls. */
function withHostReplyTurnCleanup(contribution: PreparedReplyTurn): PreparedReplyTurn {
  const owner = getPluginValueInstance(contribution.releaseImmediate);
  const isOwnerRetirement = (error: unknown) =>
    owner &&
    !owner.acceptingCalls &&
    (error instanceof PluginInstanceUnavailableError ||
      (owner.lifecycle.signal.aborted && error === owner.lifecycle.signal.reason));
  return {
    ...contribution,
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
  input.assertCurrent();
  input.signal?.throwIfAborted();
  const registry = getPluginRegistryForContext();
  const provider = registry
    ? resolveReplyTurnProviderFromRegistry(registry, input.agentId, input.channel)
    : undefined;
  if (!provider) {
    return undefined;
  }
  const contribution = await provider.prepare(input);
  const turn = contribution ? withHostReplyTurnCleanup(contribution) : undefined;
  try {
    input.assertCurrent();
    input.signal?.throwIfAborted();
    turn?.assertCurrent();
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

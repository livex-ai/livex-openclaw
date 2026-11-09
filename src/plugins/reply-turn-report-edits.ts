import { getPluginValueInstance, type PluginInstanceHandle } from "./plugin-instance-scope.js";
import type { PluginRegistry } from "./registry-types.js";
import type { PreparedReplyTurn, ReplyTurnInput, ReplyTurnProvider } from "./reply-turn.types.js";

export type ReplyTurnProviderRegistration = PluginRegistry["replyTurnProviders"][number];

const linkedReportEditRegistrations = new WeakMap<
  ReplyTurnProviderRegistration,
  {
    owner: PluginInstanceHandle;
    prepare: ReplyTurnProvider["prepare"];
    agentIds: readonly string[];
    channels: readonly string[];
  }
>();
const linkedReportEditOwners = new WeakMap<PreparedReplyTurn, PluginInstanceHandle>();

/** Snapshot the managed registration before the registry can be exposed to plugins. */
export function registerLinkedReportEditAuthority(
  registration: ReplyTurnProviderRegistration,
): void {
  const { allowLinkedReportEdits, prepare, agentIds, channels } = registration.provider;
  const owner = getPluginValueInstance(prepare);
  if (allowLinkedReportEdits === true && owner) {
    linkedReportEditRegistrations.set(registration, {
      owner,
      prepare,
      agentIds: [...agentIds],
      channels: [...channels],
    });
  }
}

export function bindLinkedReportEditAuthority(
  registration: ReplyTurnProviderRegistration,
  prepare: ReplyTurnProvider["prepare"],
  input: Pick<ReplyTurnInput, "agentId" | "channel">,
  turn: PreparedReplyTurn,
): void {
  const grant = linkedReportEditRegistrations.get(registration);
  if (
    grant?.prepare === prepare &&
    grant.owner.pluginId === registration.pluginId &&
    grant.owner === getPluginValueInstance(turn.createDelivery) &&
    grant.agentIds.includes(input.agentId) &&
    grant.channels.includes(input.channel)
  ) {
    linkedReportEditOwners.set(turn, grant.owner);
  }
}

export function assertLinkedReportEditAuthority(turn: PreparedReplyTurn): void {
  const owner = linkedReportEditOwners.get(turn);
  if (!owner) {
    throw new Error("Reply turn provider cannot make linked report edits");
  }
  if (!owner.acceptingCalls || owner.owner?.revoked || owner.lifecycle.signal.aborted) {
    throw new Error("Linked report edit provider is no longer current");
  }
}

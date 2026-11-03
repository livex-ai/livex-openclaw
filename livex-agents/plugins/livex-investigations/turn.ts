import { randomUUID } from "node:crypto";
import type { PreparedReplyTurn, ReplyTurnInput } from "openclaw/plugin-sdk/reply-turns";
import { resolveAgentReportProfile } from "openclaw/plugin-sdk/report-profiles";
import { resolveInvestigationCatalogPath } from "./config.js";
import { createInvestigationDelivery } from "./delivery.js";
import { lookupInvestigationHistory } from "./lookup.js";
import { getInvestigationTurnRegistry } from "./runtime.js";
import type { HistoryScope } from "./schema.js";

/** Policy belongs to this plugin; the channel supplies only authenticated turn facts. */
export async function prepareInvestigationReplyTurn(
  input: ReplyTurnInput,
): Promise<PreparedReplyTurn | undefined> {
  const filePath = resolveInvestigationCatalogPath(input.config, input.agentId);
  if (!filePath || input.channel !== "slack" || input.isDirectMessage) {
    return undefined;
  }
  const assertCurrent = () => {
    input.assertCurrent();
    input.signal?.throwIfAborted();
  };
  assertCurrent();
  const scope: HistoryScope = {
    agentId: input.agentId,
    accountId: input.accountId,
    teamId: input.workspaceId,
    channelId: input.nativeChannelId,
    senderId: input.senderId,
  };
  const lookup = await lookupInvestigationHistory({
    cfg: input.config,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    scope,
    filePath,
    query: input.query.slice(0, 2_000),
    assertCurrent,
    signal: input.signal,
  });
  assertCurrent();
  const reportProfile = resolveAgentReportProfile(input.agentId, input.channel);
  const turn = getInvestigationTurnRegistry().register({
    id: randomUUID(),
    scope,
    sessionKey: input.sessionKey,
    filePath,
    snapshot: lookup.snapshot,
    reportProfile,
    assertCurrent,
  });
  return {
    context: `\n\n${lookup.context}\nBefore your final reply call slack_investigation_record prepare_update with per-issue facts and the exact finalText. Never treat missing or partial history as a successful empty check.`,
    toolBindings: { slack_investigation: { turnId: turn.id } },
    reportProfile,
    assertCurrent: turn.assertCurrent,
    lifecycle: turn.lifecycle,
    releaseImmediate: turn.releaseImmediate,
    createDelivery: (host) => createInvestigationDelivery({ ...host, turn }),
  };
}

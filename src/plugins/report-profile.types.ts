import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";

/** Pure plugin-owned projection; channel delivery and durable effects stay host-owned. */
export type PreparedAgentReport = {
  profileId: string;
  text: string;
  channelData?: ReplyPayload["channelData"];
  /** Serializable state owned by this profile, retained with the prepared turn. */
  state: unknown;
};

export type AgentReportContext = Readonly<Record<string, unknown>>;
export type AgentReportProfile = {
  id: string;
  agentIds: readonly string[];
  channels: readonly string[];
  inputSchema: JsonSchemaObject;
  instructions: string;
  prepare: (input: unknown, context: AgentReportContext) => PreparedAgentReport;
  appendNotice: (
    prepared: PreparedAgentReport,
    notice: string,
    context: AgentReportContext,
  ) => PreparedAgentReport;
  prepareLegacy?: (text: string, context: AgentReportContext) => PreparedAgentReport | undefined;
};

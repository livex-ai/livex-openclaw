import type { AgentReportProfile, PreparedAgentReport } from "openclaw/plugin-sdk/report-profiles";
import { z } from "zod";
import {
  appendCompactReportNotice,
  compactReportParameters,
  prepareCompactReport,
  readPreparedCompactReport,
  type PreparedCompactReport,
} from "./compact-report.js";
import { buildSlackThreadSummaryCard } from "./legacy-report.js";
import { readReportContext } from "./report-context.js";

export const ONCALL_REPORT_PROFILE = "livex-oncall-reports/compact-v1";
export function projectCompactReport(prepared: PreparedCompactReport): PreparedAgentReport {
  return {
    profileId: ONCALL_REPORT_PROFILE,
    text: prepared.text,
    channelData: { slack: { threadSummaryCard: prepared.card } },
    state: prepared.form,
  };
}
const legacyContext = z.object({
  agentId: z.string(),
  botUserId: z.string().optional(),
  teamId: z.string().optional(),
  isDirectMessage: z.boolean(),
  originalThreadTs: z.string(),
  contextThreadTs: z.string(),
  replyThreadTs: z.string(),
  textLimit: z.number().optional(),
});
export function createOncallReportProfile(agentIds: readonly string[]): AgentReportProfile {
  return {
    id: ONCALL_REPORT_PROFILE,
    agentIds,
    channels: ["slack"],
    inputSchema: compactReportParameters,
    instructions:
      "Fill Title, Priority, Summary, Next action and Evidence; optional factual badge. Return exactly the prepared finalText without extra prose or markers. Ownership, recovery and evidence claims require typed support; unknowns stay unknown.",
    prepare(input, context) {
      const { updates, findings } = readReportContext(context);
      return projectCompactReport(prepareCompactReport(input, updates, findings));
    },
    appendNotice(prepared, notice, context) {
      const { updates } = readReportContext(context);
      const form = readPreparedCompactReport(prepared.state);
      return projectCompactReport(appendCompactReportNotice({ form }, updates, notice));
    },
    prepareLegacy(text, context) {
      const parsed = legacyContext.safeParse(context);
      if (!parsed.success) {
        return undefined;
      }
      const value = parsed.data;
      if (
        value.agentId !== "oncall" ||
        value.botUserId !== "U09JKS5FHUM" ||
        value.teamId !== "T04MA1X41CM" ||
        value.isDirectMessage ||
        !value.originalThreadTs ||
        value.contextThreadTs !== value.originalThreadTs ||
        value.replyThreadTs !== value.originalThreadTs
      ) {
        return undefined;
      }
      // Existing legacy policy supplies no verified critical-impact authority.
      const card = buildSlackThreadSummaryCard(text, { textLimit: value.textLimit });
      return card
        ? {
            profileId: ONCALL_REPORT_PROFILE,
            text,
            channelData: { slack: { threadSummaryCard: card } },
            state: null,
          }
        : undefined;
    },
  };
}

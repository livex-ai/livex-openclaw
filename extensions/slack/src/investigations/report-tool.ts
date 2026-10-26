import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { projectInvestigationIssue } from "./lookup.js";
import { compareFindings } from "./matching.js";
import { compactReportParameters, prepareCompactReport } from "./report-form.js";
import { sameInvestigationScope, tryGetInvestigationTurnRegistry } from "./runtime.js";
import { parseCompletedInvestigations } from "./schema.js";
import { readCatalog } from "./store.js";

const boundedText = { type: "string", minLength: 1, maxLength: 8000 } as const;
const links = { type: "array", maxItems: 30, items: { type: "string", maxLength: 4096 } } as const;
const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["lookup", "prepare_update"] },
    issueIds: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 128 },
    },
    report: compactReportParameters,
    finalText: {
      type: "string",
      minLength: 1,
      maxLength: 32000,
      description: "Legacy acknowledgement only; compact content derives from typed updates.",
    },
    updates: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          signature: {
            type: "object",
            properties: {
              service: boundedText,
              environment: boundedText,
              operation: boundedText,
              error: boundedText,
              resource: boundedText,
            },
            required: ["service", "environment", "operation", "error"],
            additionalProperties: false,
          },
          task: boundedText,
          status: boundedText,
          historySummary: boundedText,
          waitingOn: { type: "string", maxLength: 8000 },
          prs: links,
          slackThreads: links,
          jiraTickets: links,
          facts: {
            type: "object",
            properties: {
              finding: boundedText,
              impact: boundedText,
              nextAction: boundedText,
              evidence: boundedText,
              disposition: boundedText,
              recovery: boundedText,
              owner: {
                type: "object",
                properties: { name: boundedText, evidenceUrl: boundedText },
                required: ["name", "evidenceUrl"],
                additionalProperties: false,
              },
            },
            required: ["finding", "impact", "nextAction"],
            additionalProperties: false,
          },
          evidenceUrls: links,
        },
        required: [
          "signature",
          "task",
          "status",
          "historySummary",
          "waitingOn",
          "prs",
          "slackThreads",
          "jiraTickets",
          "facts",
          "evidenceUrls",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

/** The definition stays stable; current invocation and channel ownership gate execution. */
export function createInvestigationRecordTool(ctx: OpenClawPluginToolContext<2>): AnyAgentTool {
  return {
    name: "slack_investigation_record",
    label: "Investigation record",
    description:
      "Look up this authorized oncall turn's catalog, or prepare completed findings and a compact report form. prepare_update takes report (Title, Priority, Summary, Next action, Evidence; optional factual badge) plus one update per independent finding. The host validates and renders the final; return exactly the returned finalText without extra prose or markers. Legacy finalText input is an acknowledgement only: content derives from typed updates, never its prose. Supply report OR legacy finalText, not both. The tool stages only; confirmed Slack delivery owns catalog saving. Ownership, recovery and evidence claims require typed support; unknowns stay unknown.",
    parameters,
    async execute(_toolCallId, input, signal) {
      ctx.assertInvocationCurrent();
      signal?.throwIfAborted();
      const binding = asOptionalRecord(ctx.toolBindings?.slack_investigation);
      const registry = tryGetInvestigationTurnRegistry();
      const turnId = typeof binding?.turnId === "string" ? binding.turnId : undefined;
      const turn = turnId ? registry?.get(turnId) : undefined;
      if (!turn || !turnId || !registry) {
        throw new Error("No active Slack investigation turn is bound");
      }
      if (
        ctx.messageChannel !== "slack" ||
        ctx.agentId !== turn.scope.agentId ||
        ctx.agentAccountId !== turn.scope.accountId ||
        ctx.nativeChannelId !== turn.scope.channelId ||
        ctx.requesterSenderId !== turn.scope.senderId ||
        ctx.sessionKey !== turn.sessionKey
      ) {
        throw new Error("Slack investigation caller scope does not match the bound turn");
      }
      turn.assertCurrent();
      const args = asOptionalRecord(input);
      if (args?.action === "lookup") {
        if (
          args.issueIds !== undefined &&
          (!Array.isArray(args.issueIds) ||
            args.issueIds.length > 20 ||
            args.issueIds.some(
              (value) => typeof value !== "string" || !value || value.length > 128,
            ))
        ) {
          throw new Error("lookup issueIds must contain at most twenty bounded Issue IDs");
        }
        const snapshot = await readCatalog({ filePath: turn.filePath, scope: turn.scope });
        ctx.assertInvocationCurrent();
        turn.assertCurrent();
        signal?.throwIfAborted();
        turn.snapshot = snapshot;
        const requestedIds = Array.isArray(args.issueIds) ? new Set(args.issueIds) : undefined;
        const selected = requestedIds
          ? snapshot.issues.filter((issue) => requestedIds.has(issue.issueId))
          : snapshot.issues;
        const issues = [];
        let size = 0;
        for (const issue of selected) {
          const summary = projectInvestigationIssue(issue);
          const length = JSON.stringify(summary).length;
          if (issues.length >= 20 || size + length > 12000) {
            break;
          }
          issues.push(summary);
          size += length;
        }
        return jsonResult({
          status: snapshot.status,
          reason: snapshot.reason,
          issues,
          truncated: issues.length < selected.length,
          totalIssues: snapshot.issues.length,
        });
      }
      if (args?.action !== "prepare_update") {
        throw new Error("Use lookup or prepare_update");
      }
      // A failed later attempt must not leave an older final eligible for publication.
      registry.clearStaged(turnId);
      const legacyText = typeof args.finalText === "string" ? args.finalText.trim() : undefined;
      if (
        !Array.isArray(args.updates) ||
        (args.report === undefined && !legacyText) ||
        (args.report !== undefined && args.finalText !== undefined) ||
        (args.finalText !== undefined && (!legacyText || legacyText.length > 32000))
      ) {
        throw new Error(
          "prepare_update requires completed updates and report OR legacy finalText, not both",
        );
      }
      const updates = parseCompletedInvestigations(
        args.updates.map((value) => {
          const update = asOptionalRecord(value);
          const signature = asOptionalRecord(update?.signature);
          return { ...update, signature: { ...signature, scope: turn.scope } };
        }),
      );
      if (updates.some((update) => !sameInvestigationScope(update.signature.scope, turn.scope))) {
        throw new Error("Slack investigation signature scope does not match this turn");
      }
      const comparisons = compareFindings(turn.snapshot, updates);
      const prepared = prepareCompactReport(args.report, updates, comparisons);
      const findings = comparisons.map(
        ({ kind, issueId, canonicalThreadUrl, changes, reason }) => ({
          kind,
          issueId,
          canonicalThreadUrl,
          changes,
          reason,
        }),
      );
      ctx.assertInvocationCurrent();
      turn.assertCurrent();
      signal?.throwIfAborted();
      registry.stage(turnId, turn.scope, prepared.text, updates, prepared, legacyText);
      return jsonResult({
        status: "prepared",
        historyStatus: turn.snapshot.status,
        finalText: prepared.text,
        findings,
        instruction:
          "Return exactly finalText. The host renders the compact report; add no labels, markers or extra prose. Nothing has been sent or recorded yet.",
      });
    },
  };
}

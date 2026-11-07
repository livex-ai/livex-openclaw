import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentReportProfile } from "openclaw/plugin-sdk/report-profiles";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { prepareAmendment } from "./amendment.js";
import { projectInvestigationIssue } from "./lookup.js";
import { compareFindings } from "./matching.js";
import { reportContext } from "./report-context.js";
import { sameInvestigationScope, tryGetInvestigationTurnRegistry } from "./runtime.js";
import {
  assertNoSensitiveContent,
  hasCompleteSignature,
  issueSignatureSchema,
  normalizeSignature,
  parseCompletedInvestigations,
  signatureKey,
  type CatalogSnapshot,
  type IssueSignature,
} from "./schema.js";
import { readCatalog } from "./store.js";
import { measuredTrend } from "./trend-evidence.js";
import { trendSummary } from "./trend.js";

const boundedText = { type: "string", minLength: 1, maxLength: 8000 } as const;
const links = { type: "array", maxItems: 30, items: { type: "string", maxLength: 4096 } } as const;
const lookupSignaturePart = { type: "string", minLength: 1, maxLength: 512 } as const;
const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["lookup", "prepare_update", "amend_current_report", "begin_trend", "record_trend"],
    },
    earlierEvidenceUrl: { type: "string", maxLength: 2048 },
    laterEvidenceUrl: { type: "string", maxLength: 2048 },
    changes: {
      type: "object",
      additionalProperties: false,
      properties: {
        priority: { type: "string", enum: ["Unknown", "Low", "Medium", "High", "Critical"] },
        nextAction: { type: "string", minLength: 1, maxLength: 2000 },
        acceptOwnership: { type: "boolean", enum: [true] },
      },
    },
    issueIds: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 128 },
    },
    signature: {
      type: "object",
      description: "For lookup after log reads. Use the stable resource ID, such as a chatbot ID.",
      properties: {
        service: lookupSignaturePart,
        environment: lookupSignaturePart,
        operation: lookupSignaturePart,
        error: { ...lookupSignaturePart, maxLength: 4096 },
        resource: lookupSignaturePart,
      },
      required: ["service", "environment", "operation", "error", "resource"],
      additionalProperties: false,
    },
    report: { type: "object" },
    finalText: {
      type: "string",
      minLength: 1,
      maxLength: 32000,
      description: "Legacy acknowledgement only; report content derives from typed updates.",
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

function selectSignatureMatches(snapshot: CatalogSnapshot, signature: IssueSignature) {
  if (snapshot.status !== "ready") {
    return { match: "unavailable", issues: [] };
  }
  const key = signatureKey(signature);
  const exact = snapshot.issues.filter((issue) => signatureKey(issue.signature) === key);
  if (exact.length) {
    return { match: exact.length === 1 ? "exact" : "possible", issues: exact };
  }
  // A resource match can surface a differently worded signature for review.
  const observed = normalizeSignature(signature);
  const possible = snapshot.issues.filter((issue) => {
    const saved = normalizeSignature(issue.signature);
    return (
      saved.service === observed.service &&
      saved.environment === observed.environment &&
      saved.resource === observed.resource
    );
  });
  return { match: possible.length ? "possible" : "none", issues: possible };
}

/** The definition stays stable; current invocation and channel ownership gate execution. */
export function createInvestigationRecordTool(ctx: OpenClawPluginToolContext<2>): AnyAgentTool {
  const schemaBinding = asOptionalRecord(ctx.toolBindings?.slack_investigation);
  const boundTurn =
    typeof schemaBinding?.turnId === "string"
      ? tryGetInvestigationTurnRegistry()?.get(schemaBinding.turnId)
      : undefined;
  const profile =
    boundTurn && boundTurn.scope.agentId === ctx.agentId && boundTurn.sessionKey === ctx.sessionKey
      ? boundTurn.reportProfile
      : resolveAgentReportProfile(ctx.agentId ?? "", "slack");
  return {
    name: "slack_investigation_record",
    label: "Investigation record",
    description:
      "Look up the authorized turn's catalog by issueIds or by a signature identified in logs. A lookup is read-only. To stage completed updates, supply report OR legacy finalText, not both. Confirmed Slack delivery owns catalog saving. " +
      (profile?.instructions ?? "No report profile is configured for this agent."),
    parameters: {
      ...parameters,
      properties: {
        ...parameters.properties,
        report: profile?.inputSchema ?? parameters.properties.report,
      },
    },
    async execute(toolCallId, input, signal) {
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
        const rawSignature = asOptionalRecord(args.signature);
        const signature =
          args.signature === undefined
            ? undefined
            : issueSignatureSchema.parse({ ...rawSignature, scope: turn.scope });
        if (
          signature &&
          (args.issueIds !== undefined ||
            (rawSignature && Object.hasOwn(rawSignature, "scope")) ||
            !hasCompleteSignature(signature) ||
            !signature.resource ||
            /^(?:unknown|unspecified|n\/a|none)$/i.test(signature.resource))
        ) {
          throw new Error(
            "lookup requires issueIds or a complete signature with a stable resource",
          );
        }
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
        const signatureMatches = signature && selectSignatureMatches(snapshot, signature);
        const selected =
          signatureMatches?.issues ??
          (requestedIds
            ? snapshot.issues.filter((issue) => requestedIds.has(issue.issueId))
            : snapshot.issues);
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
          ...(signatureMatches && { match: signatureMatches.match }),
          issues,
          truncated: issues.length < selected.length,
          totalIssues: snapshot.issues.length,
        });
      }
      if (args?.action === "begin_trend" || args?.action === "record_trend") {
        registry.clearStaged(turnId);
        const request = turn.amendmentRequest;
        if (
          !request ||
          turn.snapshot.status !== "ready" ||
          !Array.isArray(args.issueIds) ||
          args.issueIds.length !== 1
        )
          throw new Error(
            "Trend memory requires one existing scoped case and an authorized thread request",
          );
        const [issueId] = args.issueIds;
        const issue = turn.snapshot.issues.find((item) => item.issueId === issueId);
        if (!issue) throw new Error("Case not found in this turn");
        if (args.action === "begin_trend") {
          turn.trendCapture = {
            issueId: issue.issueId,
            signature: issue.signature,
            startCall: toolCallId,
            pages: new Map(),
          };
          return jsonResult({
            status: "ready",
            instruction:
              "Use livex_gcp_logs_read errors for two disjoint equal-duration UTC windows on the same service and selectors. Exhaust every cursor. Then record_trend with the two tool-returned evidence URLs and this issue ID.",
          });
        }
        if (turn.trendCapture?.issueId !== issue.issueId)
          throw new Error("Select this case with begin_trend before collecting evidence");
        const trend = measuredTrend(
          turn.trendCapture,
          args.earlierEvidenceUrl,
          args.laterEvidenceUrl,
        );
        assertNoSensitiveContent(trend);
        const comparison =
          trendSummary(trend) + " Request volume is needed to compare failure rates.";
        const evidence =
          "<" +
          trend.earlier.evidenceUrl +
          "|Earlier evidence> · <" +
          trend.later.evidenceUrl +
          "|Later evidence>";
        const finalText =
          Buffer.byteLength(comparison + " " + evidence) <= 4000
            ? comparison + " " + evidence
            : comparison;
        const reportUrls = [
          ...new Set(issue.whatWeDidLast.filter((h) => !h.trend).map((h) => h.reportUrl)),
        ];
        registry.stageTrend(turnId, {
          issueId: issue.issueId,
          trend,
          finalText,
          requestId: request.messageId,
          reportUrls,
        });
        return jsonResult({ status: "staged", finalText });
      }
      if (args?.action === "amend_current_report") {
        registry.clearStaged(turnId);
        if (Object.keys(args).some((k) => k !== "action" && k !== "changes"))
          throw new Error("Supply only the proposed changes");
        const amendment = prepareAmendment(args.changes, turn.amendmentRequest, turn.snapshot);
        if ("clarification" in amendment)
          return jsonResult({ status: "clarification_required", message: amendment.clarification });
        turn.amendment = amendment;
        return jsonResult({ status: "staged", finalText: amendment.finalText });
      }
      if (args?.action !== "prepare_update") {
        throw new Error("Use lookup, prepare_update or amend_current_report");
      }
      // A failed later attempt must not leave an older final eligible for publication.
      registry.clearStaged(turnId);
      turn.reportExpected = true;
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
      if (!turn.reportProfile) {
        throw new Error("No report profile is configured for this Slack investigation turn");
      }
      const prepared = turn.reportProfile.prepare(args.report, reportContext(updates, comparisons));
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
          "Return exactly finalText. The configured profile renders the report; add no labels, markers or extra prose. Nothing has been sent or recorded yet.",
      });
    },
  };
}

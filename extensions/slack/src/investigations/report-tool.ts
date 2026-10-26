import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { projectInvestigationIssue } from "./lookup.js";
import { compareFindings } from "./matching.js";
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
    finalText: { type: "string", minLength: 1, maxLength: 32000 },
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
      "Look up this authorized oncall turn's investigation catalog, or prepare completed per-issue findings. prepare_update requires the exact final reply text and one update for each independent finding. It validates known issues and meaningful changes but does not write or send. Reply with the identical finalText; the Slack owner records findings only after confirmed final delivery. Historical owner/hold/recovery claims need evidence; use unknown when not verified.",
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
      if (
        args?.action !== "prepare_update" ||
        typeof args.finalText !== "string" ||
        !Array.isArray(args.updates)
      ) {
        throw new Error("prepare_update requires finalText and completed issue updates");
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
      const findings = compareFindings(turn.snapshot, updates).map(
        ({ kind, issueId, canonicalThreadUrl, changes, reason }) => ({
          kind,
          issueId,
          canonicalThreadUrl,
          changes,
          reason,
        }),
      );
      const finalText = args.finalText;
      const missingLinks = findings.flatMap((finding) =>
        (finding.kind === "known-persistence" || finding.kind === "changed") &&
        finding.canonicalThreadUrl &&
        !finalText.includes(finding.canonicalThreadUrl)
          ? [finding.canonicalThreadUrl]
          : [],
      );
      if (missingLinks.length) {
        throw new Error(
          `The final reply must include each existing canonical investigation link: ${[...new Set(missingLinks)].join(" ")}`,
        );
      }
      ctx.assertInvocationCurrent();
      turn.assertCurrent();
      signal?.throwIfAborted();
      registry.stage(turnId, turn.scope, args.finalText, updates);
      return jsonResult({
        status: "prepared",
        historyStatus: turn.snapshot.status,
        findings,
        instruction:
          "Return exactly the prepared finalText. Nothing has been sent or recorded yet.",
      });
    },
  };
}

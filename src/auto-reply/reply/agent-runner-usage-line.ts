import { expectDefined, formatCompactTokenCount } from "@openclaw/normalization-core";
import { hasBillableUsage, hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import {
  estimateAggregateUsageCost,
  formatTokenCount,
  formatUsd,
} from "../../utils/usage-format.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import { resolveEffectiveResponseUsage } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { buildUsageContract } from "../usage-bar/contract.js";
import { DEFAULT_USAGE_BAR_TEMPLATE } from "../usage-bar/default-template.js";
import { loadUsageBarTemplate } from "../usage-bar/template.js";
import { renderUsageBar } from "../usage-bar/translator.js";

const formatResponseUsageLine = (
  params: Parameters<typeof estimateAggregateUsageCost>[0] & {
    showCost: boolean;
  },
): string | null => {
  const usage = params.usage;
  if (!usage) {
    return null;
  }
  const input = usage.input;
  const output = usage.output;
  const hasSplitTokens = input !== undefined || output !== undefined;
  const inputLabel = input !== undefined ? formatTokenCount(input) : "?";
  const outputLabel = output !== undefined ? formatTokenCount(output) : "?";
  const totalLabel =
    !hasSplitTokens && usage.total !== undefined
      ? `${formatTokenCount(usage.total)} total`
      : undefined;
  const cacheRead = usage.cacheRead;
  const cacheWrite = usage.cacheWrite;
  const canPriceUsage = usage.cost !== undefined || (input !== undefined && output !== undefined);
  const cost = params.showCost && canPriceUsage ? estimateAggregateUsageCost(params) : undefined;
  const costLabel = params.showCost ? formatUsd(cost) : undefined;
  const cacheSuffix =
    (cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0
      ? ` · cache ${formatTokenCount(cacheRead ?? 0)} cached / ${formatTokenCount(cacheWrite ?? 0)} new`
      : "";
  if (!hasSplitTokens && !totalLabel && !cacheSuffix && !costLabel) {
    return null;
  }
  const suffix = costLabel ? ` · est ${costLabel}` : "";
  return `Usage: ${totalLabel ?? `${inputLabel} in / ${outputLabel} out`}${cacheSuffix}${suffix}`;
};

type ResponseUsageLine = string | { context: string };

function formatSlackUsageContext(usage: NormalizedUsage | undefined, cost: number | undefined) {
  const { input, cacheRead, cacheWrite, output } = usage ?? {};
  const tokens =
    usage?.usageReport?.state !== "unavailable" &&
    input !== undefined &&
    cacheRead !== undefined &&
    output !== undefined
      ? [
          `${formatCompactTokenCount(input)} uncached`,
          `${formatCompactTokenCount(cacheRead)} cached`,
          ...(cacheWrite ? [`${formatCompactTokenCount(cacheWrite)} cache write`] : []),
          `${formatCompactTokenCount(output)} out`,
        ].join(" · ")
      : "Usage unavailable";
  const estimate = cost === undefined ? "unavailable" : `$${cost.toFixed(4)}`;
  return `Estimated cost ${estimate} · ${tokens}`;
}

export const resolveResponseUsageLine = (params: {
  config: OpenClawConfig;
  agentDir: string;
  sessionRaw?: string | null;
  channel?: string;
  usage?: NormalizedUsage;
  provider?: string;
  model?: string;
  preserveUserFacingSessionState?: boolean;
  replyUsageState?: PluginHookReplyUsageState;
}): ResponseUsageLine | undefined => {
  const responseUsageMode = resolveEffectiveResponseUsage(
    params.sessionRaw,
    params.config.messages?.responseUsage,
    params.channel,
  );
  if (responseUsageMode === "off" || params.preserveUserFacingSessionState === true) {
    return undefined;
  }
  const showCost = responseUsageMode === "full";
  const slackFull = showCost && params.channel === "slack";
  const usageTemplate =
    showCost && (slackFull || params.replyUsageState)
      ? loadUsageBarTemplate(params.config.messages?.usageTemplate)
      : undefined;
  if (slackFull && usageTemplate === DEFAULT_USAGE_BAR_TEMPLATE) {
    const cost =
      params.replyUsageState?.turnUsd ??
      estimateAggregateUsageCost({ ...params, allowPluginNormalization: false });
    return { context: formatSlackUsageContext(params.usage, cost) };
  }
  const hasUsage = showCost ? hasBillableUsage(params.usage) : hasNonzeroUsage(params.usage);
  if (!hasUsage) {
    return undefined;
  }

  const formatted = formatResponseUsageLine({
    usage: params.usage,
    showCost,
    provider: params.provider,
    model: params.model,
    config: params.config,
    agentDir: params.agentDir,
    allowPluginNormalization: false,
  });
  const rendered =
    usageTemplate && params.replyUsageState
      ? renderUsageBar(usageTemplate, buildUsageContract(params.replyUsageState, params.channel))
      : undefined;

  return rendered || formatted || undefined;
};

export const appendUsageLine = (
  payloads: ReplyPayload[],
  line: ResponseUsageLine,
): ReplyPayload[] => {
  const context = typeof line !== "string";
  const footer = context ? line.context : line;
  const index = payloads.findLastIndex(
    (payload) => payload && (context ? hasReplyPayloadContent(payload) : payload.text),
  );
  if (index === -1) {
    return context ? payloads : [...payloads, { text: footer, isStatusNotice: true }];
  }
  const existing = expectDefined(payloads[index], "payloads entry at index");
  const next = copyReplyPayloadMetadata(
    existing,
    context
      ? {
          ...existing,
          // Slack appends this after compiling the report and controls.
          channelData: { ...existing.channelData, openclawUsageFooter: footer },
        }
      : {
          ...existing,
          text: `${existing.text ?? ""}${existing.text?.endsWith("\n") ? "" : "\n"}${footer}`,
        },
  );
  setReplyPayloadMetadata(next, { responseUsageLine: footer });
  const mirror = getReplyPayloadMetadata(existing)?.sourceReplyTranscriptMirror;
  // Transcript mirrors must track the mutated text or source-reply delivery drifts.
  if (!context && mirror) {
    setReplyPayloadMetadata(next, {
      sourceReplyTranscriptMirror: { ...mirror, text: next.text },
    });
  }
  const updated = payloads.slice();
  updated[index] = next;
  return updated;
};

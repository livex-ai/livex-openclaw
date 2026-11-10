import { normalizeUsage, type NormalizedUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { calculateCost, type Model } from "openclaw/plugin-sdk/llm";
import { createEmptyTransportUsage } from "openclaw/plugin-sdk/provider-transport-runtime";
import {
  asSafeIntegerInRange,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type JsonObject } from "./protocol.js";

function readTokenCount(record: JsonObject, key: string): number | undefined {
  return asSafeIntegerInRange(record[key], { min: 0 });
}

export function readCodexThreadContextSnapshot(params: JsonObject) {
  const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
  const last = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
  const modelContextWindow = tokenUsage
    ? readTokenCount(tokenUsage, "modelContextWindow")
    : undefined;
  // `last.totalTokens` is the provider-backed active-context base; `tokenUsage.total` is billing.
  const activeContextTokens = last ? readTokenCount(last, "totalTokens") : undefined;
  const inputTokens = last ? readTokenCount(last, "inputTokens") : undefined;
  const cachedInputTokens = last ? readTokenCount(last, "cachedInputTokens") : undefined;
  const cacheWriteInputTokens = last ? readTokenCount(last, "cacheWriteInputTokens") : undefined;
  const reasoningOutputTokens = last ? readTokenCount(last, "reasoningOutputTokens") : undefined;
  return {
    ...(activeContextTokens !== undefined ? { activeContextTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(modelContextWindow && modelContextWindow > 0 ? { modelContextWindow } : {}),
    ...(inputTokens !== undefined ? { promptTokens: inputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

type CodexResponseUsage = Pick<
  NonNullable<ReturnType<typeof normalizeUsage>>,
  "input" | "output" | "cacheRead" | "cacheWrite" | "reasoningTokens" | "total"
> & { promptTokens?: number };

function normalizeCodexResponseTokenUsage(
  record: JsonObject,
):
  | { usage: NonNullable<ReturnType<typeof normalizeUsage>>; observedUsage: CodexResponseUsage }
  | undefined {
  // v2 TokenUsageBreakdown. inputTokens includes cached input; OpenClaw usage
  // tracks uncached input, cache reads, and cache writes separately.
  const totalTokens = readTokenCount(record, "totalTokens");
  const inputTokens = readTokenCount(record, "inputTokens");
  const cacheRead = readTokenCount(record, "cachedInputTokens");
  const output = readTokenCount(record, "outputTokens");
  const reasoningTokens = readTokenCount(record, "reasoningOutputTokens");
  const reportedCacheWrite = readTokenCount(record, "cacheWriteInputTokens");
  const cacheWrite = record.cacheWriteInputTokens === undefined ? 0 : reportedCacheWrite;
  const hasCoherentInput =
    inputTokens !== undefined &&
    cacheRead !== undefined &&
    cacheWrite !== undefined &&
    cacheRead + cacheWrite <= inputTokens;
  const hasCoherentContext =
    hasCoherentInput &&
    totalTokens !== undefined &&
    output !== undefined &&
    totalTokens === inputTokens + output;

  const usage = normalizeUsage({
    input: hasCoherentInput ? inputTokens - cacheRead - cacheWrite : undefined,
    output,
    cacheRead,
    cacheWrite,
    reasoningTokens,
    total: totalTokens,
  });
  if (!usage) {
    return undefined;
  }

  return {
    usage: {
      ...usage,
      contextUsage: hasCoherentContext
        ? { state: "available", promptTokens: inputTokens, totalTokens }
        : { state: "unavailable" },
    },
    // Aggregate compatibility defaults are not evidence that the provider
    // reported a field. Uncached input needs every cache component to be known.
    observedUsage: {
      ...(hasCoherentInput && reportedCacheWrite !== undefined
        ? { input: inputTokens - cacheRead - reportedCacheWrite }
        : {}),
      ...(inputTokens !== undefined ? { promptTokens: inputTokens } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(reportedCacheWrite !== undefined ? { cacheWrite: reportedCacheWrite } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      ...(totalTokens !== undefined ? { total: totalTokens } : {}),
    },
  };
}

const billingFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const usageFields = [...billingFields, "reasoningTokens"] as const;

function billingKey(usage?: NormalizedUsage): string {
  return billingFields.map((field) => usage?.[field] ?? 0).join("/");
}

type RequestUsageSum = { usage: NormalizedUsage; cost?: number };

function addRequestUsage(
  sum: RequestUsageSum,
  usage: NormalizedUsage | undefined,
  model: Model | null | undefined,
) {
  for (const field of usageFields) {
    if (usage?.[field] !== undefined) {
      sum.usage[field] = (sum.usage[field] ?? 0) + usage[field];
    }
  }
  if (sum.cost === undefined) {
    return;
  }
  if (
    usage?.contextUsage?.state !== "available" ||
    !model ||
    ![model.cost, ...(model.cost.tieredPricing ?? [])].some((rates) =>
      [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].some((rate) => rate > 0),
    )
  ) {
    sum.cost = undefined;
    return;
  }
  const request = createEmptyTransportUsage();
  request.input = usage.input ?? 0;
  request.output = usage.output ?? 0;
  request.cacheRead = usage.cacheRead ?? 0;
  request.cacheWrite = usage.cacheWrite ?? 0;
  request.totalTokens = usage.total ?? 0;
  sum.cost += calculateCost(model, request).total;
}

export class CodexUsageProjection {
  // Replayed notifications keep one upstream response equal to one model iteration.
  private readonly responseIds = new Set<string>();
  private readonly snapshotKeys = new Set<string>();
  private responseUsage?: RequestUsageSum;
  private responseUsageIncomplete = false;
  private threadUsage?: NormalizedUsage;
  private snapshotUsage?: RequestUsageSum;
  private cumulativeUsage?: NormalizedUsage | null;
  private snapshotGap = false;
  private contextUsage: NormalizedUsage["contextUsage"];

  // Omitted for legacy, context-only consumers. Null means the selected route has no verified rates.
  constructor(
    private pricingModel?: Model | null,
    usageBaseline?: JsonObject | null,
  ) {
    if (usageBaseline !== undefined) {
      const baseline = usageBaseline
        ? normalizeCodexResponseTokenUsage(usageBaseline)?.usage
        : undefined;
      this.cumulativeUsage = baseline?.contextUsage?.state === "available" ? baseline : null;
    }
    if (this.cumulativeUsage !== null) {
      this.snapshotKeys.add(billingKey(this.cumulativeUsage));
    }
  }

  get usage(): NormalizedUsage | undefined {
    if (this.pricingModel === undefined) {
      const usage = this.responseUsage?.usage ?? this.threadUsage;
      return usage ? { ...usage, contextUsage: this.contextUsage } : undefined;
    }
    const raw = this.responseUsageIncomplete || this.snapshotGap ? undefined : this.responseUsage;
    const snapshots = this.snapshotGap ? undefined : this.snapshotUsage;
    const inconsistent =
      raw &&
      snapshots &&
      billingFields.some((field) => raw.usage[field] !== snapshots.usage[field]);
    const complete = inconsistent ? undefined : (raw ?? snapshots);
    const usage = complete?.usage ?? this.responseUsage?.usage ?? this.threadUsage;
    if (!usage) {
      return undefined;
    }
    const cost = this.pricingModel ? complete?.cost : undefined;
    return {
      ...usage,
      contextUsage: this.contextUsage,
      usageReport: { state: complete ? "available" : "unavailable" },
      costStatus: cost === undefined ? "unavailable" : "complete",
      ...(cost !== undefined ? { cost: { total: cost } } : {}),
    };
  }

  get modelIterations(): number {
    return this.responseIds.size;
  }

  invalidateContext(): void {
    this.contextUsage = { state: "unavailable" };
  }

  invalidatePricing(): void {
    if (this.pricingModel !== undefined) {
      this.pricingModel = null;
    }
  }

  /** Returns false for a replay that would also rewind the active context. */
  private recordSnapshot(last: NormalizedUsage | undefined, total: NormalizedUsage | undefined) {
    const previous = this.cumulativeUsage;
    if (previous === null || total?.contextUsage?.state !== "available") {
      this.snapshotGap = true;
      return true;
    }
    const key = billingKey(total);
    if (this.snapshotKeys.has(key)) {
      return key === billingKey(previous);
    }
    if (last?.contextUsage?.state !== "available") {
      this.snapshotGap = true;
      return true;
    }
    // A fresh thread starts at zero. Every other starting total comes from
    // the pinned pre-turn baseline, never from the first observed receipt.
    const deltaMatches = billingFields.every(
      (field) => (total[field] ?? 0) - (previous?.[field] ?? 0) === (last[field] ?? 0),
    );
    if (!deltaMatches) {
      this.snapshotGap = true;
      return true;
    }
    this.cumulativeUsage = total;
    this.snapshotKeys.add(key);
    this.snapshotUsage ??= { usage: {}, cost: 0 };
    addRequestUsage(this.snapshotUsage, last, this.pricingModel);
    return true;
  }

  recordThread(params: JsonObject): ReturnType<typeof readCodexThreadContextSnapshot> {
    const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
    const last = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
    const usage = last ? normalizeCodexResponseTokenUsage(last)?.usage : undefined;
    if (
      this.pricingModel !== undefined &&
      tokenUsage &&
      ("total" in tokenUsage || this.cumulativeUsage)
    ) {
      const total = isJsonObject(tokenUsage.total)
        ? normalizeCodexResponseTokenUsage(tokenUsage.total)?.usage
        : undefined;
      if (!this.recordSnapshot(usage, total)) {
        return {};
      }
    }
    this.threadUsage = usage ?? this.threadUsage;
    if (!this.responseUsage && usage) {
      this.contextUsage = usage.contextUsage;
    }
    return readCodexThreadContextSnapshot(params);
  }

  record(
    params: JsonObject,
    reportOutputTokens?: (outputTokens: number) => void,
  ): { responseId: string; usage: CodexResponseUsage | undefined } | undefined {
    const responseId = readString(params, "responseId");
    if (!responseId || this.responseIds.has(responseId)) {
      return undefined;
    }
    this.responseIds.add(responseId);
    const normalized = isJsonObject(params.usage)
      ? normalizeCodexResponseTokenUsage(params.usage)
      : undefined;
    const usage = normalized?.usage;
    // Billing sums completed calls; context belongs only to the latest call.
    // Missing usage or a retry invalidates context without erasing paid work.
    this.contextUsage = usage?.contextUsage ?? { state: "unavailable" };
    this.responseUsage ??= { usage: {}, cost: 0 };
    this.responseUsageIncomplete ||= usage?.contextUsage?.state !== "available";
    addRequestUsage(this.responseUsage, usage, this.pricingModel);
    const outputTokens = usage?.output;
    if (outputTokens !== undefined) {
      reportOutputTokens?.(outputTokens);
    }
    return { responseId, usage: normalized?.observedUsage };
  }
}

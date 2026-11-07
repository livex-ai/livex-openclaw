import type { OncallConfig } from "./config.js";
import { nextNotification, safeText } from "./policy.js";
import { isDefiniteSlackRejection, isLocallyPreventedSlackSend } from "./slack.js";
import type { ReceiptStore } from "./state.js";
import type { Delivery, Finding, Receipt, Roster, SlackTransport } from "./types.js";

type Effect = {
  step: number;
  tier?: number;
  text: string;
  channel?: string;
  finding?: number;
  roster?: Roster;
  render?(roster: Roster): { text: string; tier: number; channel?: string };
};
type Context = {
  store: ReceiptStore;
  slack: SlackTransport;
  config: OncallConfig;
  now: number;
  clock(): number;
  health(message: string): void;
  reportRosterWarning?(message?: string): void;
  assertCurrent(): void;
};
class EffectAlreadyOwned extends Error {}

function link(url: string | undefined, label: string) {
  if (!url) {
    return "";
  }
  const parsed = URL.parse(url);
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return "";
  }
  return `<${parsed.href.replace(/[<>]/g, encodeURIComponent)}|${label}>`;
}

function renderFinding(finding: Finding) {
  const title = `${safeText(finding.priority ?? "Unknown")} · ${finding.classification}`;
  const summary = safeText(
    finding.summary ?? finding.reason ?? "Investigation requires human review",
  );
  const caseReference = link(finding.caseUrl, "Existing case");
  const evidence = (finding.evidence ?? []).map((url) => link(url, "GCP evidence")).join(" ");
  return `${title}\n${summary}\n${safeText(finding.nextAction ?? "Review the investigation outcome")}\n${caseReference} ${evidence}`;
}

function currentDelivery(receipt: Receipt, effect: Effect) {
  return effect.finding === undefined
    ? receipt.summary
    : receipt.findings?.[effect.finding]?.delivery;
}

function replaceDelivery(receipt: Receipt, effect: Effect, delivery: Delivery): Receipt {
  if (effect.finding === undefined) {
    return { ...receipt, summary: delivery };
  }
  const findings = receipt.findings!.map((finding, index) =>
    index === effect.finding ? Object.assign({}, finding, { delivery }) : finding,
  );
  return { ...receipt, findings };
}

function assertPending(delivery: Delivery | undefined, effect: Effect, tick: number) {
  if (!delivery) {
    return;
  }
  if (
    delivery.status !== "rejected" ||
    delivery.step !== effect.step ||
    delivery.attempts >= 3 ||
    delivery.tick === tick
  ) {
    throw new EffectAlreadyOwned();
  }
}

async function reserve(receipt: Receipt, effect: Effect, ctx: Context) {
  return ctx.store.change(receipt.alert.key, (current) => {
    const delivery = currentDelivery(current, effect);
    const priorStep =
      effect.finding === undefined ? undefined : current.findings?.[effect.finding]?.step;
    if (
      delivery?.status === "confirmed" &&
      priorStep !== undefined &&
      effect.step > delivery.step
    ) {
      return replaceDelivery(current, effect, {
        status: "reserved",
        step: effect.step,
        attempts: 1,
        tick: ctx.now,
      });
    }
    assertPending(delivery, effect, ctx.now);
    return replaceDelivery(current, effect, {
      status: "reserved",
      step: effect.step,
      attempts: (delivery?.attempts ?? 0) + 1,
      tick: ctx.now,
    });
  });
}

async function settle(receipt: Receipt, effect: Effect, ctx: Context, messageTs: string) {
  const deliveredAt = ctx.clock();
  await ctx.store.change(receipt.alert.key, (current) => {
    const delivery = currentDelivery(current, effect)!;
    const confirmed: Delivery = { ...delivery, status: "confirmed", messageTs };
    const updated = replaceDelivery(current, effect, confirmed);
    if (effect.finding === undefined) {
      return updated;
    }
    const findings = updated.findings!.map((finding, index) =>
      index === effect.finding
        ? Object.assign({}, finding, {
            step: effect.step,
            baseTier: finding.baseTier ?? effect.tier,
            notifiedAt: finding.notifiedAt ?? deliveredAt,
            lastNotifiedAt: deliveredAt,
          })
        : finding,
    );
    return { ...updated, findings };
  });
}

async function failed(
  receipt: Receipt,
  effect: Effect,
  ctx: Context,
  error: unknown,
  priorAttempts: number,
) {
  if (isLocallyPreventedSlackSend(error)) {
    return notSent(receipt, effect, ctx, priorAttempts);
  }
  await ctx.store.change(receipt.alert.key, (current) => {
    const delivery = currentDelivery(current, effect)!;
    const status = isDefiniteSlackRejection(error)
      ? delivery.attempts >= 3
        ? "failed"
        : "rejected"
      : "uncertain";
    return replaceDelivery(current, effect, { ...delivery, status });
  });
  ctx.health(
    "Oncall delivery was rejected or uncertain. Inspect the durable receipt before recovery.",
  );
}

async function notSent(receipt: Receipt, effect: Effect, ctx: Context, attempts: number) {
  ctx.assertCurrent();
  await ctx.store.change(receipt.alert.key, (current) => {
    const delivery = currentDelivery(current, effect)!;
    return replaceDelivery(current, effect, { ...delivery, status: "rejected", attempts });
  });
  ctx.health("Current rotation unavailable before transport; engineer paging deferred.");
}

function rosterCurrent(roster: Roster, ctx: Context) {
  ctx.assertCurrent();
  if (roster.validUntil !== undefined && ctx.clock() >= roster.validUntil) {
    return false;
  }
  try {
    roster.assertFresh?.();
    return true;
  } catch {
    ctx.assertCurrent();
    return false;
  }
}

async function effectRoster(effect: Effect, ctx: Context) {
  const selected = effect.roster!;
  const roster = rosterCurrent(selected, ctx) ? selected : await ctx.slack.roster();
  ctx.assertCurrent();
  if (ctx.reportRosterWarning) {
    ctx.reportRosterWarning(roster.warning);
  } else if (roster.warning) {
    ctx.health(roster.warning);
  }
  if (!rosterCurrent(roster, ctx) || (!roster.p1 && !roster.p2)) {
    return null;
  }
  return roster;
}

async function preparePage(receipt: Receipt, effect: Effect, ctx: Context, priorAttempts: number) {
  if (!effect.roster) {
    return undefined;
  }
  if (await ctx.slack.acknowledged(receipt.alert.ts)) {
    await acknowledge(receipt, ctx);
    return null;
  }
  const roster = await effectRoster(effect, ctx);
  if (roster === null) {
    await notSent(receipt, effect, ctx, priorAttempts);
    return null;
  }
  if (effect.render) {
    Object.assign(effect, effect.render(roster));
  }
  if (!targets(roster, effect.tier ?? 0)) {
    await notSent(receipt, effect, ctx, priorAttempts);
    return null;
  }
  if (await ctx.slack.acknowledged(receipt.alert.ts)) {
    await acknowledge(receipt, ctx);
    return null;
  }
  if (!rosterCurrent(roster, ctx)) {
    await notSent(receipt, effect, ctx, priorAttempts);
    return null;
  }
  return roster;
}

function finalRosterGuard(roster: Roster, ctx: Context) {
  return () => {
    if (!rosterCurrent(roster, ctx)) {
      throw new Error("Oncall roster expired before transport");
    }
  };
}

async function deliver(receipt: Receipt, effect: Effect, ctx: Context) {
  let priorAttempts: number;
  try {
    const reserved = await reserve(receipt, effect, ctx);
    priorAttempts = currentDelivery(reserved, effect)!.attempts - 1;
  } catch (error) {
    if (error instanceof EffectAlreadyOwned) {
      return;
    }
    throw error;
  }
  try {
    ctx.assertCurrent();
    const roster = await preparePage(receipt, effect, ctx, priorAttempts);
    if (roster === null) {
      return;
    }
    const messageTs = await ctx.slack.send({
      text: effect.text,
      channel: effect.channel,
      threadTs: effect.channel ? undefined : receipt.alert.ts,
      beforeSend: roster ? finalRosterGuard(roster, ctx) : undefined,
    });
    ctx.assertCurrent();
    await settle(receipt, effect, ctx, messageTs);
  } catch (error) {
    await failed(receipt, effect, ctx, error, priorAttempts);
  }
}

async function acknowledge(receipt: Receipt, ctx: Context) {
  await ctx.store.change(receipt.alert.key, (current) => ({
    ...current,
    findings: current.findings?.map((finding) => ({ ...finding, acknowledged: true })),
  }));
}

function targets(roster: Roster, tier: number) {
  const selected = tier === 0 ? [roster.p1] : [roster.p1, roster.p2];
  return [...new Set(selected)]
    .filter((id): id is string => Boolean(id && /^[UW][A-Z0-9]{6,}$/.test(id)))
    .map((id) => `<@${id}>`)
    .join(" ");
}

function pageText(finding: Finding, roster: Roster, step: number, tier: number) {
  const prefix = targets(roster, tier);
  const warning = roster.error ? " Rotation has unresolved slots." : "";
  const action =
    step === 0 ? "New unknown issue needs review." : `Unacknowledged issue, reminder ${step}.`;
  return `${prefix} ${action}${warning}\n${renderFinding(finding)}`;
}

function freshPage(finding: Finding, roster: Roster, step: number, tier: number, ctx: Context) {
  const initialTier = !roster.p1 && roster.p2 ? 1 : 0;
  const currentTier = finding.notifiedAt === undefined ? initialTier : Math.max(tier, initialTier);
  return {
    text: pageText(finding, roster, step, currentTier),
    tier: currentTier,
    channel: currentTier === 2 ? ctx.config.broadcastChannelId : undefined,
  };
}

export async function notifyReceipt(receipt: Receipt, roster: Roster, ctx: Context) {
  const findings = receipt.findings ?? [];
  if (!needsNotifications(receipt, ctx.config.maxNudges)) {
    return;
  }
  if (roster.error) {
    ctx.health("Oncall rotation is incomplete; unresolved slots cannot be paged.");
  }
  if (!receipt.summary || receipt.summary.status === "rejected") {
    const summary = findings.map(renderFinding).join("\n\n").slice(0, 28_000);
    const warning = roster.error
      ? "\nRotation incomplete; refresh the configured Canvas before paging unresolved slots."
      : "";
    await deliver(receipt, { step: 0, text: `Investigation result\n${summary}${warning}` }, ctx);
  }
  if (!findings.some((finding) => activeUnknown(finding, ctx.config.maxNudges))) {
    return;
  }
  if (await ctx.slack.acknowledged(receipt.alert.ts)) {
    await acknowledge(receipt, ctx);
    return;
  }
  for (const [index, finding] of findings.entries()) {
    await notifyFinding(receipt, finding, index, roster, ctx);
  }
}

async function notifyFinding(
  receipt: Receipt,
  finding: Finding,
  index: number,
  roster: Roster,
  ctx: Context,
) {
  if (!roster.p1 && !roster.p2) {
    return;
  }
  const baseTier = finding.baseTier ?? (!roster.p1 && roster.p2 ? 1 : 0);
  const next = nextNotification(
    finding,
    ctx.now,
    ctx.config.reminderMs,
    ctx.config.maxNudges,
    baseTier,
  );
  if (!next) {
    return;
  }
  if (next.tier === 2 && !ctx.config.broadcastChannelId) {
    return;
  }
  const channel = next.tier === 2 ? ctx.config.broadcastChannelId : undefined;
  await deliver(
    receipt,
    {
      ...next,
      finding: index,
      channel,
      text: "",
      roster,
      render: (current) => freshPage(finding, current, next.step, next.tier, ctx),
    },
    ctx,
  );
}

function activeUnknown(finding: Finding, nudges: number) {
  if (finding.classification !== "unknown" || finding.acknowledged) {
    return false;
  }
  if (["uncertain", "failed", "reserved"].includes(finding.delivery?.status ?? "")) {
    return false;
  }
  return (finding.step ?? -1) < nudges * (2 - (finding.baseTier ?? 0)) + 1;
}

function needsNotifications(receipt: Receipt, nudges: number) {
  const summaryPending = !receipt.summary || receipt.summary.status === "rejected";
  return summaryPending || receipt.findings?.some((finding) => activeUnknown(finding, nudges));
}

export async function reconcileNotifications(
  store: ReceiptStore,
  health: (message: string) => void = () => {},
) {
  let needsRecovery = false;
  for (const receipt of await store.list()) {
    if (requiresRecovery(receipt)) {
      needsRecovery = true;
    }
    await store.change(receipt.alert.key, (current) => ({
      ...current,
      summary: uncertain(current.summary),
      phase: current.phase === "dispatch_reserved" ? "dispatch_uncertain" : current.phase,
      findings: recoveryFindings(current),
    }));
  }
  if (needsRecovery) {
    health(
      "Oncall has uncertain durable receipts. Inspect dispatch and delivery state before manual recovery.",
    );
  }
}

function requiresRecovery(receipt: Receipt) {
  const dispatch = ["dispatch_reserved", "dispatch_uncertain"].includes(receipt.phase);
  const summary = ["reserved", "uncertain"].includes(receipt.summary?.status ?? "");
  return (
    dispatch ||
    summary ||
    receipt.findings?.some((finding) =>
      ["reserved", "uncertain"].includes(finding.delivery?.status ?? ""),
    )
  );
}

function recoveryFindings(current: Receipt) {
  if (current.phase === "dispatch_reserved" || current.phase === "dispatch_uncertain") {
    return [
      {
        classification: "unclassified" as const,
        reason:
          "Debugger dispatch outcome is uncertain after restart. Human review is required; automatic redispatch is disabled.",
      },
    ];
  }
  return current.findings?.map((finding) => ({
    ...finding,
    delivery: uncertain(finding.delivery),
  }));
}

function uncertain(delivery: Delivery | undefined): Delivery | undefined {
  return delivery?.status === "reserved" ? { ...delivery, status: "uncertain" } : delivery;
}

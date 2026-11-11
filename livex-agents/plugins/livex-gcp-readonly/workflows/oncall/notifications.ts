import type { OncallConfig } from "./config.js";
import { nextNotification, safeText } from "./policy.js";
import { renderOncallFinding } from "./report.js";
import { isDefiniteSlackRejection } from "./slack.js";
import type { ReceiptStore } from "./state.js";
import type { Delivery, Finding, Receipt, Roster, SlackTransport } from "./types.js";

type Effect = Pick<Parameters<SlackTransport["send"]>[0], "text" | "cards" | "channel"> & {
  step: number;
  tier?: number;
  finding?: number;
};
type Context = {
  store: ReceiptStore;
  settlementStore: ReceiptStore;
  slack: SlackTransport;
  config: OncallConfig;
  now: number;
  clock(): number;
  health(message: string): void;
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

function currentFinding(receipt: Receipt, effect: Effect) {
  return effect.finding === undefined ? undefined : receipt.findings?.[effect.finding];
}

function currentDelivery(receipt: Receipt, effect: Effect) {
  return effect.finding === undefined ? receipt.summary : currentFinding(receipt, effect)?.delivery;
}

function replaceDelivery(
  receipt: Receipt,
  effect: Effect,
  delivery: Delivery | undefined,
): Receipt {
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

function reservationAttempts(
  delivery: Delivery | undefined,
  effect: Effect,
  tick: number,
  priorStep?: number,
) {
  if (delivery?.status === "confirmed" && priorStep !== undefined && effect.step > delivery.step) {
    return 1;
  }
  assertPending(delivery, effect, tick);
  return (delivery?.attempts ?? 0) + 1;
}

async function reserve(receipt: Receipt, effect: Effect, ctx: Context) {
  let previous: Delivery | undefined;
  const reserved = await ctx.store.change(receipt.alert.key, (current) => {
    const finding = currentFinding(current, effect);
    if (finding?.acknowledged) {
      throw new EffectAlreadyOwned();
    }
    previous = currentDelivery(current, effect);
    return replaceDelivery(current, effect, {
      status: "reserved",
      step: effect.step,
      attempts: reservationAttempts(previous, effect, ctx.now, finding?.step),
      tick: ctx.now,
    });
  });
  return { previous, delivery: currentDelivery(reserved, effect)! };
}

async function releaseUnattempted(
  receipt: Receipt,
  effect: Effect,
  ctx: Context,
  reservation: Awaited<ReturnType<typeof reserve>>,
) {
  await ctx.settlementStore.change(receipt.alert.key, (current) => {
    const delivery = currentDelivery(current, effect);
    if (
      delivery?.status !== "reserved" ||
      delivery.step !== reservation.delivery.step ||
      delivery.tick !== reservation.delivery.tick ||
      delivery.attempts !== reservation.delivery.attempts
    ) {
      return current;
    }
    return replaceDelivery(current, effect, reservation.previous);
  });
}

async function settle(receipt: Receipt, effect: Effect, ctx: Context, messageTs: string) {
  const deliveredAt = ctx.clock();
  await ctx.settlementStore.change(receipt.alert.key, (current) => {
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

async function failed(receipt: Receipt, effect: Effect, ctx: Context, error: unknown) {
  await ctx.settlementStore.change(receipt.alert.key, (current) => {
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

async function deliver(receipt: Receipt, effect: Effect, ctx: Context) {
  // A failed Slack read cannot make an unattempted delivery uncertain.
  if (effect.finding !== undefined && (await ctx.slack.acknowledged(receipt.alert.ts))) {
    await acknowledge(receipt, ctx);
    return;
  }
  let reservation: Awaited<ReturnType<typeof reserve>>;
  try {
    reservation = await reserve(receipt, effect, ctx);
  } catch (error) {
    if (error instanceof EffectAlreadyOwned) {
      return;
    }
    throw error;
  }
  try {
    ctx.assertCurrent();
  } catch (error) {
    // The transport was never called. Preserve the prior retry or reminder state.
    await releaseUnattempted(receipt, effect, ctx, reservation);
    throw error;
  }
  // Once transport is called, its response or uncertainty belongs to the service.
  try {
    const messageTs = await ctx.slack.send({
      text: effect.text,
      ...(effect.cards ? { cards: effect.cards } : {}),
      channel: effect.channel,
      threadTs: effect.channel ? undefined : receipt.alert.ts,
    });
    await settle(receipt, effect, ctx, messageTs);
  } catch (error) {
    await failed(receipt, effect, ctx, error);
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

export async function notifyReceipt(receipt: Receipt, roster: Roster, ctx: Context) {
  const findings = receipt.findings ?? [];
  if (!needsNotifications(receipt, ctx.config.maxNudges)) {
    return;
  }
  if (roster.error) {
    ctx.health("Oncall rotation is incomplete; unresolved slots cannot be paged.");
  }
  if (!receipt.summary || receipt.summary.status === "rejected") {
    await deliver(receipt, summaryEffect(receipt, findings, roster), ctx);
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

function summaryEffect(receipt: Receipt, findings: Finding[], roster: Roster): Effect {
  const warning = roster.error
    ? "Rotation incomplete; refresh the configured Canvas before paging unresolved slots."
    : undefined;
  const display = findings.length ? findings : [{ classification: "unclassified" } as const];
  const reports = display.map((finding, index) =>
    renderOncallFinding(finding, receipt.alert, index === 0 ? warning : undefined),
  );
  const digest = reports.map(
    ({ form }) => `${form.title.slice(0, 75)} · ${form.priority} · ${form.summary.slice(0, 75)}`,
  );
  return {
    step: 0,
    text: reports.length === 1 ? reports[0]!.text : ["Investigation result", ...digest].join("\n"),
    cards: reports.map(({ card }) => card),
  };
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
    { ...next, finding: index, channel, text: pageText(finding, roster, next.step, next.tier) },
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

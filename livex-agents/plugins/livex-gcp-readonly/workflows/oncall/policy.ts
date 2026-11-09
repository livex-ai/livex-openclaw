import type { Finding } from "./types.js";

/** Untrusted text never supplies Slack mentions, broadcast controls or unfurl URLs. */
export function safeText(value: string, maximum = 1_000): string {
  return (
    value
      .replace(/<https?:\/\/[^|>]+\|([^>]+)>/gi, "$1")
      .replace(/<[^>]*>/g, "[reference]")
      .replace(/https?:\/\/\S+/gi, "[link]")
      .replace(/@/g, "＠")
      // Remove actual control characters from untrusted rendered text.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .slice(0, maximum)
  );
}

export function nextNotification(
  finding: Finding,
  now: number,
  interval = 600_000,
  nudges = 3,
  baseTier = 0,
) {
  if (notificationStopped(finding)) {
    return null;
  }
  if (finding.notifiedAt === undefined) {
    return { step: 0, tier: baseTier };
  }
  const finalStep = nudges * (2 - baseTier) + 1;
  const step = retryStep(finding, (finding.step ?? 0) + 1);
  if (step > finalStep || now < notificationDeadline(finding, step, interval)) {
    return null;
  }
  return { step, tier: baseTier + Math.floor((step - 1) / nudges) };
}

function notificationDeadline(finding: Finding, step: number, interval: number) {
  return Math.max(
    finding.notifiedAt! + step * interval,
    (finding.lastNotifiedAt ?? finding.notifiedAt!) + interval,
  );
}

function notificationStopped(finding: Finding) {
  return (
    finding.classification !== "unknown" ||
    finding.acknowledged ||
    ["reserved", "uncertain", "failed"].includes(finding.delivery?.status ?? "")
  );
}

function retryStep(finding: Finding, dueStep: number) {
  return finding.delivery?.status === "rejected" ? finding.delivery.step : dueStep;
}

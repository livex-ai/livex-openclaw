// Caller gate shared by the log, metrics and repository tools, and its refusal log.
const PLUGIN_ID = "livex-gcp-readonly";
const ONCE_PER_MS = 60_000;
const lastLogged = new Map();

/** Fixed reason a tool is not offered to this caller (never any caller content), or null. */
export function toolGateRefusal(config, context) {
  if (context?.messageChannel !== "slack") return "not a Slack context";
  if (!/^[CG][A-Z0-9]+$/.test(context?.nativeChannelId ?? "")) return "no Slack channel id";
  if (config.allowedChannelId !== "*" && context.nativeChannelId !== config.allowedChannelId)
    return "channel not allowed";
  if (context.requesterSenderId !== config.allowedSenderId) return "requester not allowed";
  if (typeof context.assertInvocationCurrent !== "function") return "no invocation guard";
  return null;
}

/** Tool factories run per invocation: log each tool and reason at most once a minute. */
export function logNotOffered(tool, reason, { now = Date.now, warn = console.warn } = {}) {
  try {
    const key = `${tool}\0${reason}`;
    const at = now();
    const last = lastLogged.get(key);
    if (last !== undefined && at >= last && at - last < ONCE_PER_MS) return;
    lastLogged.set(key, at);
    warn(`${PLUGIN_ID}: tool not offered: ${reason} (${tool})`);
  } catch {
    // Logging must never affect tool creation.
  }
}

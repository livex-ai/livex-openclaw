// Match the existing Slack edit budget; transport still validates every outgoing payload.
export const SLACK_EDIT_TEXT_MAX_BYTES = 4_000;
export function escapeSlackMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Match the existing Slack edit budget; transport still validates every outgoing payload.
export const SLACK_EDIT_TEXT_MAX_BYTES = 4_000;
export const SLACK_SECTION_TEXT_LIMIT = 3_000;

export const COMPACT_REPORT_FIELDS = {
  title: "*Title:* ",
  priority: "*Priority:* ",
  action: "*Next action:* ",
  summary: "*Summary:* ",
  evidence: "*Evidence:* ",
};

export const REPORT_COLORS = {
  high: "#D92D20",
  medium: "#D99A00",
  resolved: "#2E8B57",
  default: "#9CA3AF",
};

export function compactReportColor(priority: string, resolved: boolean): string {
  if (resolved) {
    return REPORT_COLORS.resolved;
  }
  if (priority === "Critical" || priority === "High") {
    return REPORT_COLORS.high;
  }
  if (priority === "Medium") {
    return REPORT_COLORS.medium;
  }
  return REPORT_COLORS.default;
}

export function escapeSlackMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

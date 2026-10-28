import { describe, expect, it } from "vitest";
import { buildSlackCompleteBlocksFallbackText } from "../../../extensions/slack/src/blocks-fallback.js";
import { buildSlackThreadSummaryCard } from "./legacy-report.js";

const evidenceUrl = "https://docs.slack.dev/reference/methods/chat.postMessage/";
const report = [
  "⚠️ Action required · Severity unknown · Investigation partial",
  "*Title:* Menu access denied",
  "*Action:* Check menu permissions on installation sample-shop.",
  "*Impact:* Menu retrieval has not recovered; customer impact remains unverified.",
  "*Finding:* The scheduler handles the access denial and continues with empty menus.",
  "*Uncertainty:* Exact permissions and deployed-code match remain unverified.",
  "*Owner:* Unassigned.",
  "*Evidence:* <" +
    evidenceUrl +
    "|Inspected evidence> · 2026-10-24 00:00–15:00 UTC · inspected revision 9a61f557.",
].join("\n");

function visible(card: NonNullable<ReturnType<typeof buildSlackThreadSummaryCard>>): string {
  return buildSlackCompleteBlocksFallbackText([...card.blocks, ...(card.attachment.blocks ?? [])]);
}

describe("buildSlackThreadSummaryCard", () => {
  it("projects the approved order without changing the canonical fallback", () => {
    const card = buildSlackThreadSummaryCard(report);
    expect(card).not.toBeNull();
    expect(card?.attachment.color).toBe("#D99A00");
    expect(card?.fallbackText).toBe(report);
    const text = visible(card!);
    expect(text).toBe(
      [
        "Menu access denied",
        "⚠️ Action required",
        "*Next action:* Check menu permissions on installation sample-shop.",
        "*Impact:* Menu retrieval has not recovered; customer impact remains unverified.",
        "*Finding:* The scheduler handles the access denial and continues with empty menus.",
        "*Uncertainty:* Exact permissions and deployed-code match remain unverified.",
        "*Evidence:* <" +
          evidenceUrl +
          "|View evidence> · 2026-10-24 00:00–15:00 UTC · inspected revision 9a61f557.",
      ].join("\n\n"),
    );
    expect(card?.attachment.blocks?.slice(1, 2)).toEqual([
      { type: "context", elements: [{ type: "plain_text", text: "⚠️ Action required" }] },
    ]);
    expect(card?.blocks).toEqual([]);
    expect(text).not.toContain("*Owner:*");
    expect(text).not.toContain("*Recovery:*");
    expect(text.match(/View evidence/g) ?? []).toHaveLength(1);
  });

  it("uses green for no new action without inventing recovery", () => {
    const text = report
      .replace("⚠️ Action required", "✅ Reviewed—no new action")
      .replace(
        "Check menu permissions on installation sample-shop.",
        "No new action — accepted tracking covers installation sample-shop.",
      );
    const card = buildSlackThreadSummaryCard(text);
    expect(card?.attachment.color).toBe("#2E8B57");
    expect(card?.attachment.blocks?.slice(1, 2)).toEqual([
      { type: "context", elements: [{ type: "plain_text", text: "✅ Reviewed—no new action" }] },
    ]);
    expect(visible(card!)).toContain("has not recovered; customer impact remains unverified");
    expect(card?.fallbackText).toBe(text);
  });

  it("uses gray for an unclassified blocked report and keeps its blocker", () => {
    const text = [
      "❓ Unclassified · Severity unknown · Investigation blocked",
      "Finding: The selected log window could not be read.",
      "Action: Reconcile the pending Cloud Logging receipt for project sample-prd.",
      "Blocker: The exact read outcome is unknown.",
      "Owner: Unassigned.",
    ].join("\n");
    const card = buildSlackThreadSummaryCard(text);
    expect(card?.attachment.color).toBe("#9CA3AF");
    expect(card?.attachment.blocks?.slice(1, 2)).toEqual([
      { type: "context", elements: [{ type: "plain_text", text: "❓ Unclassified" }] },
    ]);
    expect(visible(card!)).toContain("*Impact:* Not separately established in this report.");
    expect(visible(card!)).toContain("*Blocker:* The exact read outcome is unknown.");
    expect(visible(card!)).toContain("Checked window/time zone not stated");
    expect(visible(card!)).not.toContain("View evidence");
  });

  it("keeps the original report when blocker aliases contain distinct gaps", () => {
    const text =
      report + "\nBlocker: Logging access unavailable.\nBlocked: Deployed revision unknown.";
    expect(buildSlackThreadSummaryCard(text)).toBeNull();
  });

  it.each(["existing-severity-policy", "authorized-human-declaration"] as const)(
    "keeps qualified active critical impact red despite acknowledgement and partial status: %s",
    (basis) => {
      const text =
        report.replace("⚠️ Action required", "✅ Reviewed—no new action") + "\nAcknowledged.";
      const card = buildSlackThreadSummaryCard(text, {
        verifiedActiveCritical: { basis, evidenceUrl },
      });
      expect(card?.attachment.color).toBe("#D92D20");
      expect(card?.attachment.blocks?.slice(1, 2)).toEqual([
        {
          type: "context",
          elements: [{ type: "plain_text", text: "🔴 Critical · Reviewed—no new action" }],
        },
      ]);
      expect(card?.fallbackText).toBe(text);
      expect(card?.fallbackText).toContain("Investigation partial");
    },
  );

  it("does not promote raw critical claims, P0 candidates or counts into critical severity", () => {
    const text = report
      .replace("Severity unknown", "Provisional priority P0")
      .replace(
        "The scheduler handles the access denial and continues with empty menus.",
        "10000 errors; critical impact was claimed but not verified.",
      );
    const card = buildSlackThreadSummaryCard(text);
    expect(card?.attachment.color).toBe("#D99A00");
    expect(card?.attachment.blocks?.slice(1, 2)).toEqual([
      { type: "context", elements: [{ type: "plain_text", text: "⚠️ Action required" }] },
    ]);
    expect(card?.fallbackText).toBe(text);
  });

  it("omits missing, unsafe or ambiguous evidence destinations without inventing a URL", () => {
    for (const evidence of [
      "",
      "\nEvidence: <http://example.invalid/read|Read> · 2026-10-24 UTC",
      "\nEvidence: <https://user:password@example.invalid/read|Read> · 2026-10-24 UTC",
      "\nEvidence: <" + evidenceUrl + "|One> <https://docs.slack.dev/|Two> · 2026-10-24 UTC",
    ]) {
      const text =
        report
          .split("\n")
          .filter((line) => !line.startsWith("*Evidence:*"))
          .join("\n") + evidence;
      const card = buildSlackThreadSummaryCard(text);
      expect(card).not.toBeNull();
      expect(visible(card!)).not.toContain("View evidence");
      expect(visible(card!)).not.toContain("password");
      expect(card?.fallbackText).toBe(text);
    }
  });

  it("does not resolve relative dates from the current clock", () => {
    const text = report.replace("2026-10-24 00:00–15:00 UTC", "today");
    const card = buildSlackThreadSummaryCard(text);
    expect(visible(card!)).not.toMatch(/\btoday\b/i);
    expect(visible(card!)).toContain("Checked window/time zone not stated");
    expect(visible(card!)).toContain("9a61f557");
    expect(card?.fallbackText).toBe(text);
  });

  it("uses explicit unknowns for absent fields and a neutral title", () => {
    const text = [
      "⚠️ Priority unknown · Action required",
      "**Finding:** The original ticket attempt failed; retry outcome remains unknown.",
      "**Action:** Inspect the terminal outcome of ticket attempt sample-123.",
      "**Owner:** Unassigned.",
    ].join("\n");
    const card = buildSlackThreadSummaryCard(text);
    expect(card?.attachment.blocks?.slice(1, 2)).toEqual([
      { type: "context", elements: [{ type: "plain_text", text: "⚠️ Action required" }] },
    ]);
    expect(card?.fallbackText).toBe(text);
    expect(visible(card!)).toContain("Investigation summary");
    expect(visible(card!)).toContain("*Impact:* Not separately established in this report.");
    expect(visible(card!)).toContain("retry outcome remains unknown");
  });

  it("escapes literal mention-shaped text while preserving supplied evidence", () => {
    const text = report.replace(
      "Check menu permissions on installation sample-shop.",
      "Check <!channel> and <@U123> in sample & installation.",
    );
    const card = buildSlackThreadSummaryCard(text);
    expect(visible(card!)).toContain("&lt;!channel&gt; and &lt;@U123&gt;");
    expect(visible(card!)).toContain("sample &amp; installation");
    expect(visible(card!)).not.toContain("<!channel>");
  });

  it("leaves oversized, repeated findings and unrecognized reports to complete text delivery", () => {
    expect(buildSlackThreadSummaryCard(report, { textLimit: 100 })).toBeNull();
    expect(buildSlackThreadSummaryCard(report + "\nFinding: A distinct failure.")).toBeNull();
    expect(buildSlackThreadSummaryCard("Working on the investigation.")).toBeNull();
    expect(
      buildSlackThreadSummaryCard(
        report.replace("Investigation partial", "Investigation partial · Investigation complete"),
      ),
    ).toBeNull();
    expect(
      buildSlackThreadSummaryCard(
        report.replace(
          "The scheduler handles the access denial and continues with empty menus.",
          "失敗".repeat(700),
        ),
      ),
    ).toBeNull();
    expect(
      buildSlackThreadSummaryCard(report.replace("Menu access denied", "Title ".repeat(40))),
    ).toBeNull();
    expect(
      buildSlackThreadSummaryCard(
        report.replace(
          "The scheduler handles the access denial and continues with empty menus.",
          "failed ".repeat(700),
        ),
      ),
    ).toBeNull();
  });
});

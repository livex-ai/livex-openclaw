import { describe, expect, it } from "vitest";
import { assertReportAmendmentAuthorized } from "./amendment-authorization.js";
import { prepareAmendment } from "./amendment.js";
import type { CatalogSnapshot } from "./schema.js";
const snapshot: CatalogSnapshot = {
  status: "ready",
  revision: "r",
  issues: [],
  scope: { accountId: "a", teamId: "T", channelId: "C", agentId: "oncall", senderId: "U" },
};
describe("current human instruction", () => {
  it("grounds all fields and keeps action conditions", () => {
    const text =
      "I’ll take this. Set priority from High to Low; next action: restart only after approval";
    expect(() =>
      assertReportAmendmentAuthorized(text, {
        priority: "Low",
        acceptOwnership: true,
        nextAction: "restart only after approval",
      }),
    ).not.toThrow();
    expect(() =>
      assertReportAmendmentAuthorized(text, {
        priority: "High",
        acceptOwnership: true,
        nextAction: "restart",
      }),
    ).toThrow();
  });
  it.each([
    "do not change priority to High",
    "what if I set priority to High?",
    "assign this to Sam; set priority to High",
    "set next action to investigate High latency",
    "set priority from High to Low",
  ])("never grants High from %s", (text) => {
    expect(() => assertReportAmendmentAuthorized(text, { priority: "High" })).toThrow();
  });
  it("asks for explicit confirmation of unfamiliar wording without staging a write", () => {
    const result = prepareAmendment(
      { priority: "Low" },
      { text: "This one feels low urgency now.", messageId: "2", threadId: "1" },
      snapshot,
    );
    expect(result).toHaveProperty("clarification", expect.stringContaining("set priority to Low"));
    expect(result).not.toHaveProperty("finalText");
  });
});

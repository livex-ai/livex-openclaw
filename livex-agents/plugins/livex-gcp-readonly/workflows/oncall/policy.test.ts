import { expect, it } from "vitest";
import { nextNotification, safeText } from "./policy.js";

it.each(["Low", "Medium", "High", "Critical"] as const)(
  "never pages a known %s issue",
  (priority) => {
    expect(nextNotification({ classification: "known", priority }, 9_000_000)).toBeNull();
  },
);

it("anchors reminders to successful initial delivery and emits one next step", () => {
  expect(nextNotification({ classification: "unknown" }, 100)).toEqual({ step: 0, tier: 0 });
  const finding = { classification: "unknown" as const, notifiedAt: 100, step: 0 };
  expect(nextNotification(finding, 600_099)).toBeNull();
  expect(nextNotification(finding, 600_100)).toEqual({ step: 1, tier: 0 });
  expect(nextNotification(finding, 9_000_000)).toEqual({ step: 1, tier: 0 });
});

it("stops acknowledged, uncertain and exhausted notification effects", () => {
  expect(nextNotification({ classification: "unknown", acknowledged: true }, 100)).toBeNull();
  expect(
    nextNotification(
      {
        classification: "unknown",
        delivery: { status: "uncertain", step: 0, attempts: 1, tick: 0 },
      },
      100,
    ),
  ).toBeNull();
  expect(
    nextNotification({ classification: "unknown", step: 7, notifiedAt: 1 }, 9_000_000),
  ).toBeNull();
});

it("neutralizes mentions and links from alert, model, case and log text", () => {
  const rendered = safeText("<@U123> <!channel> @here @everyone <https://evil.example|click>");
  expect(rendered).not.toMatch(/<@|<!|@here|@everyone|https:\/\//);
  expect(rendered).toContain("click");
});

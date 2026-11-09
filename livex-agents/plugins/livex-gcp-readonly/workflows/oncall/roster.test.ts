import { expect, it } from "vitest";
import { resolveRoster, rotationReferences } from "./roster.js";

it("resolves native Canvas names and mentions with exact P1/P2 labels", () => {
  const body = "<p>P1: @Tanmesh</p><p>P2: &lt;@U765432&gt;</p>";
  expect(rotationReferences(body)).toEqual({ p1: "@Tanmesh", p2: "<@U765432>" });
  expect(resolveRoster(body, [{ id: "U123456", profile: { display_name: "Tanmesh" } }])).toEqual({
    p1: "U123456",
    p2: "U765432",
  });
});

it("accepts table rotation and exposes ambiguous, deleted and bot names without guessing", () => {
  const body =
    "<table><tr><td><p>P1:</p></td><td><p>Alice</p></td></tr><tr><td>P2:</td><td>@U765432</td></tr></table>";
  expect(resolveRoster(body, [{ id: "U123456", name: "alice" }]).p1).toBe("U123456");
  const members = [
    { id: "U123456", name: "alice" },
    { id: "U654321", name: "alice" },
  ];
  expect(resolveRoster("P1: Alice\nP2: Missing", members).error).toBeTruthy();
  expect(resolveRoster("P1: Alice", [{ ...members[0], deleted: true }]).p1).toBeUndefined();
  expect(resolveRoster("P1: Alice", [{ ...members[0], is_bot: true }]).p1).toBeUndefined();
});

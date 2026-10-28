import { describe, expect, it } from "vitest";
import { buildSlackCompleteBlocksFallbackText } from "../../../extensions/slack/src/blocks-fallback.js";
import type { FindingComparison } from "../../../extensions/slack/src/investigations/matching.js";
import {
  parseCompletedInvestigations,
  type CompletedInvestigation,
} from "../../../extensions/slack/src/investigations/schema.js";
import type { SlackThreadSummaryCard } from "./legacy-report.js";

const logUrl = "https://logs.example.test/view?id=event-1";
const priorUrl = "https://sample.slack.com/archives/C1/p1000000000000000";
const ownerUrl = "https://sample.slack.com/archives/C1/p1000000000000001";
function update(patch: Partial<CompletedInvestigation> = {}): CompletedInvestigation {
  return parseCompletedInvestigations([
    {
      signature: {
        scope: {
          agentId: "oncall",
          accountId: "default",
          teamId: "T1",
          channelId: "C1",
          senderId: "U1",
        },
        service: "parser",
        environment: "production",
        operation: "parse",
        error: "missing variant_name",
      },
      task: "Document parsing",
      status: "Investigated",
      historySummary: "Confirmed missing field",
      waitingOn: "Owner unknown",
      prs: [],
      slackThreads: [],
      jiraTickets: [],
      evidenceUrls: [logUrl],
      facts: {
        finding: "Parser rejects a missing field.",
        impact: "Some documents fail.",
        nextAction: "Validate field handling.",
      },
      ...patch,
    },
  ])[0]!;
}
function finding(
  value: CompletedInvestigation,
  kind: FindingComparison["kind"] = "new",
): FindingComparison {
  return {
    kind,
    update: value,
    changes: [],
    ...(kind === "known-persistence" || kind === "changed"
      ? { canonicalThreadUrl: priorUrl, issueId: "issue-fixture" }
      : {}),
  };
}
function form() {
  return {
    title: "Document parsing fails",
    priority: "unknown",
    summary: "Parser rejects a missing field. Some documents fail; wider scope is unknown.",
    nextAction: "Validate field handling.",
    evidence: {
      links: [{ url: logUrl, label: "Logs" }],
      checkedWindow: "2026-10-25 00:00–01:00 UTC",
      note: "Deployment match unknown.",
    },
  };
}

// Loading in the test body keeps the missing feature an assertion failure during the initial RED run.
async function prepare() {
  const module = await import("./compact-report.js").catch(() => undefined);
  expect(
    module?.prepareCompactReport,
    "The typed compact-report owner must be implemented",
  ).toBeTypeOf("function");
  return module!.prepareCompactReport;
}
function visible(card: SlackThreadSummaryCard): string {
  return buildSlackCompleteBlocksFallbackText([...card.blocks, ...(card.attachment.blocks ?? [])]);
}

describe("typed compact investigation report", () => {
  it("renders the five approved fields in action-first order with matching complete fallback", async () => {
    const render = await prepare();
    const value = update();
    const prepared = render(form(), [value], [finding(value)]);
    const expected = [
      "*Title:* Document parsing fails",
      "*Priority:* Unknown",
      "*Next action:* Validate field handling. · Owner: Unassigned",
      "*Summary:* Parser rejects a missing field. Some documents fail; wider scope is unknown.",
      `*Evidence:* <${logUrl}|Logs> · Checked window: 2026-10-25 00:00–01:00 UTC · Deployment match unknown.`,
    ].join("\n\n");
    expect(prepared.text).toBe(expected);
    expect(prepared.card.fallbackText).toBe(expected);
    expect(visible(prepared.card)).toBe(expected);
    expect(prepared.card.blocks).toEqual([]);
    expect(prepared.card.attachment.color).toBe("#9CA3AF");
    expect(prepared.text).not.toMatch(/\n\n\*(Finding|Impact|Owner|Uncertainty):/);
    expect(prepared.form).toEqual(form());
  });

  it("keeps a host save notice inside the same five-field text and card projection", async () => {
    const render = await prepare();
    const value = update();
    const original = render(form(), [value], [finding(value)]);
    const module = await import("./compact-report.js");
    expect(
      module.appendCompactReportNotice,
      "The host notice must use the typed report owner",
    ).toBeTypeOf("function");
    const notice = "History save unavailable; completed findings were delivered but not recorded.";
    const annotated = module.appendCompactReportNotice(original, [value], notice);
    expect(annotated.form.evidence.note).toBe(`Deployment match unknown. · ${notice}`);
    expect(
      annotated.text.match(/\*(?:Title|Priority|Next action|Summary|Evidence|Uncertainty):\*/g),
    ).toEqual(["*Title:*", "*Priority:*", "*Next action:*", "*Summary:*", "*Evidence:*"]);
    expect(annotated.text).toContain(notice);
    expect(annotated.text).not.toContain("*Uncertainty:*");
    expect(visible(annotated.card)).toBe(annotated.text);
    expect(annotated.card.fallbackText).toBe(annotated.text);
    expect(annotated.form.summary).toBe(original.form.summary);
    expect(original.form.evidence.note).toBe("Deployment match unknown.");
  });

  it("derives legacy compatibility only from typed findings and keeps absent facts explicitly unknown", async () => {
    const render = await prepare();
    const value = update({
      task: "Typed task",
      historySummary: "Limits: hostile old prose must not be parsed",
      facts: {
        finding: "Typed finding",
        impact: "Impact unknown",
        nextAction: "Next action unknown",
      },
      evidenceUrls: [],
    });
    const prepared = render(undefined, [value], [finding(value)]);
    expect(prepared.text).toContain("Typed task");
    expect(prepared.text).toContain("Typed finding");
    expect(prepared.text).toContain("Impact unknown");
    expect(prepared.text).toContain("Next action unknown");
    expect(prepared.text).toContain("Unassigned");
    expect(prepared.text).toContain("Checked window unknown");
    expect(prepared.text).toContain("No verified evidence links supplied");
    expect(prepared.text).not.toContain("hostile old prose");
  });

  it("merges and preserves canonical prior links and all typed evidence links without duplicating URLs", async () => {
    const render = await prepare();
    const value = update();
    const input = {
      ...form(),
      evidence: {
        links: [
          { url: logUrl, label: "Logs" },
          { url: priorUrl, label: "Existing investigation" },
        ],
      },
      badge: { kind: "known-issue" },
    };
    const prepared = render(input, [value], [finding(value, "known-persistence")]);
    expect(prepared.form.evidence.links.map((link) => link.url)).toEqual([logUrl, priorUrl]);
    expect(prepared.text.match(/p1000000000000000/g)).toHaveLength(1);
    expect(prepared.text).toContain("Known issue");
    expect(prepared.text).toContain("Checked window unknown");
    const appended = render(form(), [value], [finding(value, "known-persistence")]);
    expect(appended.text).toContain(`<${priorUrl}|Prior investigation>`);
  });

  it("does not label a mixed known and new investigation wholly known", async () => {
    const render = await prepare();
    const known = update();
    const novel = update({
      task: "Embedding",
      signature: { ...known.signature, error: "embedding delete failed" },
      facts: {
        ...known.facts,
        finding: "Embedding failed.",
        nextAction: "Check embedding deletion.",
      },
    });
    expect(() =>
      render(
        { ...form(), badge: { kind: "known-issue" } },
        [known, novel],
        [finding(known, "known-persistence"), finding(novel)],
      ),
    ).toThrow(/known.*all|all.*known/i);
    const prepared = render(
      undefined,
      [known, novel],
      [finding(known, "known-persistence"), finding(novel)],
    );
    expect(prepared.text).toContain("Embedding failed.");
    expect(prepared.text).toContain(priorUrl);
    expect(prepared.form.badge?.kind).not.toBe("known-issue");
  });

  it("uses accepted typed owners and preserves multiple per-action associations", async () => {
    const render = await prepare();
    const parser = update({
      facts: { ...update().facts, owner: { name: "Maya", evidenceUrl: ownerUrl } },
    });
    const embedding = update({
      task: "Embedding",
      signature: { ...parser.signature, error: "embedding delete failed" },
      facts: {
        ...parser.facts,
        nextAction: "Check embedding deletion.",
        owner: { name: "Owen", evidenceUrl: priorUrl },
      },
    });
    const prepared = render(undefined, [parser, embedding], [finding(parser), finding(embedding)]);
    expect(prepared.text).toContain("Document parsing");
    expect(prepared.text).toContain("Maya");
    expect(prepared.text).toContain("Embedding");
    expect(prepared.text).toContain("Owen");
    expect(prepared.text).toContain("Check embedding deletion.");
    expect(prepared.text).not.toMatch(/\n\n\*Owner:/);
  });

  it("requires cited typed recovery evidence before rendering a resolved badge", async () => {
    const render = await prepare();
    const value = update();
    const resolved = { ...form(), badge: { kind: "resolved", evidenceUrl: logUrl } };
    expect(() => render(resolved, [value], [finding(value)])).toThrow(/recover/i);
    const recovered = update({
      facts: { ...value.facts, recovery: "No failures in the complete checked window." },
    });
    expect(() =>
      render(
        {
          ...resolved,
          badge: { kind: "resolved", evidenceUrl: "https://unverified.example/recovery" },
        },
        [recovered],
        [finding(recovered)],
      ),
    ).toThrow(/evidence/i);
    expect(render(resolved, [recovered], [finding(recovered)]).text).toContain("Resolved");
  });

  it.each([
    "unknown",
    "Recovery remains uncertain.",
    "Recovery is unconfirmed.",
    "Recovery is unverified.",
    "not recovered",
    "Not yet recovered.",
    "Recovery has not been confirmed.",
    "Still failing in the checked window.",
  ])("rejects an explicit unresolved recovery fact: %s", async (recovery) => {
    const render = await prepare();
    const value = update({ facts: { ...update().facts, recovery } });
    expect(() =>
      render(
        { ...form(), badge: { kind: "resolved", evidenceUrl: logUrl } },
        [value],
        [finding(value)],
      ),
    ).toThrow(/recover/i);
  });

  it("requires aggregate resolution evidence to support every affected issue", async () => {
    const render = await prepare();
    const parser = update({
      facts: { ...update().facts, recovery: "No failures in the complete checked window." },
    });
    const embeddingUrl = "https://logs.example.test/view?id=embedding-recovery";
    const embedding = update({
      task: "Embedding",
      signature: { ...parser.signature, error: "embedding delete failed" },
      facts: { ...parser.facts, finding: "Embedding deletion recovered." },
      evidenceUrls: [embeddingUrl],
    });
    const resolved = { ...form(), badge: { kind: "resolved", evidenceUrl: logUrl } };
    expect(() =>
      render(resolved, [parser, embedding], [finding(parser), finding(embedding)]),
    ).toThrow(/evidence/i);
    const jointlySupported = { ...embedding, evidenceUrls: [embeddingUrl, logUrl] };
    expect(
      render(resolved, [parser, jointlySupported], [finding(parser), finding(jointlySupported)])
        .text,
    ).toContain("Resolved");
  });

  it("never grants verified-critical red styling from the model priority field", async () => {
    const render = await prepare();
    const value = update();
    const prepared = render({ ...form(), priority: "critical" }, [value], [finding(value)]);
    expect(prepared.text).toContain("Critical");
    expect(prepared.card.attachment.color).not.toBe("#D92D20");
  });

  it("preserves unknown evidence notes and safely escapes mentions, link labels and URL delimiters", async () => {
    const render = await prepare();
    const url = "https://logs.example.test/view?id=event-1&part=2";
    const value = update({ evidenceUrls: [url] });
    const input = {
      ...form(),
      title: "Alert <@U1>",
      summary: "<!channel> <https://hostile.example|fake>",
      nextAction: "Ask <@U1>",
      evidence: { links: [{ url, label: "Logs <@U1>" }], note: "Recovery unknown." },
    };
    const prepared = render(input, [value], [finding(value)]);
    expect(prepared.text).not.toContain("<@U1>");
    expect(prepared.text).not.toContain("<!channel>");
    expect(prepared.text).not.toContain("<https://hostile.example|fake>");
    expect(prepared.text).toContain("&lt;@U1&gt;");
    expect(prepared.text).toContain("Recovery unknown.");
    expect(prepared.text).toContain("Checked window unknown");
    expect(prepared.text).toContain("&amp;part=2");
  });

  it.each([
    ["unsupported priority", () => ({ ...form(), priority: "P0" })],
    ["prose alias", () => ({ ...form(), finding: "Do not parse this alias" })],
    [
      "HTTP URL",
      () => ({ ...form(), evidence: { links: [{ url: "http://logs.example.test/raw" }] } }),
    ],
    [
      "userinfo URL",
      () => ({ ...form(), evidence: { links: [{ url: "https://user:secret@example.test/raw" }] } }),
    ],
    [
      "query credential",
      () => ({
        ...form(),
        evidence: {
          links: [{ url: "https://logs.example.test/?access_token=fixture-secret-0123456789" }],
        },
      }),
    ],
    [
      "secret prose",
      () => ({ ...form(), summary: "Authorization: Bearer fixture-secret-0123456789" }),
    ],
    ["oversized title", () => ({ ...form(), title: "x".repeat(151) })],
    ["oversized summary", () => ({ ...form(), summary: "x".repeat(3_001) })],
  ])("rejects %s with an actionable non-echoing form error", async (_name, makeInput) => {
    const render = await prepare();
    const value = update();
    let error: unknown;
    try {
      render(makeInput(), [value], [finding(value)]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/compact report/i);
    expect((error as Error).message).not.toContain("fixture-secret-0123456789");
    expect((error as Error).message).not.toContain("x".repeat(151));
  });

  it("rejects ungrounded evidence links rather than treating a typed URL as verified", async () => {
    const render = await prepare();
    const value = update();
    expect(() =>
      render(
        { ...form(), evidence: { links: [{ url: "https://invented.example/proof" }] } },
        [value],
        [finding(value)],
      ),
    ).toThrow(/typed.*evidence|evidence.*typed/i);
  });
});

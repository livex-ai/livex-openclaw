import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { createOncallReportProfile } from "./profile.js";

describe("oncall report profile configuration", () => {
  it("registers only explicitly configured agents", () => {
    const profiles: unknown[] = [];
    entry.register(
      createTestPluginApi({
        pluginConfig: { agentProfiles: { oncall: "compact-v1" } },
        registerReportProfile: (profile) => {
          profiles.push(profile);
        },
      }),
    );
    expect(profiles).toMatchObject([{ agentIds: ["oncall"], channels: ["slack"] }]);
    const unconfigured: unknown[] = [];
    entry.register(
      createTestPluginApi({
        registerReportProfile: (profile) => {
          unconfigured.push(profile);
        },
      }),
    );
    expect(unconfigured).toEqual([]);
  });
  it("rejects an unsupported profile instead of selecting an arbitrary module", () => {
    expect(() =>
      entry.register(
        createTestPluginApi({ pluginConfig: { agentProfiles: { oncall: "../other" } } }),
      ),
    ).toThrow();
  });
  it("leaves ordinary messages and nonmatching legacy scopes unchanged", () => {
    const profile = createOncallReportProfile(["oncall"]);
    expect(profile.prepareLegacy?.("Thanks", {})).toBeUndefined();
    expect(
      profile.prepareLegacy?.("Thanks", {
        agentId: "qa",
        botUserId: "U09JKS5FHUM",
        teamId: "T04MA1X41CM",
        isDirectMessage: false,
        originalThreadTs: "1.1",
        contextThreadTs: "1.1",
        replyThreadTs: "1.1",
      }),
    ).toBeUndefined();
  });
});

describe("prepared report notice projection", () => {
  function fixture() {
    const urls = Array.from({ length: 30 }, (_, index) => `https://e.test/${index}`);
    const ownerUrl = "https://e.test/owner";
    const priorUrl = "https://e.test/prior";
    const update = {
      task: "Parser failure",
      facts: {
        finding: "Parser rejects the field.",
        impact: "One document failed.",
        nextAction: "Validate the field.",
        owner: { name: "Operator", evidenceUrl: ownerUrl },
      },
      prs: [],
      slackThreads: [],
      jiraTickets: [],
      evidenceUrls: urls,
    };
    const input = {
      title: "Parser failure",
      priority: "unknown",
      summary: "One document failed.",
      nextAction: "Validate the field.",
      evidence: { links: urls.map((url) => ({ url, label: "Log" })) },
    };
    const context = {
      updates: [update],
      findings: [{ kind: "known-persistence", canonicalThreadUrl: priorUrl }],
    };
    return { input, context, ownerUrl, priorUrl };
  }

  it("preserves host-added owner and prior links when annotating the accepted report", () => {
    const profile = createOncallReportProfile(["oncall"]);
    const { input, context, ownerUrl, priorUrl } = fixture();
    const prepared = profile.prepare(input, context);
    expect(prepared.text).toContain(`<${ownerUrl}|Owner acceptance>`);
    expect(prepared.text).toContain(`<${priorUrl}|Prior investigation>`);
    const notice = "The final was delivered, but saving the catalog failed.";
    const annotated = profile.appendNotice(prepared, notice, context);
    expect(annotated.text).toContain(notice);
    expect(annotated.text).toContain(`<${ownerUrl}|Owner acceptance>`);
    expect(annotated.text).toContain(`<${priorUrl}|Prior investigation>`);
    expect(annotated.state).toMatchObject({
      evidence: { links: expect.arrayContaining(input.evidence.links), note: notice },
    });
    expect(annotated.channelData).toMatchObject({
      slack: { threadSummaryCard: { fallbackText: annotated.text } },
    });
    expect(prepared.text).not.toContain(notice);
    expect(() =>
      profile.prepare(
        {
          ...input,
          evidence: { links: [...input.evidence.links, { url: ownerUrl }] },
        },
        context,
      ),
    ).toThrow("Compact report evidence.links is invalid");
  });

  it("preserves normalized evidence and recovery URLs in prepared state", () => {
    const profile = createOncallReportProfile(["oncall"]);
    const { input, context } = fixture();
    const url = `https://e.test/${"é".repeat(350)}`;
    const normalized = new URL(url).href;
    expect(normalized.length).toBeGreaterThan(2_048);
    const update = context.updates[0]!;
    const recovery = {
      updates: [
        {
          ...update,
          evidenceUrls: [url],
          facts: { ...update.facts, recovery: "Original retry succeeded." },
        },
      ],
      findings: [{ kind: "new" }],
    };
    const prepared = profile.prepare(
      {
        ...input,
        evidence: { links: [{ url, label: "Retry" }] },
        badge: { kind: "resolved", evidenceUrl: url },
      },
      recovery,
    );
    const annotated = profile.appendNotice(prepared, "Catalog save failed.", recovery);
    expect(annotated.text).toContain(`<${normalized}|Retry>`);
    expect(annotated.text).toContain("Catalog save failed.");
    expect(annotated.state).toMatchObject({ badge: { evidenceUrl: normalized } });
  });

  it("preserves host-expanded matching notes while enforcing model and render limits", () => {
    const profile = createOncallReportProfile(["oncall"]);
    const { input, context } = fixture();
    const note = "n".repeat(2_000);
    const report = { ...input, evidence: { links: [], note } };
    const uncertain = {
      ...context,
      findings: [{ kind: "uncertain", reason: "Prior lookup unavailable" }],
    };
    const prepared = profile.prepare(report, uncertain);
    expect(prepared.text).toContain("History matching uncertain: Prior lookup unavailable");
    const notice = "Saving the catalog failed.";
    const annotated = profile.appendNotice(prepared, notice, uncertain);
    expect(annotated.text).toContain(note);
    expect(annotated.text).toContain("History matching uncertain: Prior lookup unavailable");
    expect(annotated.text).toContain(notice);
    expect(annotated.channelData).toMatchObject({
      slack: { threadSummaryCard: { fallbackText: annotated.text } },
    });
    expect(() =>
      profile.prepare(
        {
          ...report,
          evidence: { links: [], note: note + "n" },
        },
        uncertain,
      ),
    ).toThrow("Compact report evidence.note is invalid");
    expect(() => profile.appendNotice(annotated, "x".repeat(1_000), uncertain)).toThrow(
      "Compact report exceeds Slack field or message limits",
    );
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInvestigationDelivery, createInvestigationPublication } from "./delivery.js";
import { createInvestigationTurnRegistry } from "./runtime.js";
import { serializeCatalog, type CompletedInvestigation, type HistoryScope } from "./schema.js";
import { readCatalog } from "./store.js";
const scope: HistoryScope = {
  agentId: "oncall",
  accountId: "default",
  teamId: "T1",
  channelId: "C1",
  senderId: "U1",
};
const update: CompletedInvestigation = {
  signature: {
    scope,
    service: "api",
    environment: "prod",
    operation: "variant",
    error: "variant_name",
  },
  task: "Variant lookup",
  status: "open",
  historySummary: "Verified variant_name persists",
  waitingOn: "Owner unknown",
  prs: [],
  slackThreads: [],
  jiraTickets: [],
  facts: { finding: "Unknown variant_name", impact: "One job", nextAction: "Fix field mapping" },
  evidenceUrls: [],
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slack-investigation-delivery-"));
  roots.push(root);
  const filePath = path.join(root, "investigations.md");
  await fs.writeFile(filePath, serializeCatalog([]));
  const registry = createInvestigationTurnRegistry();
  const turn = registry.register({
    id: "one",
    scope,
    sessionKey: "agent:oncall:slack:channel:c1",
    filePath,
    snapshot: { status: "ready", scope, revision: "r", issues: [] },
    assertCurrent() {},
  });
  registry.stage("one", scope, "Final finding", [update]);
  const resolvePermalink = vi.fn(
    async () => "https://example.slack.com/archives/C1/p1000000000000000",
  );
  const publication = createInvestigationPublication({ turn, resolvePermalink });
  return { filePath, resolvePermalink, publication, registry, turn };
}
describe("settled Slack investigation publication", () => {
  it("records only a matching confirmed final receipt with its verified permalink", async () => {
    const { filePath, publication, resolvePermalink } = await setup();
    const result = await publication.publish({
      kind: "final",
      text: "Final finding",
      complete: true,
      delivery: { visibleReplySent: true, messageIds: ["1000000000.000000"] },
    });
    expect(result.status).toBe("recorded");
    expect(resolvePermalink).toHaveBeenCalledWith("1000000000.000000");
    const catalog = await readCatalog({ filePath, scope });
    expect(catalog.issues).toHaveLength(1);
    expect(catalog.issues[0]?.slackThreads[0]).toBe(
      "https://example.slack.com/archives/C1/p1000000000000000",
    );
    await publication.publish({
      kind: "final",
      text: "Final finding",
      complete: true,
      delivery: { visibleReplySent: true, messageIds: ["1000000000.000000"] },
    });
    expect((await readCatalog({ filePath, scope })).issues[0]?.whatWeDidLast).toHaveLength(1);
  });
  it.each([true, false])(
    "reports confirmed partial saves accurately (valid finding: %s)",
    async (includeValid) => {
      const { filePath, publication, registry } = await setup();
      const uncertain = { ...update, signature: { ...update.signature, operation: "unknown" } };
      registry.stage(
        "one",
        scope,
        "Final finding",
        includeValid ? [update, uncertain] : [uncertain],
      );
      const input = {
        kind: "final" as const,
        text: "Final finding",
        complete: true,
        delivery: { visibleReplySent: true, messageIds: ["1000000000.000000"] },
      };

      expect(await publication.publish(input)).toMatchObject({
        status: "partial",
        saved: includeValid ? 1 : 0,
        skipped: 1,
      });
      const catalog = await readCatalog({ filePath, scope });
      expect(catalog.issues).toHaveLength(includeValid ? 1 : 0);
      expect((await publication.publish(input)).status).toBe("skipped");
      expect((await readCatalog({ filePath, scope })).revision).toBe(catalog.revision);
    },
  );
  it("annotates an accepted final with saved and skipped counts instead of total failure", async () => {
    const { filePath, registry, turn, resolvePermalink } = await setup();
    registry.stage("one", scope, "Final finding", [
      update,
      { ...update, signature: { ...update.signature, operation: "unknown" } },
    ]);
    const annotateAcceptedFinal = vi.fn(async (_input: { messageId: string; text: string }) => {});
    const delivery = createInvestigationDelivery({
      turn,
      sourceMessageIds: ["source-alert"],
      resolvePermalink,
      annotateAcceptedFinal,
      reportError() {},
      deliver: async () => ({ visibleReplySent: true, messageIds: ["1000000000.000000"] }),
    });

    await delivery.deliver({ text: "Final finding" }, { kind: "final" });
    const annotation = annotateAcceptedFinal.mock.calls[0]?.[0];
    expect(annotation).toMatchObject({ messageId: "1000000000.000000" });
    expect(annotation?.text).toContain("saved 1 finding");
    expect(annotation?.text).toContain("skipped 1");
    expect(annotation?.text).not.toContain("saving the catalog failed");
    expect((await readCatalog({ filePath, scope })).issues).toHaveLength(1);
  });
  it("does not claim a confirmed partial save when catalog limits prevent reading", async () => {
    const { filePath, publication } = await setup();
    const existing = "x".repeat(2 * 1024 * 1024 + 1);
    await fs.writeFile(filePath, existing);
    const result = await publication.publish({
      kind: "final",
      text: "Final finding",
      complete: true,
      delivery: { visibleReplySent: true, messageIds: ["1000000000.000000"] },
    });
    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("saved");
    expect(await fs.readFile(filePath, "utf8")).toBe(existing);
  });
  it("refuses publication when the owning runtime closes during permalink retrieval", async () => {
    const { filePath, publication, resolvePermalink, registry } = await setup();
    let release: ((value: string) => void) | undefined;
    resolvePermalink.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const pending = publication.publish({
      kind: "final",
      text: "Final finding",
      complete: true,
      delivery: { visibleReplySent: true, messageIds: ["1000000000.000000"] },
    });
    await vi.waitFor(() => expect(resolvePermalink).toHaveBeenCalledTimes(1));
    registry.close();
    release?.("https://example.slack.com/archives/C1/p1000000000000000");
    expect((await pending).status).toBe("failed");
    expect((await readCatalog({ filePath, scope })).issues).toEqual([]);
  });
  it("does not publish progress, a changed final, partial or uncertain delivery", async () => {
    const { filePath, publication, resolvePermalink } = await setup();
    for (const input of [
      {
        kind: "tool" as const,
        text: "Final finding",
        complete: true,
        delivery: { visibleReplySent: true, messageIds: ["1.0"] },
      },
      {
        kind: "final" as const,
        text: "Different final",
        complete: true,
        delivery: { visibleReplySent: true, messageIds: ["1.0"] },
      },
      {
        kind: "final" as const,
        text: "Final finding",
        complete: false,
        delivery: { visibleReplySent: true, messageIds: ["1.0"] },
      },
      {
        kind: "final" as const,
        text: "Final finding",
        complete: true,
        delivery: { visibleReplySent: false },
      },
    ]) {
      expect((await publication.publish(input)).status).toBe("skipped");
    }
    expect(resolvePermalink).not.toHaveBeenCalled();
    expect((await readCatalog({ filePath, scope })).issues).toEqual([]);
  });
  it("waits for finalization and exposes disk failure while preserving the old catalog", async () => {
    const { filePath, publication } = await setup();
    await fs.rename(filePath, filePath + ".saved");
    const result = await publication.publish({
      kind: "final",
      text: "Final finding",
      complete: true,
      delivery: {
        visibleReplySent: false,
        finalization: Promise.resolve({
          visibleReplySent: true,
          messageIds: ["1000000000.000000"],
        }),
      },
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/catalog/i);
    expect(await fs.readFile(filePath + ".saved", "utf8")).toBe(serializeCatalog([]));
  });
});

import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupInvestigationHistory } from "./lookup.js";
import type { CatalogSnapshot, HistoryScope } from "./schema.js";

const f = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn() }));
vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({ getActiveMemoryProvider: f.open }));
vi.mock("./store.js", () => ({ readCatalog: f.read }));

const scope: HistoryScope = {
  agentId: "oncall",
  accountId: "default",
  teamId: "T1",
  channelId: "C1",
  senderId: "U1",
};
const filePath = path.resolve("/synthetic/oncall/investigations.md");
function config(): OpenClawConfig {
  return {
    plugins: { allow: ["slack", "memory-core"] },
    agents: {
      entries: {
        oncall: {
          workspace: "/synthetic/workspace",
          memory: {
            search: {
              includeWorkspace: false,
              extraPaths: [filePath],
              sources: ["memory"],
              rememberAcrossConversations: false,
              experimental: { sessionMemory: false },
              provider: "none",
            },
          },
        },
      },
    },
  };
}
const snapshot = (): CatalogSnapshot => ({ status: "ready", scope, revision: "r1", issues: [] });
const params = () => ({
  cfg: config(),
  agentId: "oncall",
  sessionKey: "agent:oncall:slack:channel:C1",
  scope,
  filePath,
  query: "variant_name",
  assertCurrent: vi.fn(),
});

describe("scoped investigation memory lookup", () => {
  beforeEach(() => {
    f.open.mockReset();
    f.read.mockReset().mockResolvedValue(snapshot());
  });
  it("refuses broad workspace or global extra-path indexing before opening a provider", async () => {
    for (const broad of ["workspace", "global-extra", "sessions", "remote-embeddings"] as const) {
      const p = params();
      const search = p.cfg.agents!.entries!.oncall!.memory!.search!;
      if (broad === "workspace") {
        search.includeWorkspace = true;
      }
      if (broad === "global-extra") {
        p.cfg.memory = { search: { extraPaths: ["/synthetic/private.md"] } };
      }
      if (broad === "sessions") {
        search.sources = ["memory", "sessions"];
      }
      if (broad === "remote-embeddings") {
        search.provider = "openai";
      }
      const result = await lookupInvestigationHistory(p);
      expect(result.memory.status).toBe("unavailable");
      expect(result.snapshot.status).toBe("ready");
      expect(result.context).toContain("native memory");
    }
    expect(f.open).not.toHaveBeenCalled();
  });
  it("uses the native memory owner with current session authority and closes its lease", async () => {
    const search = vi.fn().mockResolvedValue({ hits: [], coverage: "complete" });
    const close = vi.fn();
    f.open.mockResolvedValue({
      providerId: "memory-core",
      adapter: "legacy",
      provider: { search, close, health: async () => ({ status: "ready" }) },
    });
    const p = params();
    const result = await lookupInvestigationHistory(p);
    expect(result.memory.status).toBe("ready");
    expect(f.open.mock.calls[0]![0].context.authority).toMatchObject({
      kind: "session",
      sessionKey: p.sessionKey,
    });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "variant_name", sources: ["memory"], lexicalOnly: true }),
    );
    expect(close).toHaveBeenCalledOnce();
  });
  it("never releases non-catalog or session excerpts to the model", async () => {
    f.open.mockResolvedValue({
      providerId: "memory-core",
      provider: {
        search: async () => ({
          hits: [
            {
              reference: { providerId: "memory-core", id: "/synthetic/private.md" },
              excerpt: "PRIVATE-OTHER-NOTE",
              source: "memory",
            },
            {
              reference: { providerId: "memory-core", id: filePath },
              excerpt: "PRIVATE-TRANSCRIPT",
              source: "sessions",
            },
          ],
        }),
        close: vi.fn(),
        health: async () => ({ status: "ready" }),
      },
    });
    const result = await lookupInvestigationHistory(params());
    expect(result.context).not.toContain("PRIVATE-OTHER-NOTE");
    expect(result.context).not.toContain("PRIVATE-TRANSCRIPT");
    expect(result.memory.status).toBe("partial");
  });
  it("keeps unavailable/corrupt history distinct from a successfully empty catalog", async () => {
    f.read.mockResolvedValue({ ...snapshot(), status: "corrupt", reason: "invalid record" });
    const result = await lookupInvestigationHistory(params());
    expect(result.snapshot.status).toBe("corrupt");
    expect(result.context).toContain("corrupt");
    expect(result.context).not.toContain("no known issues");
    expect(f.open).not.toHaveBeenCalled();
  });
  it("propagates revoked invocation authority while still closing a provider lease", async () => {
    const p = params();
    let current = true;
    p.assertCurrent.mockImplementation(() => {
      if (!current) {
        throw new Error("invocation closed");
      }
    });
    const close = vi.fn();
    f.open.mockResolvedValue({
      providerId: "memory-core",
      provider: {
        search: async () => {
          current = false;
          return { hits: [] };
        },
        close,
        health: async () => ({ status: "ready" }),
      },
    });
    await expect(lookupInvestigationHistory(p)).rejects.toThrow("invocation closed");
    expect(close).toHaveBeenCalledOnce();
  });
  it("makes a paused native index visible even when its legacy health status says ready", async () => {
    f.open.mockResolvedValue({
      providerId: "memory-core",
      provider: {
        health: async () => ({
          status: "ready",
          details: {
            legacy: {
              custom: {
                indexIdentity: {
                  status: "mismatched",
                  reason: "index scope changed",
                  code: "scope",
                  owner: "configuration",
                },
              },
            },
          },
        }),
        search: async () => ({ hits: [], coverage: "complete" }),
        close: vi.fn(),
      },
    });
    const result = await lookupInvestigationHistory(params());
    expect(result.memory.status).toBe("unavailable");
    expect(result.context).toContain("index scope changed");
  });
  it("preserves native coverage warnings without treating a candidate response as complete", async () => {
    f.open.mockResolvedValue({
      providerId: "memory-core",
      provider: {
        health: async () => ({ status: "ready" }),
        search: async () => ({
          hits: [],
          coverage: "complete",
          warning: "Index refresh is incomplete",
        }),
        close: vi.fn(),
      },
    });
    const result = await lookupInvestigationHistory(params());
    expect(result.memory.status).toBe("partial");
    expect(result.context).toContain("Index refresh is incomplete");
  });
  it("projects large known issues compactly and keeps later matching candidates visible", async () => {
    const first = {
      issueId: "issue-one",
      signature: {
        scope,
        service: "catalog",
        environment: "prod",
        operation: "variant_name",
        error: "variant_name",
      },
      task: "variant_name",
      status: "open",
      waitingOn: "Owner investigating",
      prs: [],
      jiraTickets: [],
      slackThreads: ["https://example.slack.com/archives/C1/p1234567890123456"],
      lastUpdated: "2026-10-21",
      whatWeDidLast: Array.from({ length: 80 }, () => ({
        completedAt: "2026-10-21",
        summary: "old evidence ".repeat(500),
        kind: "known-persistence" as const,
        facts: {
          finding: "Known issue persists",
          impact: "No new scope",
          nextAction: "Wait for owner",
        },
        evidenceUrls: [],
        reportUrl: "https://example.slack.com/archives/C1/p1234567890123456",
      })),
    };
    f.read.mockResolvedValue({
      ...snapshot(),
      issues: [
        first,
        { ...first, issueId: "issue-two", whatWeDidLast: first.whatWeDidLast.slice(0, 1) },
      ],
    });
    const p = params();
    p.cfg = {};
    const result = await lookupInvestigationHistory(p);
    expect(result.context).toContain("issue-one");
    expect(result.context).toContain("issue-two");
    expect(result.context).toContain("historyEntries");
    expect(result.context.length).toBeLessThan(8000);
  });
});

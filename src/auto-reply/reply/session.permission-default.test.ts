import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState } from "./session.js";

// Keep the real initialization/commit owner; transcript cloning has separate storage tests.
vi.mock("./session-fork.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-fork.js")>()),
  forkSessionFromParent: vi.fn(async () => ({
    sessionId: "forked-thread",
    sessionFile: "forked-thread",
  })),
}));

describe("reply session permission defaults", () => {
  const tempDirs = createTempDirTracker();
  const sessionKey = "agent:main:slack:channel:c1:thread:123";
  let stateDir: string;
  let storePath: string;
  let cfg: OpenClawConfig;

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-permission-default-");
    storePath = path.join(stateDir, "agents/main/sessions/sessions.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    cfg = {
      agents: { defaults: { workspace: stateDir } },
      session: { store: storePath },
    };
  });

  afterEach(async () => {
    await cleanupSessionStateForTest({ stateDir });
    vi.unstubAllEnvs();
    tempDirs.cleanup();
  });

  const scope = () => ({ agentId: "main", storePath, sessionKey });
  const initialize = (parentSessionKey?: string) =>
    initSessionState({
      cfg,
      ctx: finalizeInboundContext({
        Body: "Investigate this synthetic alert",
        From: "slack:channel:C1",
        To: "C1",
        SessionKey: sessionKey,
        ParentSessionKey: parentSessionKey,
        Provider: "slack",
        Surface: "slack",
        ChatType: "channel",
        MessageThreadId: "123",
      }),
      commandAuthorized: true,
    });

  it.each([
    { source: "defaults", existing: false },
    { source: "defaults", existing: true },
    { source: "agent", existing: false },
    { source: "agent", existing: true },
  ] as const)(
    "persists $source read-only mode (existing: $existing)",
    async ({ source, existing }) => {
      cfg.agents = {
        defaults: {
          workspace: stateDir,
          ...(source === "defaults" ? { permissionModeDefault: "read-only" as const } : {}),
        },
        ...(source === "agent"
          ? { entries: { main: { permissionModeDefault: "read-only" as const } } }
          : {}),
      };
      if (existing) {
        await replaceSessionEntry(scope(), { sessionId: "existing-thread", updatedAt: Date.now() });
      }

      const result = await initialize();

      expect(result.sessionEntry.permissionMode).toBe("read-only");
      expect(loadSessionEntry(scope())?.permissionMode).toBe("read-only");
      if (existing) {
        expect(result.sessionId).toBe("existing-thread");
      }
      // Removing the config default does not erase a saved session selection.
      cfg.agents = { defaults: { workspace: stateDir } };
      const followup = await initialize();
      expect(followup.sessionId).toBe(result.sessionId);
      expect(followup.sessionEntry.permissionMode).toBe("read-only");
      expect(loadSessionEntry(scope())?.permissionMode).toBe("read-only");
    },
  );

  it.each(["read-only", "guarded", "workspace", "full"] as const)(
    "preserves explicit %s mode",
    async (permissionMode) => {
      cfg.agents = { defaults: { workspace: stateDir, permissionModeDefault: "read-only" } };
      await replaceSessionEntry(scope(), {
        sessionId: "explicit-thread",
        updatedAt: Date.now(),
        permissionMode,
      });

      const result = await initialize();

      expect(result.sessionId).toBe("explicit-thread");
      expect(result.sessionEntry.permissionMode).toBe(permissionMode);
      expect(loadSessionEntry(scope())?.permissionMode).toBe(permissionMode);
    },
  );

  it.each([undefined, "read-only"] as const)(
    "keeps parent full permission out of the child (default: %s)",
    async (permissionModeDefault) => {
      cfg.agents = { defaults: { workspace: stateDir, permissionModeDefault } };
      const parentSessionKey = "agent:main:slack:channel:c1";
      const parentScope = { agentId: "main", storePath, sessionKey: parentSessionKey };
      await replaceSessionEntry(parentScope, {
        sessionId: "parent-thread",
        updatedAt: Date.now(),
        permissionMode: "full",
      });

      const result = await initialize(parentSessionKey);

      expect(result.sessionEntry.forkedFromParent).toBe(true);
      expect(result.sessionEntry.forkSource).toEqual({
        sessionKey: parentSessionKey,
        sessionId: "parent-thread",
      });
      expect(result.sessionEntry.permissionMode).toBe(permissionModeDefault);
      expect(loadSessionEntry(scope())?.permissionMode).toBe(permissionModeDefault);
      expect(loadSessionEntry(parentScope)?.permissionMode).toBe("full");
    },
  );
});

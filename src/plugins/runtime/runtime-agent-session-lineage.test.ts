import fs from "node:fs";
import path from "node:path";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withDescendantSessionRead } from "./runtime-agent-session-lineage.js";

const tempDirs = createTempDirTracker();
const ancestor = {
  sessionKey: "agent:oncall:slack:channel:c123:thread:1.0",
  sessionId: "parent-id",
};
const descendant = { sessionKey: "agent:debugger:subagent:child", sessionId: "child-id" };
const parent: SessionEntry = {
  sessionId: ancestor.sessionId,
  updatedAt: 1,
  lifecycleRevision: "parent-life",
};
const child: SessionEntry = {
  sessionId: descendant.sessionId,
  updatedAt: 1,
  lifecycleRevision: "child-life",
  spawnedBy: ancestor.sessionKey,
  spawnedBySessionId: ancestor.sessionId,
  parentSessionKey: ancestor.sessionKey,
  parentSessionId: ancestor.sessionId,
  parentSessionLifecycleRevision: parent.lifecycleRevision,
  spawnedBySenderIsOwner: true,
};
function write(agentId: string, sessionKey: string, entry: SessionEntry) {
  replaceSessionEntrySync(
    { agentId, sessionKey, storePath: resolveSessionStorePathCore(undefined, { agentId }) },
    entry,
  );
}
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("descendant-read-"));
  setRuntimeConfigSnapshot({ agents: { entries: { oncall: {}, debugger: {} } } });
  write("oncall", ancestor.sessionKey, parent);
  write("debugger", descendant.sessionKey, child);
});
afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});
const request = () => ({ ancestor, descendant, assertCurrent() {} });

it("verifies persisted cross-agent spawn lineage after reopening native readers, then expires the callback", async () => {
  for (const agentId of ["oncall", "debugger"]) {
    await closeOpenClawAgentDatabaseByPathAsync(
      resolveOpenClawAgentSqlitePath({ agentId }),
      agentId,
    );
  }
  let retained: (() => void) | undefined;
  const result = await withDescendantSessionRead(request(), async (selected) => {
    expect(selected).toMatchObject({ ...descendant, agentId: "debugger" });
    selected.assertCurrent();
    retained = selected.assertCurrent;
    return "verified";
  });
  expect(result).toBe("verified");
  expect(retained).toThrow("no longer current");
});

it.each([
  {
    label: "different parent",
    patch: { spawnedBy: "agent:oncall:other", parentSessionKey: "agent:oncall:other" },
  },
  {
    label: "stale parent incarnation",
    patch: { spawnedBySessionId: "old-parent", parentSessionId: "old-parent" },
  },
  { label: "stale parent lifecycle", patch: { parentSessionLifecycleRevision: "old-life" } },
  { label: "inconsistent navigation", patch: { parentSessionKey: "agent:oncall:other" } },
  { label: "unstamped authority", patch: { spawnedBySenderIsOwner: undefined } },
])("rejects $label without calling the consumer", async ({ patch }) => {
  write("debugger", descendant.sessionKey, { ...child, ...patch });
  const consume = vi.fn(async () => undefined);
  await expect(withDescendantSessionRead(request(), consume)).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();
});

it("rejects the wrong selected descendant incarnation", async () => {
  await expect(
    withDescendantSessionRead(
      { ...request(), descendant: { ...descendant, sessionId: "other" } },
      async () => undefined,
    ),
  ).rejects.toThrow("lineage");
});

it.each(["parent", "child", "lineage"] as const)(
  "revokes %s changes before an awaited consumer effect",
  async (change) => {
    let effects = 0;
    await expect(
      withDescendantSessionRead(request(), async (selected) => {
        await Promise.resolve();
        if (change === "parent") {
          write("oncall", ancestor.sessionKey, { ...parent, lifecycleRevision: "new-life" });
        } else {
          write("debugger", descendant.sessionKey, {
            ...child,
            ...(change === "child"
              ? { lifecycleRevision: "new-life" }
              : { spawnedBy: "agent:oncall:other" }),
          });
        }
        selected.assertCurrent();
        effects++;
      }),
    ).rejects.toThrow("lineage");
    expect(effects).toBe(0);
  },
);

it("rejects cyclic lineage", async () => {
  write("debugger", descendant.sessionKey, {
    ...child,
    spawnedBy: descendant.sessionKey,
    spawnedBySessionId: descendant.sessionId,
    parentSessionKey: descendant.sessionKey,
    parentSessionId: descendant.sessionId,
    parentSessionLifecycleRevision: child.lifecycleRevision,
  });
  await expect(withDescendantSessionRead(request(), async () => undefined)).rejects.toThrow(
    "lineage",
  );
});

it("bounds lineage traversal", async () => {
  for (let i = 0; i < 65; i++) {
    write("debugger", `agent:debugger:subagent:hop-${i}`, {
      sessionId: `hop-${i}`,
      updatedAt: 1,
      spawnedBy: i === 64 ? ancestor.sessionKey : `agent:debugger:subagent:hop-${i + 1}`,
      spawnedBySessionId: i === 64 ? ancestor.sessionId : `hop-${i + 1}`,
      parentSessionLifecycleRevision: i === 64 ? parent.lifecycleRevision : undefined,
      spawnedBySenderIsOwner: true,
    });
  }
  await expect(
    withDescendantSessionRead(
      {
        ...request(),
        descendant: { sessionKey: "agent:debugger:subagent:hop-0", sessionId: "hop-0" },
      },
      async () => undefined,
    ),
  ).rejects.toThrow("lineage");
});

it("revokes a logical session-store reroute even while original storage remains", async () => {
  await expect(
    withDescendantSessionRead(request(), async (selected) => {
      setRuntimeConfigSnapshot({ session: { store: "/synthetic/other/{agentId}/sessions.json" } });
      selected.assertCurrent();
    }),
  ).rejects.toThrow("lineage");
});

it("retains every persisted hop across agents and rejects a middle ancestor reset", async () => {
  const middle = { sessionKey: "agent:debugger:subagent:middle", sessionId: "middle-id" };
  const middleEntry: SessionEntry = {
    ...child,
    sessionId: middle.sessionId,
    lifecycleRevision: "middle-life",
  };
  write("debugger", middle.sessionKey, middleEntry);
  write("debugger", descendant.sessionKey, {
    ...child,
    spawnedBy: middle.sessionKey,
    spawnedBySessionId: middle.sessionId,
    parentSessionKey: middle.sessionKey,
    parentSessionId: middle.sessionId,
    parentSessionLifecycleRevision: middleEntry.lifecycleRevision,
  });
  await expect(
    withDescendantSessionRead(request(), async (selected) => {
      selected.assertCurrent();
      return selected.sessionId;
    }),
  ).resolves.toBe(descendant.sessionId);
  let effects = 0;
  await expect(
    withDescendantSessionRead(request(), async (selected) => {
      await Promise.resolve();
      write("debugger", middle.sessionKey, {
        ...middleEntry,
        lifecycleRevision: "new-middle-life",
      });
      selected.assertCurrent();
      effects++;
    }),
  ).rejects.toThrow("lineage");
  expect(effects).toBe(0);
});

it("allows explicit current-child selection after a same-ID reset while retaining exact ancestor lineage", async () => {
  write("debugger", descendant.sessionKey, { ...child, lifecycleRevision: "reset-before-command" });
  await expect(
    withDescendantSessionRead(request(), async (selected) => {
      selected.assertCurrent();
      return selected.sessionId;
    }),
  ).resolves.toBe(descendant.sessionId);
});

it("rejects configured symlink retarget while old database remains unchanged", async () => {
  const aliases = path.join(process.env.OPENCLAW_STATE_DIR!, "aliases");
  fs.mkdirSync(aliases);
  for (const agentId of ["oncall", "debugger"]) {
    fs.symlinkSync(
      resolveOpenClawAgentSqlitePath({ agentId }),
      path.join(aliases, `${agentId}.sqlite`),
    );
  }
  setRuntimeConfigSnapshot({
    session: { store: path.join(aliases, "{agentId}.sqlite") },
    agents: { entries: { oncall: {}, debugger: {} } },
  });
  let entered = false;
  let effect = false;
  await expect(
    withDescendantSessionRead(request(), async (selected) => {
      entered = true;
      selected.assertCurrent();
      await Promise.resolve();
      fs.unlinkSync(path.join(aliases, "debugger.sqlite"));
      fs.symlinkSync(
        resolveOpenClawAgentSqlitePath({ agentId: "oncall" }),
        path.join(aliases, "debugger.sqlite"),
      );
      selected.assertCurrent();
      effect = true;
    }),
  ).rejects.toThrow();
  expect(entered).toBe(true);
  expect(effect).toBe(false);
});

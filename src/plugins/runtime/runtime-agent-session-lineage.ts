import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore, validateSessionId } from "../../config/sessions/paths.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";

export type DescendantSessionIdentity = { sessionKey: string; sessionId: string };
export type DescendantSessionReadParams = {
  ancestor: DescendantSessionIdentity;
  descendant: DescendantSessionIdentity;
  /** The original operation owns caller authority; lineage never replaces it. */
  assertCurrent: () => void;
};
export type DescendantSessionRead = DescendantSessionIdentity & {
  agentId: string;
  assertCurrent: () => void;
};

const LINEAGE_FIELDS = [
  "sessionId",
  "lifecycleRevision",
  "spawnedBy",
  "spawnedBySessionId",
  "spawnedBySenderIsOwner",
  "parentSessionKey",
  "parentSessionId",
  "parentSessionLifecycleRevision",
] as const satisfies readonly (keyof SessionEntry)[];
const MAX_LINEAGE_HOPS = 64;
function refuse(): never {
  throw new Error("Selected descendant session lineage is unavailable or no longer current");
}

function agentFor(identity: DescendantSessionIdentity): string {
  const parsed = parseAgentSessionKey(identity.sessionKey);
  if (!parsed || isIncognitoSessionKey(identity.sessionKey)) {
    throw new Error("Descendant reads require canonical durable agent sessions");
  }
  validateSessionId(identity.sessionId);
  return parsed.agentId;
}

/** Keep the native reader's logical route and row publication custody through the consumer. */
async function withLineageEntry<T>(
  identity: DescendantSessionIdentity,
  assertCaller: () => void,
  run: (captured: {
    entry: SessionEntry;
    agentId: string;
    assertCurrent: () => void;
  }) => Promise<T>,
): Promise<T> {
  const agentId = agentFor(identity);
  const storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId });
  const sessionKey = resolveSqliteSessionKey(identity.sessionKey, agentId);
  let predicate: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let revision = 0;
  try {
    return await withSessionEntryReadOnlyInWorker(
      { agentId, sessionKey, storePath, readConsistency: "latest" },
      assertCaller,
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        const entry = read.value;
        const source = owner.source;
        if (
          !entry ||
          entry.sessionId !== identity.sessionId ||
          owner.kind !== "file" ||
          !source ||
          !predicate?.acknowledge(entry, revision)
        ) {
          refuse();
        }
        const retained = predicate;
        const assertCurrent = () => {
          assertCaller();
          if (
            resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId }) !==
            storePath
          ) {
            refuse();
          }
          owner.assertCurrent();
          if (!retained.isCurrent()) {
            refuse();
          }
        };
        assertCurrent();
        const value = await run({ entry, agentId, assertCurrent });
        assertCurrent();
        return value;
      },
      (_database, source) => {
        if (!source.key.startsWith("file:")) {
          refuse();
        }
        predicate?.release();
        // Join before the read can yield: a concurrent publication cannot certify an old row.
        predicate = retainPreparedSessionEntryPredicate({
          databaseIdentity: source.key,
          sessionKey,
          entry: undefined,
          acquiring: true,
          matches: (before, after) =>
            Boolean(before) === Boolean(after) &&
            LINEAGE_FIELDS.every((field) => before?.[field] === after?.[field]),
        });
        revision = predicate.captureRevision();
      },
    );
  } finally {
    predicate?.release();
  }
}

/** Bounded metadata-only descendant proof. It grants no execution or session mutation authority. */
export async function withDescendantSessionRead<T>(
  input: DescendantSessionReadParams,
  run: (selected: DescendantSessionRead) => Promise<T>,
): Promise<T> {
  const ancestor = { ...input.ancestor };
  const descendant = { ...input.descendant };
  const assertCaller = input.assertCurrent;
  agentFor(ancestor);
  agentFor(descendant);
  if (ancestor.sessionKey === descendant.sessionKey) {
    refuse();
  }
  const captured: Array<{ assertCurrent: () => void }> = [];
  const seen = new Set<string>();
  let active = true;
  const assertCurrent = () => {
    assertCaller();
    if (!active) {
      refuse();
    }
    for (const entry of captured) {
      entry.assertCurrent();
    }
  };
  const visit = async (
    target: DescendantSessionIdentity,
    depth: number,
    expectedLifecycle?: string,
  ): Promise<T> => {
    assertCurrent();
    if (depth >= MAX_LINEAGE_HOPS || seen.has(target.sessionKey)) {
      refuse();
    }
    seen.add(target.sessionKey);
    return withLineageEntry(target, assertCaller, async (capturedEntry) => {
      captured.push(capturedEntry);
      try {
        assertCurrent();
        const entry = capturedEntry.entry;
        if (depth > 0 && entry.lifecycleRevision !== expectedLifecycle) {
          refuse();
        }
        if (target.sessionKey === ancestor.sessionKey) {
          if (entry.sessionId !== ancestor.sessionId) {
            refuse();
          }
          const value = await run({ ...descendant, agentId: agentFor(descendant), assertCurrent });
          assertCurrent();
          return value;
        }
        if (
          !entry.spawnedBy ||
          !entry.spawnedBySessionId ||
          typeof entry.spawnedBySenderIsOwner !== "boolean" ||
          (entry.parentSessionKey !== undefined && entry.parentSessionKey !== entry.spawnedBy) ||
          (entry.parentSessionId !== undefined &&
            entry.parentSessionId !== entry.spawnedBySessionId) ||
          entry.parentSessionLifecycleRevision === ""
        ) {
          refuse();
        }
        return await visit(
          { sessionKey: entry.spawnedBy, sessionId: entry.spawnedBySessionId },
          depth + 1,
          entry.parentSessionLifecycleRevision,
        );
      } finally {
        captured.pop();
      }
    });
  };
  try {
    return await visit(descendant, 0);
  } finally {
    active = false;
  }
}

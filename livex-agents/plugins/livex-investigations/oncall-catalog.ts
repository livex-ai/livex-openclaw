import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveInvestigationCatalogPath } from "./config.js";
import {
  hasCompleteSignature,
  normalizeSignature,
  signatureKey,
  type CatalogSnapshot,
  type HistoryScope,
  type IssueSignature,
} from "./schema.js";
import { readCatalog } from "./store.js";

export type OncallSignature = Omit<IssueSignature, "scope">;
export type OncallCatalogMatch = {
  classification: "known" | "unknown" | "unclassified";
  issueId?: string;
  canonicalUrl?: string;
  reason?: string;
};

function catalogEnabled(config: OpenClawConfig) {
  return resolveEffectiveEnableState({
    id: "livex-investigations",
    origin: "config",
    config: normalizePluginsConfig(config.plugins),
    rootConfig: config,
  }).enabled;
}

function match(snapshot: CatalogSnapshot, signature: IssueSignature): OncallCatalogMatch {
  if (
    snapshot.status !== "ready" ||
    !hasCompleteSignature(signature) ||
    !signature.resource?.trim() ||
    /^(?:unknown|unspecified|n\/a|none)$/i.test(signature.resource)
  ) {
    return { classification: "unclassified", reason: "Case history or signature is incomplete" };
  }
  const exact = snapshot.issues.filter(
    (issue) => signatureKey(issue.signature) === signatureKey(signature),
  );
  if (exact.length > 1) {
    return { classification: "unclassified", reason: "Multiple saved cases match" };
  }
  const issue = exact[0];
  if (issue) {
    return { classification: "known", issueId: issue.issueId, canonicalUrl: issue.slackThreads[0] };
  }
  const error = normalizeSignature(signature).error;
  if (snapshot.issues.some((item) => normalizeSignature(item.signature).error === error)) {
    return { classification: "unclassified", reason: "Similar failure has conflicting case scope" };
  }
  return { classification: "unknown" };
}

/** The owning plugin resolves the file. The caller supplies no path or per-query scope. */
export function createOncallCatalogReader(params: {
  config: OpenClawConfig;
  scope: HistoryScope;
  assertCurrent(): void;
}) {
  const scope = Object.freeze({ ...params.scope });
  const enabled = catalogEnabled(params.config);
  const selectedPath = resolveInvestigationCatalogPath(params.config, scope.agentId);
  const filePath = enabled ? selectedPath : null;
  const sourceIdentity = createHash("sha256")
    .update(
      JSON.stringify([
        enabled,
        selectedPath,
        scope.agentId,
        scope.accountId,
        scope.teamId,
        scope.channelId,
        scope.senderId,
      ]),
    )
    .digest("hex");
  return {
    sourceIdentity,
    async lookup(signatures: readonly OncallSignature[]): Promise<OncallCatalogMatch[]> {
      params.assertCurrent();
      if (!filePath || signatures.length > 20) {
        return signatures.map(() => ({
          classification: "unclassified",
          reason: "Case source unavailable",
        }));
      }
      const snapshot = await readCatalog({ filePath, scope });
      params.assertCurrent();
      return signatures.map((signature) => match(snapshot, { ...signature, scope }));
    },
  };
}

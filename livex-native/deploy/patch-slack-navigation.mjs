// Backport livex-openclaw PR #34 to the verified @openclaw/slack@2026.10.5 package.
// Remove this patch when the pinned Slack package handles passive URL buttons.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertIdentifiersBound } from "./assert-bound-identifiers.mjs";

const [packageDir] = process.argv.slice(2);
const bundle = path.join(packageDir, "dist/.setup/monitor-CNECe8FK.mjs");
const source = fs.readFileSync(bundle, "utf8");
const stockDigest = "ef2452d5219c75b3f14a940b62022d1e97bf473bd27bed6c5c7a292236f0b929";
if (createHash("sha256").update(source).digest("hex") !== stockDigest) {
  throw new Error("Unexpected Slack monitor bundle for PR #34 backport");
}
assertIdentifiersBound(source);

const helper = `function isSlackNavigationButton(parsed) {
  if (parsed.actionSummary.actionType !== "button") return false;
  if (normalizeOptionalString(parsed.typedAction.url)) return true;
  const blocks = parsed.typedBody.message?.blocks;
  if (!parsed.blockId || !Array.isArray(blocks)) return false;
  return blocks.some((candidate) => {
    const block = asOptionalRecord(candidate);
    if (block?.block_id !== parsed.blockId) return false;
    const elements =
      block.type === "actions" && Array.isArray(block.elements)
        ? block.elements
        : block.type === "section"
          ? [block.accessory]
          : [];
    return elements.some((elementCandidate) => {
      const element = asOptionalRecord(elementCandidate);
      return element?.type === "button" &&
        element.action_id === parsed.actionId &&
        Boolean(normalizeOptionalString(element.url));
    });
  });
}

`;
const register = "function registerSlackBlockActionHandler(params) {";
const enqueue = "\t\tenqueueSlackBlockActionEvent({";
const guard = [
  "\t\tif (isSlackNavigationButton(parsed)) {",
  '\t\t\truntimeContext.runtime.log?.(`[slack] navigation action=${parsed.actionId} channel=${parsed.channelId ?? "unknown"}`);',
  "\t\t\treturn;",
  "\t\t}",
  enqueue,
].join("\n");
if (source.split(register).length !== 2 || source.split(enqueue).length !== 2) {
  throw new Error("Slack navigation backport anchors are missing or ambiguous");
}
const patched = source.replace(register, helper + register).replace(enqueue, guard);
fs.writeFileSync(bundle, patched);

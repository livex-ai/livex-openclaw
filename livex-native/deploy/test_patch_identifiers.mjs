import assert from "node:assert/strict";
import { test } from "node:test";
import { assertIdentifiersBound } from "./assert-bound-identifiers.mjs";

const bound = `import { n as normalizeOptionalString, r as asOptionalRecord } from "./x.js";
function registerSlackBlockActionHandler(params) {
  const { runtimeContext } = params;
}`;

test("accepts a bundle that binds every identifier the patch injects", () => {
  assertIdentifiersBound(bound);
  assertIdentifiersBound("function normalizeOptionalString(v){}\nfunction asOptionalRecord(v){}\nconst runtimeContext = 1;");
});

test("fails with a clear message when an identifier is not bound", () => {
  assert.throws(() => assertIdentifiersBound(bound.replace("asOptionalRecord", "other")), /does not bind asOptionalRecord/u);
  assert.throws(() => assertIdentifiersBound("normalizeOptionalString(x); asOptionalRecord(y); runtimeContext.z"), /normalizeOptionalString, asOptionalRecord, runtimeContext/u);
});

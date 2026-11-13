// Shared by patch-slack-navigation.mjs (build time) and its test.
// The sha256 pin makes the Slack bundle exact, but `node --check` cannot see an
// unbound name. The injected code uses these as free identifiers, so require a
// function/const/let/var/class declaration, an import alias, or a parameter or
// destructured binding for each in the source text.
export const REQUIRED_IDENTIFIERS = ["normalizeOptionalString", "asOptionalRecord", "runtimeContext"];

export function assertIdentifiersBound(source, names = REQUIRED_IDENTIFIERS) {
  const missing = names.filter((name) => {
    const declared = new RegExp(
      [
        `\\bfunction\\s+${name}\\b`,
        `\\b(?:const|let|var|class)\\s+${name}\\b`,
        `\\bas\\s+${name}\\b`,
        `[{,(]\\s*${name}\\s*[,})=:]`,
      ].join("|"),
      "u",
    );
    return !declared.test(source);
  });
  if (missing.length > 0) {
    throw new Error(
      `Slack monitor bundle does not bind ${missing.join(", ")}; the PR #34 backport would reference undefined names. Re-verify patch-slack-navigation.mjs against this bundle.`,
    );
  }
}

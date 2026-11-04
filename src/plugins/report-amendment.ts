import type { ReportAmendment } from "./reply-turn.types.js";

const priorities = ["Unknown", "Low", "Medium", "High", "Critical"] as const;

/** Validate model-proposed values against the current authenticated request.
 * This never routes a turn. Ambiguous spans require clarification before a write. */
export function assertReportAmendmentAuthorized(text: string, changes: ReportAmendment) {
  const invalid = () => {
    throw new Error(
      "Clarify the requested fields, values and ownership in a direct affirmative reply",
    );
  };
  if (
    !changes ||
    typeof changes !== "object" ||
    !Object.keys(changes).length ||
    Object.keys(changes).some((k) => !["priority", "nextAction", "acceptOwnership"].includes(k)) ||
    (changes.priority !== undefined && !priorities.includes(changes.priority)) ||
    (changes.acceptOwnership !== undefined && changes.acceptOwnership !== true)
  )
    invalid();
  const action = changes.nextAction;
  // Remove the exact action value before handling conjunctions: conditions such as
  // “only after approval” belong to the action and must survive in their entirety.
  if (
    action !== undefined &&
    (typeof action !== "string" ||
      !action.trim() ||
      action.length > 2000 ||
      /[\p{Cc}\p{Cf}*`~<>]| · Owners?:/u.test(action) ||
      action.includes("§"))
  )
    invalid();
  let input = text.trim().replaceAll("’", "'");
  if (/[?`"“”\r\n<>§]/u.test(input) || input.length > 2000) invalid();
  if (action !== undefined) {
    const at = input.indexOf(action);
    if (at < 0 || at !== input.lastIndexOf(action)) invalid();
    input = input.slice(0, at) + "§" + input.slice(at + action.length);
  }
  const clauses = input.replace(/[.!]$/, "").split(/\s*(?:;|\.\s+|,\s*(?:and\s+)?|\band\b)\s*/i);
  const seen = new Set<string>();
  for (const raw of clauses) {
    const clause = raw.trim().replace(/^please\s+/i, "");
    // Check the complete directive, including its destination. A mention of the old
    // priority, a third-party assignment or a quoted instruction cannot attest a value.
    const p =
      /^(?:(?:set|change|update|raise|lower|bump|move) (?:the )?priority(?: from (?:low|medium|high|unknown|critical))? to |(?:make|mark) (?:this|it) |(?:set|change|update) (?:the )?(?:above one|above report|this report|report) to )(unknown|low|medium|high|critical)(?: priority)?$/i.exec(
        clause,
      )?.[1];
    let field: keyof ReportAmendment;
    if (p && changes.priority?.toLowerCase() === p.toLowerCase()) field = "priority";
    else if (
      changes.acceptOwnership &&
      /^(?:i(?:'ll| will) (?:own|take) (?:this|it)|assign (?:it |this )?to me|(?:make|set) me (?:the )?owner|i accept ownership)$/i.test(
        clause,
      )
    )
      field = "acceptOwnership";
    else if (
      action !== undefined &&
      /^(?:(?:set|change|update) (?:the )?next (?:action|step) to |next (?:action|step):\s*)§$/i.test(
        clause,
      )
    )
      field = "nextAction";
    else return invalid();
    if (seen.has(field)) invalid();
    seen.add(field);
  }
  if (seen.size !== Object.keys(changes).length) invalid();
}

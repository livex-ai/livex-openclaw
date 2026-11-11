import type { ReportAmendment } from "openclaw/plugin-sdk/reply-turns";

const priorities = ["Unknown", "Low", "Medium", "High", "Critical"] as const;

function invalid(): never {
  throw new Error(
    "Clarify the requested fields, values and ownership in a direct affirmative reply",
  );
}

function validateChanges(changes: ReportAmendment) {
  if (
    !changes ||
    typeof changes !== "object" ||
    !Object.keys(changes).length ||
    Object.keys(changes).some((k) => !["priority", "nextAction", "acceptOwnership"].includes(k)) ||
    (changes.priority !== undefined && !priorities.includes(changes.priority)) ||
    (changes.acceptOwnership !== undefined && changes.acceptOwnership !== true)
  ) {
    invalid();
  }
}

function validateAction(action: string | undefined) {
  if (
    action !== undefined &&
    (typeof action !== "string" ||
      !action.trim() ||
      action.length > 2000 ||
      /[\p{Cc}\p{Cf}*`~<>]| · Owners?:/u.test(action) ||
      action.includes("§"))
  ) {
    invalid();
  }
}

function normalizeInstruction(text: string, action: string | undefined): string {
  const input = text.trim().replaceAll("’", "'");
  if (/[?`"“”\r\n<>§]/u.test(input) || input.length > 2000) {
    invalid();
  }
  if (action === undefined) {
    return input;
  }
  // Remove the exact action value before handling conjunctions so conditions
  // such as “only after approval” survive in their entirety.
  const at = input.indexOf(action);
  if (at < 0 || at !== input.lastIndexOf(action)) {
    invalid();
  }
  return input.slice(0, at) + "§" + input.slice(at + action.length);
}

function authorizedField(clause: string, changes: ReportAmendment): keyof ReportAmendment {
  // Check the complete directive, including its destination. A mention of the old
  // priority, a third-party assignment or a quoted instruction cannot attest a value.
  const priority =
    /^(?:(?:set|change|update|raise|lower|bump|move) (?:the )?priority(?: from (?:low|medium|high|unknown|critical))? to |(?:make|mark) (?:this|it) |(?:set|change|update) (?:the )?(?:above one|above report|this report|report) to )(unknown|low|medium|high|critical)(?: priority)?$/i.exec(
      clause,
    )?.[1];
  if (priority && changes.priority?.toLowerCase() === priority.toLowerCase()) {
    return "priority";
  }
  if (
    changes.acceptOwnership &&
    /^(?:i(?:'ll| will) (?:own|take) (?:this|it)|assign (?:it |this )?to me|(?:make|set) me (?:the )?owner|i accept ownership)$/i.test(
      clause,
    )
  ) {
    return "acceptOwnership";
  }
  if (
    changes.nextAction !== undefined &&
    /^(?:(?:set|change|update) (?:the )?next (?:action|step) to |next (?:action|step):\s*)§$/i.test(
      clause,
    )
  ) {
    return "nextAction";
  }
  return invalid();
}

/** Ambiguous spans in the current authenticated request require clarification before a write. */
export function assertReportAmendmentAuthorized(text: string, changes: ReportAmendment) {
  validateChanges(changes);
  validateAction(changes.nextAction);
  const input = normalizeInstruction(text, changes.nextAction);
  const clauses = input.replace(/[.!]$/, "").split(/\s*(?:;|\.\s+|,\s*(?:and\s+)?|\band\b)\s*/i);
  const seen = new Set<keyof ReportAmendment>();
  for (const raw of clauses) {
    const clause = raw.trim().replace(/^please\s+/i, "");
    const field = authorizedField(clause, changes);
    if (seen.has(field)) {
      invalid();
    }
    seen.add(field);
  }
  if (seen.size !== Object.keys(changes).length) {
    invalid();
  }
}

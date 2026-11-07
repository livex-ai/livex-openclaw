import type { Roster } from "./types.js";

type Member = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string };
};
const LABEL =
  /(?<![@\w])[*_`]*P([12])[*_`]*\s*[*_`]*(?:[:=]|\|)[*_`]*\s*(.+?)\s*\|?\s*(?=$|[*_`|\s]*(?<![@\w])P[12][*_`]*\s*[*_`]*(?:[:=]|\|))/gim;

export function canvasText(body: string) {
  return body
    .replace(/<@([UW][A-Z0-9]+)>/g, "@$1")
    .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => table.replace(/<\/?p\b[^>]*>/gi, " "))
    .replace(/<br\s*\/?\s*>|<\/(?:p|tr|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(?:amp|lt|gt|quot|#39|nbsp);/g,
      (entity) =>
        ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " })[
          entity
        ]!,
    )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n");
}

export function rotationReferences(body: string) {
  const references: { p1?: string; p2?: string } = {};
  for (const match of canvasText(body).matchAll(LABEL)) {
    const slot = `p${match[1]}` as "p1" | "p2";
    const value = match[2]!.replace(/^[|*_`\s]+|[|*_`\s]+$/g, "");
    if (!references[slot] && value && !/^(?:tbd|none|unassigned|-|n\/a)$/i.test(value)) {
      references[slot] = value;
    }
  }
  return references;
}

function memberMatches(member: Member, name: string) {
  const forms = [
    member.name,
    member.real_name,
    member.profile?.display_name,
    member.profile?.real_name,
  ];
  return (
    !member.deleted && !member.is_bot && forms.some((value) => value?.trim().toLowerCase() === name)
  );
}

export function resolveRoster(body: string, members: Member[]): Roster {
  const references = rotationReferences(body);
  const result: Roster = {};
  for (const slot of ["p1", "p2"] as const) {
    const reference = references[slot];
    if (reference) {
      result[slot] = resolveMember(reference, members);
    }
  }
  if (!result.p1 || !result.p2) {
    result.error = "The rotation has an unresolved P1 or P2 slot";
  }
  return result;
}

function resolveMember(reference: string, members: Member[]) {
  const direct = /^<?@?([UW][A-Z0-9]{6,})>?$/.exec(reference);
  if (direct) {
    return direct[1];
  }
  const name = reference.replace(/^@/, "").trim().toLowerCase();
  const matches = members.filter((member) => memberMatches(member, name));
  return matches.length === 1 ? matches[0]!.id : undefined;
}

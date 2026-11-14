// Card validation, rendering, priority controls and the amendment guard for the
// LiveX Debugger Slack summary card. No host, network or Slack access here: the
// entry (index.ts) wires these functions to the plugin hooks.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { DEFAULT_POLICY, computePriority } from "./priority.mjs";

export const SUMMARY_MARKER = "LIVEX_ALERT_SUMMARY_V3";
// Any versioned marker identifies an envelope; only the current version is accepted.
const MARKER_PATTERN = "LIVEX_ALERT_SUMMARY_V[0-9]+";
export const INTERACTIVE_NAMESPACE = "livex-priority";
export const FULL_EVIDENCE_HINT = "Mention this bot in the thread for full evidence.";
export const INVALID_SUMMARY = `Could not format the investigation summary. ${FULL_EVIDENCE_HINT}`;

const MARKED_LINE = new RegExp(`(?:^|\\n)[ \\t]*${MARKER_PATTERN}[ \\t]*(?=\\r?\\n|$)`, "u");
// Longest evidence link the card keeps, measured after `&` is escaped to `&amp;`. A longer link is
// dropped (the card still posts). Must equal MAX_CARD_EVIDENCE_URL in ../livex-gcp-readonly/core.mjs,
// which omits a longer logsExplorerUrl (logsExplorerLinkUnavailableReason "url-too-long").
const MAX_EVIDENCE_URL = 1600;
// The shipped evidence tool only produces Logs Explorer links on this host. The
// model writes the URL, so anything else (including lookalikes) is dropped.
const EVIDENCE_HOSTS = ["console.cloud.google.com"];
const EVIDENCE_PATH = "/logs/query";
// `agent:debugger:slack:channel:<id>:thread:<ts>`, or with the team-qualified peer
// `channel:team:<team>:channel:<id>` that Slack workspace routing produces.
const DEBUGGER_SLACK_THREAD =
  /^agent:debugger:slack:channel:(?:team:[a-z0-9%._-]+:channel:)?([cg][a-z0-9]+):thread:(\d+\.\d+)$/u;
const SLACK_TS = /^\d{9,12}\.\d{3,9}$/u;
const SENDER_ID = /^[UW][A-Z0-9]+$/u;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const CHANNEL_GATE = /^(?:\*|[CG][A-Z0-9]+)$/u;

const PRIORITY_LABELS = new Map([
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
]);
// Lowest first: the rank of a computed priority.
const PRIORITY_ORDER = ["low", "medium", "high"];
// The leading emoji of the Priority line (the colour bar is the attachment colour below).
const PRIORITY_MARKERS = new Map([
  ["high", "\u{1F534}"],
  ["medium", "\u{1F7E1}"],
  ["low", "⚪"],
]);
const RESOLVED_MARKER = "\u{1F7E2}";
// Attachment colour bar, mirroring PR #1 (livex-agents/plugins/livex-oncall-reports/style.ts).
// Verified resolution outranks the displayed priority.
const REPORT_COLORS = { high: "#D92D20", medium: "#D99A00", resolved: "#2E8B57", default: "#9CA3AF" };
// The facts the model reports; the plugin computes the priority from them (priority.mjs).
const FACT_KEYS = [
  "alertClass",
  "service",
  "alertSeverity",
  "sustained",
  "known",
  "sampleChecked",
  "sampleAffected",
  "scope",
  "traffic",
  "clientEffectVerified",
];
const REQUIRED_KEYS = [
  "title",
  "signature",
  ...FACT_KEYS,
  "summary",
  "nextAction",
  "owner",
  "checkedWindow",
];
const ALLOWED_KEYS = new Set([...REQUIRED_KEYS, "knownRef", "resolved", "evidenceUrl", "alternates"]);
// An alternate is another fact set from the same reply (a digest with several categories).
const ALTERNATE_KEYS = new Set(["title", ...FACT_KEYS, "knownRef"]);
const MAX_ALTERNATES = 4;
const SLUG = /^[a-z][a-z0-9-]{1,59}$/u;
const MAX_SAMPLE = 500;
// Longest Why and Also line, counted after neutralize.
const MAX_DERIVED_LINE = 300;
// Longest attachment fallback text the Slack patch sanitizer accepts.
const MAX_FALLBACK = 4000;

// Buttons a human may press. High/Medium/Low reset the priority, Resolved closes it.
const CHOICES = new Map([
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
  ["resolved", "Resolved"],
]);
// Slack's button value limit is 2000 characters (extensions/slack/src/presentation.ts:6).
// Leave room for the namespace and choice prefix.
const MAX_TOKEN_CHARS = 1900;
const MAX_STATE_BYTES = 8192;

// ----------------------------------------------------------------- validation

function isBoundedLine(value, maxLength) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

/**
 * A link that opens the cited log entry or time slice, not a generic Logs Explorer
 * query: the `query` parameter must pin an entry (`insertId=`) or bound a time range
 * (`timestamp>=` and `timestamp<=`).
 */
function isVerifiedEvidenceLink(url, project) {
  if (!EVIDENCE_HOSTS.includes(url.hostname) || url.port !== "" || url.pathname !== EVIDENCE_PATH) {
    return false;
  }
  if (project !== undefined && url.searchParams.get("project") !== project) {
    return false;
  }
  const query = url.searchParams.get("query") ?? "";
  return query.includes("insertId=") || (query.includes("timestamp>=") && query.includes("timestamp<="));
}

/**
 * Returns undefined only when the value is not a string or null (a malformed envelope), null when
 * the link is dropped (over-long, malformed, unverified; the card still posts), or the normalized
 * href. The href is stored unescaped; rendering escapes `&`.
 * The shape check is substring-based and therefore forgeable by model text, so a session
 * passes `isRecorded`: the link is kept only when it exactly equals a URL the evidence tool
 * returned in this session (see afterToolCall). `project`, when given, must match too.
 */
export function readEvidenceHref(value, { isRecorded, project } = {}) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  if (
    value.length > MAX_EVIDENCE_URL ||
    !value.startsWith("https://") ||
    /[\s\p{Cc}<>|\\]/u.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.href.replaceAll("&", "&amp;").length > MAX_EVIDENCE_URL ||
      !isVerifiedEvidenceLink(url, project)
    ) {
      return null;
    }
    // Compared in canonical form: the same URL spelled with an explicit default port is the same link.
    if (isRecorded && !isRecorded(url.href)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/** Name of the first invalid card field, or undefined when the card is valid. */
function invalidCardField(card) {
  const checks = [
    ["priority", PRIORITY_LABELS.has(card.priority)],
    ["why", isBoundedLine(card.why, 1000)],
    [
      "also",
      Array.isArray(card.also) &&
        card.also.length <= MAX_ALTERNATES &&
        card.also.every(
          (item) =>
            item !== null &&
            typeof item === "object" &&
            isBoundedLine(item.title, 120) &&
            PRIORITY_LABELS.has(item.priority),
        ),
    ],
    ["resolved", typeof card.resolved === "boolean"],
    ["title", isBoundedLine(card.title, 120)],
    ["summary", isBoundedLine(card.summary, 600)],
    ["nextAction", isBoundedLine(card.nextAction, 300)],
    ["owner", isBoundedLine(card.owner, 80)],
    ["checkedWindow", isBoundedLine(card.checkedWindow, 80)],
    [
      "evidenceUrl",
      card.evidenceHref === null ||
        (typeof card.evidenceHref === "string" &&
          readEvidenceHref(card.evidenceHref) === card.evidenceHref),
    ],
  ];
  return checks.find(([, ok]) => !ok)?.[0];
}

const validCard = (card) => invalidCardField(card) === undefined;

const isSampleCount = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;

/** Name of the first invalid fact in `value`, or undefined when all facts are valid. */
function invalidFactField(value) {
  const checks = [
    ["alertClass", typeof value.alertClass === "string" && SLUG.test(value.alertClass)],
    ["service", typeof value.service === "string" && SLUG.test(value.service)],
    ["alertSeverity", ["error", "warning", "info"].includes(value.alertSeverity)],
    ["sustained", typeof value.sustained === "boolean"],
    ["known", ["no", "ongoing", "fixed", "harmless"].includes(value.known)],
    ["sampleChecked", isSampleCount(value.sampleChecked, MAX_SAMPLE)],
    ["sampleAffected", isSampleCount(value.sampleAffected, value.sampleChecked)],
    ["scope", ["single", "multiple", "unknown"].includes(value.scope)],
    ["traffic", ["live", "test", "unknown"].includes(value.traffic)],
    ["clientEffectVerified", typeof value.clientEffectVerified === "boolean"],
    ["knownRef", value.knownRef === undefined || isBoundedLine(value.knownRef, 200)],
  ];
  return checks.find(([, ok]) => !ok)?.[0];
}

/** The fact keys of a validated envelope or alternate (knownRef only when present). */
function factsFrom(value) {
  const facts = Object.fromEntries(FACT_KEYS.map((key) => [key, value[key]]));
  return value.knownRef === undefined ? facts : { ...facts, knownRef: value.knownRef };
}

/** True when `alternates` is absent or a list of valid `{ title, ...facts, knownRef? }` objects. */
function validAlternates(alternates) {
  if (alternates === undefined) {
    return true;
  }
  return (
    Array.isArray(alternates) &&
    alternates.length <= MAX_ALTERNATES &&
    alternates.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        Object.keys(item).every((key) => ALTERNATE_KEYS.has(key)) &&
        FACT_KEYS.every((key) => key in item) &&
        isBoundedLine(item.title, 120) &&
        invalidFactField(item) === undefined,
    )
  );
}

/** The facts part of the Why line (before neutralize): client effect, known state and the alert. */
function factsLine(facts, rating, reads, policy) {
  const checked = facts.sampleChecked;
  const affected = facts.sampleAffected;
  const why = reads?.degraded
    ? ", a read was capped or failed"
    : rating.fewOutcomes
      ? `, fewer than ${policy.minSample} outcome reads`
      : "";
  const effect =
    rating.clientEffect === "yes"
      ? `clients affected (${affected} of ${checked} sampled)`
      : rating.clientEffect === "no"
        ? `no client effect found (${checked} sampled)`
        : `client effect not verified (${affected} of ${checked} sampled${why})`;
  // rating.known is "no" unless the reference was accepted (validKnownRef), so knownRef is set.
  const known = rating.known === "no" ? "no" : `${rating.known} (${facts.knownRef})`;
  return `${effect} · known: ${known} · alert: ${facts.alertSeverity}${facts.sustained ? ", recurring" : ""}`;
}

/** The policy notes of a rating (fixed strings), so a discounted or raised level is visible. */
const notesOf = (rating) => rating.notes.join("; ");

/** Cut to `max` characters, never inside a surrogate pair. */
function cutText(text, max) {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut;
}

// Longest stored Why text (card validation allows 1000); the rendered line is cut to 300.
const MAX_WHY = 1000;

const DEFAULT_READS = Object.freeze({ ok: 0, degraded: false, outcomes: 0 });

/**
 * Parse the envelope into `{ card }` or `{ reason }`; the reason is a fixed code, never content.
 * The priority is computed from the facts with `rating.policy` and `rating.reads`.
 */
function parseSummary(text, evidenceOptions, rating) {
  // Read only the compact JSON line. Evidence belongs to the native assistant
  // transcript and must never be copied into the replacement Slack payload.
  const envelope = /^\S+\r?\n([^\r\n]{1,4096})\r?\n\r?\n(?=\s*\S)/u.exec(text);
  const json = envelope?.[1];
  if (!json) {
    return { reason: "bad layout" };
  }
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return { reason: "bad json" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "bad json" };
  }
  const { title, signature, summary, nextAction, owner, checkedWindow, evidenceUrl, resolved, alternates } = value;
  if (!Object.keys(value).every((key) => ALLOWED_KEYS.has(key))) {
    return { reason: "unknown key" };
  }
  const missing = REQUIRED_KEYS.find((key) => !(key in value));
  if (missing) {
    return { reason: `missing field ${missing}` };
  }
  // evidenceUrl is optional: absent and null both mean "no link"; a string that cannot be
  // verified (too long, wrong host, unrecorded) is dropped, only a non-string is malformed.
  const href = evidenceUrl === undefined ? null : readEvidenceHref(evidenceUrl, evidenceOptions);
  if (href === undefined) {
    return { reason: "invalid field evidenceUrl" };
  }
  if (!isBoundedLine(signature, 160)) {
    return { reason: "invalid field signature" };
  }
  if (resolved !== undefined && typeof resolved !== "boolean") {
    return { reason: "invalid field resolved" };
  }
  if (!isBoundedLine(title, 120)) {
    return { reason: "invalid field title" };
  }
  const invalidFact = invalidFactField(value);
  if (invalidFact) {
    return { reason: `invalid field ${invalidFact}` };
  }
  if (!validAlternates(alternates)) {
    return { reason: "invalid field alternates" };
  }
  // Rate every fact set. The card keeps the main title and facts; its priority is the highest
  // rating (a tie keeps the main one), and an alternate that set it is named on the Why line.
  const policy = rating?.policy ?? DEFAULT_POLICY;
  const reads = rating?.reads ?? DEFAULT_READS;
  const [main, ...others] = [value, ...(alternates ?? [])].map((item) => {
    const facts = factsFrom(item);
    return { title: item.title, facts, rating: computePriority(facts, policy, reads) };
  });
  let setter = main;
  for (const entry of others) {
    if (PRIORITY_ORDER.indexOf(entry.rating.priority) > PRIORITY_ORDER.indexOf(setter.rating.priority)) {
      setter = entry;
    }
  }
  const mainLine = factsLine(main.facts, main.rating, reads, policy);
  const why =
    setter === main
      ? `${mainLine} · ${notesOf(main.rating)}`
      : `${mainLine} · rated by: ${setter.title} · ${notesOf(setter.rating)}`;
  const card = {
    title: main.title,
    signature,
    priority: setter.rating.priority,
    rating: setter.rating,
    why: cutText(why, MAX_WHY),
    also: others.map((entry) => ({ title: entry.title, priority: entry.rating.priority })),
    resolved: resolved === true,
    summary,
    nextAction,
    owner,
    checkedWindow,
    evidenceHref: href,
  };
  const invalid = invalidCardField(card);
  return invalid ? { reason: `invalid field ${invalid}` } : { card };
}

/** Parse the `MARKER\n{json}\n\nfull report` envelope into a validated card. */
export function readSummary(text, evidenceOptions, rating) {
  return parseSummary(text, evidenceOptions, rating).card;
}

/**
 * `{ marked, card, reason }`: marked when the text carries a marker line; `card` only for a
 * canonical, valid envelope. `rating` is `{ policy, reads }` (default policy, no reads).
 */
export function classifyEnvelope(rawText, evidenceOptions, rating) {
  const text = typeof rawText === "string" ? rawText.trimStart() : "";
  if (!text || !MARKED_LINE.test(text)) {
    return { marked: false };
  }
  // A misplaced marker still identifies an envelope. Fail closed instead
  // of passing the JSON and retained evidence through as an ordinary reply.
  const canonical = text.split(/\r?\n/u, 1)[0] === SUMMARY_MARKER;
  if (!canonical) {
    return { marked: true, card: undefined, reason: "bad layout" };
  }
  const { card, reason } = parseSummary(text, evidenceOptions, rating);
  return { marked: true, card, reason };
}

// ------------------------------------------------------------------ rendering

const ZWJ = "‍";

/**
 * Model text for Slack mrkdwn: entity-escaped, then every character Slack would act
 * on (`://` auto-links, `@` and `#` mentions, emphasis, code) is split with a
 * zero-width joiner. The evidence link is the only live link and comes from the
 * allowlisted evidence field alone.
 */
function neutralize(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("://", `:${ZWJ}//`)
    .replace(/[@#*_~`]/gu, (char) => `${char}${ZWJ}`);
}

function priorityText(card) {
  return PRIORITY_LABELS.get(card.priority);
}

/** Model-derived text for one line: neutralized, then cut (never inside a surrogate pair). */
function derivedLine(text) {
  return cutText(neutralize(text), MAX_DERIVED_LINE);
}

/** The context line naming the fact sets that did not become the card, or undefined. */
function alsoLine(card) {
  return card.also.length
    ? derivedLine(`Also: ${card.also.map((item) => `${item.title} — ${PRIORITY_LABELS.get(item.priority)}`).join("; ")}`)
    : undefined;
}

function markerOf(card) {
  return card.resolved ? RESOLVED_MARKER : PRIORITY_MARKERS.get(card.priority);
}

/** Fallback text of the message: the marker emoji and the title. */
export function headlineOf(card) {
  return `${markerOf(card)} ${neutralize(card.title)}`;
}

function priorityLine(card) {
  return card.resolved
    ? `*Priority:* ${RESOLVED_MARKER} Resolved · was ${priorityText(card)}`
    : `*Priority:* ${markerOf(card)} ${priorityText(card)}`;
}

function evidenceLine(card) {
  const link = card.evidenceHref
    ? `<${card.evidenceHref.replaceAll("&", "&amp;")}|Logs>`
    : "No verified evidence link";
  return `*Evidence:* ${link} · Checked window: ${neutralize(card.checkedWindow)}`;
}

/** The card's mrkdwn sections in display order (shared by the blocks and the presentation). */
function sectionTexts(card) {
  return [
    `*Title:* ${neutralize(card.title)}`,
    priorityLine(card),
    `*Why:* ${derivedLine(card.why)}`,
    `*Next action:* ${neutralize(card.nextAction)} (Owner: ${neutralize(card.owner)})`,
    `*Summary:* ${neutralize(card.summary)}`,
    evidenceLine(card),
  ];
}

function plainText(text) {
  return { type: "plain_text", text };
}

function section(text) {
  return { type: "section", text: { type: "mrkdwn", text, verbatim: true } };
}

/** What a button press does to a card. */
export function applyChoice(card, choice) {
  if (choice === "resolved") {
    return { ...card, resolved: true };
  }
  // A human reset reopens a resolved card.
  return { ...card, priority: choice, resolved: false };
}

/** The buttons a card offers, omitting a no-op for the card's current state. */
export function availableChoices(card) {
  const choices = [];
  for (const choice of ["high", "medium", "low"]) {
    if (!card.resolved && card.priority === choice) {
      continue;
    }
    choices.push(choice);
  }
  if (!card.resolved) {
    choices.push("resolved");
  }
  return choices;
}

function buttonValue(choice, token) {
  return `${INTERACTIVE_NAMESPACE}:${choice}:${token}`;
}

/** The attachment colour bar: resolved, then priority (PR #1 compactReportColor). */
export function colorOf(card) {
  if (card.resolved) {
    return REPORT_COLORS.resolved;
  }
  if (card.priority === "high") {
    return REPORT_COLORS.high;
  }
  return card.priority === "medium" ? REPORT_COLORS.medium : REPORT_COLORS.default;
}

/**
 * The card in the shape of PR #1: the Title (and the buttons, so they are always
 * visible) in top-level `blocks`; Priority, Next action, Summary, Evidence and the
 * hint in one coloured attachment. Sent as `channelData.slack.blocks` and
 * `channelData.slack.attachments`, which needs patch-slack-attachments.mjs.
 */
export function renderBlocks(card, controls) {
  const [title, ...rest] = sectionTexts(card);
  const also = alsoLine(card);
  const blocks = [section(title)];
  if (controls?.length) {
    blocks.push({
      type: "actions",
      block_id: "openclaw_reply_buttons_1",
      // Same ids the stock presentation renderer emits for callback buttons
      // (extensions/slack/src/blocks-render.ts:376), so a card edited through the
      // message tool presents identical controls.
      elements: controls.map((control, index) => ({
        type: "button",
        action_id: `openclaw:callback_button:1:${index + 1}`,
        text: plainText(control.label),
        value: control.value,
        ...(control.choice === "resolved" ? { style: "primary" } : {}),
      })),
    });
  }
  return {
    blocks,
    attachments: [
      {
        color: colorOf(card),
        // Plain text: the only live link is the Evidence section's.
        // Cut so the Slack patch sanitizer never drops the coloured attachment for its length.
        fallback: cutText(
          [...sectionTexts(card), ...(also ? [also] : [])].join("\n").replace(/<[^>|]*\|([^>]*)>/gu, "$1"),
          MAX_FALLBACK,
        ),
        // Context elements stay plain_text: patch-slack-attachments.mjs accepts nothing else.
        blocks: [
          ...rest.map(section),
          { type: "context", elements: [plainText(FULL_EVIDENCE_HINT)] },
          ...(also ? [{ type: "context", elements: [plainText(also)] }] : []),
        ],
      },
    ],
  };
}

/**
 * The same split as the first post, for a message-tool `edit`. The tool accepts only `message`
 * text and a portable `presentation`, never raw blocks
 * (extensions/slack/src/message-action-dispatch.ts:218-257), so the Title and the buttons go
 * through the stock presentation renderer (top-level blocks) and the coloured part travels as
 * raw `attachments` in the separate `livexAttachments` param, which
 * patch-slack-attachments.mjs forwards to chat.update (the tool's own `attachments` param is
 * the media pipeline). There is no presentation title (it would add a header block). Stock
 * renders a `text` block as a mrkdwn section without `verbatim`, so every model field is
 * neutralized above: no auto-linking, mention parsing or emphasis survives.
 */
export function renderPresentation(card, controls) {
  return {
    presentation: {
      blocks: [
        { type: "text", text: sectionTexts(card)[0] },
        ...(controls?.length
          ? [
              {
                type: "buttons",
                buttons: controls.map((control) => ({
                  label: control.label,
                  action: { type: "callback", value: control.value },
                  ...(control.choice === "resolved" ? { style: "primary" } : {}),
                })),
              },
            ]
          : []),
      ],
    },
    livexAttachments: renderBlocks(card, undefined).attachments,
  };
}

// ------------------------------------------------------- button state (token)

const TAG_BYTES = 16;
const TAG_CHARS = 22; // 16 bytes in unpadded base64url

function tagFor(key, body, bind) {
  return createHmac("sha256", key)
    .update(`${body}\0${bind.channelId}\0${bind.threadTs}`)
    .digest()
    .subarray(0, TAG_BYTES)
    .toString("base64url");
}

/**
 * A token is `i<deflated state>` plus an HMAC tag bound to the card's channel and
 * thread. Returns undefined when it would not fit a button value. The signature is
 * not part of the state: nothing re-renders it.
 */
export function encodeState(card, bind, key) {
  const row = [
    card.priority,
    card.why,
    card.also.map((item) => [item.title, item.priority]),
    card.resolved ? 1 : 0,
    card.title,
    card.summary,
    card.nextAction,
    card.owner,
    card.checkedWindow,
    card.evidenceHref,
  ];
  const body = `i${deflateRawSync(Buffer.from(JSON.stringify(row), "utf8"), { level: 9 }).toString("base64url")}`;
  return body.length + TAG_CHARS <= MAX_TOKEN_CHARS ? `${body}${tagFor(key, body, bind)}` : undefined;
}

/** Fails closed: a token that is unsigned, signed for another channel or thread, or invalid is undefined. */
export function decodeState(token, bind, key) {
  try {
    if (
      typeof token !== "string" ||
      token.length < 2 ||
      token.length > MAX_TOKEN_CHARS ||
      !bind?.channelId ||
      !bind?.threadTs ||
      !Buffer.isBuffer(key)
    ) {
      return undefined;
    }
    if (!/^[A-Za-z0-9_-]+$/u.test(token.slice(1))) {
      return undefined;
    }
    if (token[0] !== "i" || token.length <= TAG_CHARS + 1) {
      return undefined;
    }
    const body = token.slice(0, -TAG_CHARS);
    // Compare the canonical text: 22 base64url characters carry 132 bits for a 128-bit
    // tag, so decoded bytes would accept several spellings of the same tag.
    const given = Buffer.from(token.slice(-TAG_CHARS), "ascii");
    const expected = Buffer.from(tagFor(key, body, bind), "ascii");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return undefined;
    }
    const json = inflateRawSync(Buffer.from(body.slice(1), "base64url"), {
      maxOutputLength: MAX_STATE_BYTES,
    }).toString("utf8");
    const row = JSON.parse(json);
    if (!Array.isArray(row) || row.length !== 10) {
      return undefined;
    }
    const [priority, why, alsoRows, resolved, title, summary, nextAction, owner, checkedWindow, href] =
      row;
    if (![0, 1].includes(resolved) || !Array.isArray(alsoRows) || !alsoRows.every((item) => Array.isArray(item) && item.length === 2)) {
      return undefined;
    }
    // A token minted before the evidence guard may carry a link the guard now drops.
    const evidenceHref = href === null ? null : readEvidenceHref(href);
    if (evidenceHref === undefined) {
      return undefined;
    }
    const card = {
      priority,
      why,
      also: alsoRows.map(([itemTitle, itemPriority]) => ({ title: itemTitle, priority: itemPriority })),
      resolved: resolved === 1,
      title,
      summary,
      nextAction,
      owner,
      checkedWindow,
      evidenceHref,
    };
    return validCard(card) ? card : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ signing key file

const KEY_FILE_CHARS = 43; // 32 bytes in unpadded base64url
const KEY_RACE_WAIT_MS = 250;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The 32-byte key in `text`, or undefined when it is anything but one canonical key. */
function parseKey(text) {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(trimmed) || trimmed.length !== KEY_FILE_CHARS) {
    return undefined;
  }
  const key = Buffer.from(trimmed, "base64url");
  return key.length === 32 && key.toString("base64url") === trimmed ? key : undefined;
}

/**
 * Loads the button signing key from `<stateDir>/plugins/livex-slack-summary/button-key`,
 * creating it on first use. Synchronous, so every plugin instance in the gateway and every
 * restart sees the same key. Returns `{ key }`, or `{ error }` (no key material) when the
 * state dir is missing, the file cannot be created or read, or it is corrupt; a corrupt file
 * is never overwritten.
 */
export function loadSigningKey(stateDir, { raceWaitMs = KEY_RACE_WAIT_MS } = {}) {
  if (typeof stateDir !== "string" || stateDir.trim() === "") {
    return { error: "no state directory resolved" };
  }
  const dir = join(stateDir, "plugins", "livex-slack-summary");
  const path = join(dir, "button-key");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let fd;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    if (fd !== undefined) {
      try {
        const key = randomBytes(32);
        writeSync(fd, key.toString("base64url"));
        fsyncSync(fd);
        closeSync(fd);
        return { key };
      } catch (error) {
        // Never leave a half-written file behind to be mistaken for a corrupt key.
        try {
          closeSync(fd);
        } catch {}
        try {
          unlinkSync(path);
        } catch {}
        throw error;
      }
    }
    // Another instance created the file. Give a concurrent writer time to finish
    // writing; a complete but invalid file is corrupt at once.
    const deadline = Date.now() + raceWaitMs;
    for (;;) {
      const text = readFileSync(path, "utf8");
      const key = parseKey(text);
      if (key) {
        return { key };
      }
      if (text.trim().length >= KEY_FILE_CHARS || Date.now() >= deadline) {
        return { error: "button key file is corrupt (expected 32 bytes); not overwriting it" };
      }
      sleepSync(10);
    }
  } catch (error) {
    return { error: `button key file unavailable (${error?.code ?? "error"})` };
  }
}

// ------------------------------------------------------------------- config

/**
 * Buttons need both gates; without them the card renders without controls
 * (the pre-step-4 behaviour) and no interactive handler is registered.
 */
export function readConfig(raw) {
  const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const senderId =
    typeof record.allowedSenderId === "string" && SENDER_ID.test(record.allowedSenderId)
      ? record.allowedSenderId
      : undefined;
  const channelId =
    typeof record.allowedChannelId === "string" && CHANNEL_GATE.test(record.allowedChannelId)
      ? record.allowedChannelId
      : undefined;
  // Optional: the GCP project the evidence links must belong to (same value as livex-gcp-readonly).
  const gcpProject =
    typeof record.gcpProject === "string" && GCP_PROJECT.test(record.gcpProject)
      ? record.gcpProject
      : undefined;
  // `buttons: false` turns the priority buttons (and their click handler and key file)
  // off even when both gates are set; the guarded amendments do not depend on them.
  const buttonsOff = record.buttons === false;
  return { senderId, channelId, gcpProject, buttons: !buttonsOff && Boolean(senderId && channelId) };
}

function channelAllowed(config, channelId) {
  return config.channelId === "*" || config.channelId === channelId;
}

export function parseSession(sessionKey) {
  const match = typeof sessionKey === "string" ? DEBUGGER_SLACK_THREAD.exec(sessionKey) : null;
  return match ? { channelId: match[1].toUpperCase(), threadTs: match[2] } : undefined;
}

/** Channel id from `C123`, `channel:C123` or `team:T1:channel:C123`; otherwise undefined. */
function readChannelId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^(?:slack:)?(?:team:[A-Za-z0-9%._-]+:)?(?:channel:)?([CG][A-Z0-9]+)$/u.exec(
    value.trim(),
  );
  return match?.[1];
}

function tsAfter(ts, rootTs) {
  const [a, b] = ts.split(".");
  const [c, d] = rootTs.split(".");
  return a.length === c.length
    ? a > c || (a === c && b.padEnd(9, "0") > d.padEnd(9, "0"))
    : a.length > c.length;
}

// ------------------------------------------------------------------ plugin

const PENDING_TTL_MS = 5 * 60_000;
const MAX_PENDING = 8;
const MAX_SESSIONS = 500;
const MAX_CARDS_PER_SESSION = 25;
const MAX_OVERRIDES = 1000;
// Evidence links the log tool returned, per debugger thread session.
const EVIDENCE_TOOL = "livex_gcp_logs_read";
const MAX_EVIDENCE_URLS_PER_SESSION = 200;
const MAX_EVIDENCE_ENTRIES_SCANNED = 500;
const EVIDENCE_TTL_MS = 3 * 60 * 60_000;
const MAX_RESULT_TEXT = 256 * 1024;
// Process-wide hand-off of computed priorities to the memory plugin. Several plugin instances
// can load in one process, so the registry is created once and then shared.
const PRIORITY_REGISTRY = Symbol.for("livex.priority-engine.v1");
const REGISTRY_TTL_MS = 30 * 60_000;

function priorityRegistry() {
  const existing = globalThis[PRIORITY_REGISTRY];
  if (existing !== null && typeof existing === "object" && existing.results instanceof Map) {
    return existing;
  }
  const created = { results: new Map() };
  globalThis[PRIORITY_REGISTRY] = created;
  return created;
}

/** The tool result's structured details, else the JSON in its first text block. */
function readToolDetails(result) {
  if (result?.details !== null && typeof result?.details === "object") {
    return result.details;
  }
  const text = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text
    : undefined;
  if (typeof text !== "string" || text.length > MAX_RESULT_TEXT) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** True when a read lost entries. A "field"-only cut shortened text inside an entry. */
function readLostEntries(details) {
  const reasons = Array.isArray(details.truncationReasons) ? details.truncationReasons : [];
  if (reasons.length > 0) {
    return reasons.some((reason) => reason !== "field");
  }
  return details.truncated === true;
}

const ID_PARAMS = ["conversationId", "jobId", "roomId", "traceId", "insertId", "insertIds"];

/** True only when the params name at least one id (unknown params are not). */
function carriesIds(params) {
  return params !== null && typeof params === "object" && isIdScoped(params);
}

/** A read keyed on ids has its own outcome to protect; a listing is only a sample. Unknown: scoped. */
function isIdScoped(params) {
  if (params === null || typeof params !== "object") {
    return true;
  }
  return ID_PARAMS.some((name) => {
    const value = params[name];
    return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value !== "" : value != null;
  });
}

function boundedSet(map, key, limit) {
  let set = map.get(key);
  if (set) {
    map.delete(key);
  } else {
    set = new Set();
  }
  map.set(key, set);
  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
  return set;
}

/**
 * `key` is the 32-byte signing key from loadSigningKey. Without one, buttons are disabled:
 * cards render without controls and no click handler is needed. `warn` receives
 * diagnostics (never token or key contents).
 */
export function createPlugin(rawConfig, { now = Date.now, key, warn = () => {}, policy = DEFAULT_POLICY } = {}) {
  const gates = readConfig(rawConfig);
  const config = { ...gates, buttons: gates.buttons && Buffer.isBuffer(key) && key.length === 32 };
  // sessionKey -> ts values of cards this plugin rendered and Slack confirmed.
  const cards = new Map();
  // sessionKey -> cards rendered but not yet confirmed by message_sent.
  const pending = new Map();
  // `${channel}:${ts}` -> priority state a human set with the buttons.
  const overrides = new Map();
  // sessionKey -> Map(evidence url -> recorded at), from livex_gcp_logs_read results.
  const evidenceUrls = new Map();
  // sessionKey -> { ok, degraded, outcomes, at }: how this thread's logs reads turned out.
  // outcomes counts the successful, non-lossy reads that show an outcome: id-scoped or a complete count.
  const readStats = new Map();

  /** Logs-read outcome for a thread; zeros for an unknown or expired session. */
  function readStatsFor(sessionKey) {
    const stats = readStats.get(sessionKey);
    if (!stats || now() - stats.at > EVIDENCE_TTL_MS) {
      return { ok: 0, degraded: false, outcomes: 0 };
    }
    return { ok: stats.ok, degraded: stats.degraded, outcomes: stats.outcomes };
  }

  function noteRead(sessionKey, { ok, degraded, outcome = false }) {
    const at = now();
    const prior = readStats.get(sessionKey);
    const live = prior && at - prior.at <= EVIDENCE_TTL_MS ? prior : { ok: 0, degraded: false, outcomes: 0 };
    readStats.delete(sessionKey);
    readStats.set(sessionKey, {
      ok: live.ok + (ok ? 1 : 0),
      degraded: live.degraded || degraded,
      outcomes: live.outcomes + (outcome ? 1 : 0),
      at,
    });
    while (readStats.size > MAX_SESSIONS) {
      readStats.delete(readStats.keys().next().value);
    }
  }

  /** What the priority is computed with for one session: the policy and its logs reads. */
  const ratingFor = (sessionKey) => ({ policy, reads: readStatsFor(sessionKey) });

  /** Rates `facts` for a session, card or no card. Invalid facts throw, like the envelope check. */
  function computeFor(sessionKey, facts) {
    if (facts === null || typeof facts !== "object" || invalidFactField(facts) !== undefined) {
      throw new TypeError("livex-slack-summary: invalid facts");
    }
    return computePriority(factsFrom(facts), policy, readStatsFor(sessionKey));
  }

  try {
    // The memory plugin rates a case with this when no card was rendered for the session.
    // Several instances can load in one process: the one installed last wins.
    priorityRegistry().computeFor = computeFor;
  } catch {
    notice("priority engine not published: registry write failed");
  }

  /**
   * Publishes the card's computed result for other plugins in this process (the memory
   * plugin reads it when it saves the case). `compute` rates another fact set the same way.
   */
  function publishResult(sessionKey, runId, card) {
    const results = priorityRegistry().results;
    const at = now();
    for (const [entryKey, entry] of results) {
      if (!(at - entry?.at <= REGISTRY_TTL_MS)) {
        results.delete(entryKey);
      }
    }
    results.delete(sessionKey);
    results.set(sessionKey, {
      runId,
      at,
      primary: { signature: card.signature, priority: card.priority, ruleId: card.rating.ruleId },
      compute: (facts) => computeFor(sessionKey, facts),
    });
    while (results.size > MAX_SESSIONS) {
      results.delete(results.keys().next().value);
    }
  }

  /** Evidence options for one session: exact recorded match, plus the configured project. */
  function evidenceOptionsFor(sessionKey) {
    return {
      project: config.gcpProject,
      isRecorded(url) {
        const at = evidenceUrls.get(sessionKey)?.get(url);
        return at !== undefined && now() - at <= EVIDENCE_TTL_MS;
      },
    };
  }

  // ------------------------------------------------------------- after_tool_call
  /** Records the links the log tool itself produced; the card may cite only these. */
  function afterToolCall(event, ctx) {
    try {
      const sessionKey = ctx?.sessionKey;
      if (
        event?.toolName !== EVIDENCE_TOOL ||
        typeof sessionKey !== "string" ||
        !DEBUGGER_SLACK_THREAD.test(sessionKey)
      ) {
        return;
      }
      if (event.error) {
        // "Invalid ..." means the tool rejected the arguments and read nothing.
        const text = typeof event.error === "string" ? event.error : event.error?.message;
        if (!(typeof text === "string" && text.startsWith("Invalid"))) {
          noteRead(sessionKey, { ok: false, degraded: true });
        }
        return;
      }
      const details = readToolDetails(event.result);
      if (details !== undefined) {
        const degraded =
          details.complete === false || (readLostEntries(details) && isIdScoped(event.params));
        const outcome =
          (carriesIds(event.params) && !degraded) ||
          (event.params?.mode === "count" && details.complete === true);
        noteRead(sessionKey, { ok: true, degraded, outcome });
      }
      const project = details?.project;
      if (typeof project !== "string" || (config.gcpProject && project !== config.gcpProject)) {
        return;
      }
      const candidates = [
        details.logsExplorerUrl,
        ...(Array.isArray(details.entries)
          ? details.entries.slice(0, MAX_EVIDENCE_ENTRIES_SCANNED).map((entry) => entry?.entryUrl)
          : []),
        // A count result carries its links on up to a few samples per phrase.
        ...(Array.isArray(details.samples)
          ? details.samples.slice(0, MAX_EVIDENCE_ENTRIES_SCANNED).map((sample) => sample?.entryUrl)
          : []),
      ];
      const at = now();
      let urls = evidenceUrls.get(sessionKey);
      for (const candidate of candidates) {
        // Same shape and project rules as the card, so only a usable link is kept.
        if (typeof candidate !== "string" || readEvidenceHref(candidate, { project }) !== candidate) {
          continue;
        }
        if (!urls) {
          urls = new Map();
        }
        urls.delete(candidate);
        urls.set(candidate, at);
        while (urls.size > MAX_EVIDENCE_URLS_PER_SESSION) {
          urls.delete(urls.keys().next().value);
        }
      }
      if (urls) {
        // Re-insert as most recent session (bounded LRU).
        evidenceUrls.delete(sessionKey);
        evidenceUrls.set(sessionKey, urls);
        while (evidenceUrls.size > MAX_SESSIONS) {
          evidenceUrls.delete(evidenceUrls.keys().next().value);
        }
      }
    } catch {
      // Recording is best effort; a miss only drops the card's evidence link.
      notice("evidence links not recorded: after_tool_call handler failed");
    }
  }

  // One fixed-reason line per refusal or failure; never any card, tool or message content.
  function notice(reason) {
    try {
      warn(`livex-slack-summary: ${reason}`);
    } catch {
      // Logging is best effort.
    }
  }

  function controlsFor(card, bind) {
    const token = encodeState(card, bind, key);
    if (token === undefined) {
      // The card's state does not fit a button value: post it without controls.
      warn("livex-slack-summary: card too large for button state; rendering without buttons");
      return undefined;
    }
    return availableChoices(card).map((choice) => ({
      choice,
      label: CHOICES.get(choice),
      value: buttonValue(choice, token),
    }));
  }

  const buttonsAllowed = (session) =>
    config.buttons && Boolean(session) && channelAllowed(config, session.channelId);

  // ------------------------------------------------------ reply_payload_sending
  function replyPayloadSending(event, ctx) {
    let marked = false;
    let route = {};
    try {
      const { kind, channel, sessionKey, payload } = event ?? {};
      if (
        kind !== "final" ||
        channel !== "slack" ||
        !sessionKey ||
        !DEBUGGER_SLACK_THREAD.test(sessionKey) ||
        !payload ||
        payload.isReasoning ||
        payload.isCommentary ||
        payload.isStatusNotice
      ) {
        return undefined;
      }
      const envelope = classifyEnvelope(payload.text, evidenceOptionsFor(sessionKey), ratingFor(sessionKey));
      if (!envelope.marked) {
        return undefined;
      }
      marked = true;
      const { replyToId, replyToTag, replyToCurrent } = payload;
      route = { replyToId, replyToTag, replyToCurrent };
      const card = envelope.card;
      if (!card) {
        notice(`summary card replaced by notice: ${envelope.reason ?? "invalid card"}`);
        return { payload: { ...route, text: INVALID_SUMMARY } };
      }
      const runId = typeof (event.runId ?? ctx?.runId) === "string" ? (event.runId ?? ctx?.runId) : undefined;
      const session = parseSession(sessionKey);
      const controls = buttonsAllowed(session) ? controlsFor(card, session) : undefined;
      const rendered = renderBlocks(card, controls);
      try {
        publishResult(sessionKey, runId, card);
      } catch {
        // The card still posts; the memory plugin then stores the case unrated.
        notice("priority result not published: registry write failed");
      }
      // Prune expired entries and re-insert the session as most recent (bounded LRU).
      const queue = (pending.get(sessionKey) ?? []).filter((entry) => now() - entry.at <= PENDING_TTL_MS);
      queue.push({
        at: now(),
        headline: headlineOf(card),
        runId,
      });
      pending.delete(sessionKey);
      pending.set(sessionKey, queue.slice(-MAX_PENDING));
      while (pending.size > MAX_SESSIONS) {
        pending.delete(pending.keys().next().value);
      }
      return {
        payload: { ...route, channelData: { slack: rendered } },
      };
    } catch {
      // Never let a rendering fault pass the marked JSON and evidence through.
      if (marked) {
        notice("summary card replaced by notice: rendering failed");
      }
      return marked ? { payload: { ...route, text: INVALID_SUMMARY } } : undefined;
    }
  }

  // ----------------------------------------------------------------- message_sent
  function messageSent(event, ctx) {
    try {
      const sessionKey = event?.sessionKey ?? ctx?.sessionKey;
      const session = parseSession(sessionKey);
      const ts = event?.messageId;
      const success = event?.success === true;
      if (!session || (success && (typeof ts !== "string" || !SLACK_TS.test(ts)))) {
        return;
      }
      const queue = pending.get(sessionKey);
      if (!queue?.length) {
        return;
      }
      const live = queue.filter((entry) => now() - entry.at <= PENDING_TTL_MS);
      const content = typeof event.content === "string" ? event.content : "";
      const sentRun = event.runId ?? ctx?.runId;
      // The card is posted without text, so a confirmed card carries either no
      // content or its own header text. Any other message (a plain reply, the
      // invalid-summary notice) is not a card and keeps the queue. When both
      // sides carry a run id they must agree.
      const index = live.findIndex(
        (entry) =>
          (content.trim() === "" || content.includes(entry.headline)) &&
          !(typeof sentRun === "string" && entry.runId && sentRun !== entry.runId),
      );
      const done = (list) => (list.length ? pending.set(sessionKey, list) : pending.delete(sessionKey));
      if (index < 0 || (success && !tsAfter(ts, session.threadTs))) {
        done(live);
        return;
      }
      live.splice(index, 1);
      done(live);
      if (!success) {
        // A failed card send leaves nothing in Slack: forget its pending entry.
        return;
      }
      const known = boundedSet(cards, sessionKey, MAX_SESSIONS);
      known.add(ts);
      while (known.size > MAX_CARDS_PER_SESSION) {
        known.delete(known.values().next().value);
      }
    } catch {
      // Recording is best effort; a miss only blocks a later amendment.
      notice("card confirmation not recorded: message_sent handler failed");
    }
  }

  // -------------------------------------------------------------- before_tool_call
  const block = (reason) => ({ block: true, blockReason: reason });
  // Refusals where a new card is the right way out: the model must not end with plain text.
  const NEW_CARD_FALLBACK =
    `Do not retry the edit. End your reply with a new ${SUMMARY_MARKER} summary and the full ` +
    "report instead; the Gateway posts it as a new card.";

  function beforeToolCall(event, ctx) {
    try {
      if (event?.toolName !== "message") {
        return undefined;
      }
      const params = event.params;
      const action = typeof params?.action === "string" ? params.action.trim().toLowerCase() : "";
      const sessionKey = ctx?.sessionKey;
      const debuggerSession =
        typeof sessionKey === "string" ? sessionKey.startsWith("agent:debugger:") : false;
      // `livexAttachments` is the patched edit path's private colour-bar channel. Only this
      // guard may fill it, and only for a validated card edit: strip it from every other
      // call (any agent, any action) so a model cannot inject an attachment.
      const stripAttachments = params?.livexAttachments !== undefined
        ? { params: { livexAttachments: undefined } }
        : undefined;
      if (action !== "edit") {
        return stripAttachments;
      }
      if (!debuggerSession) {
        // Other agents keep their own policy. An edit with no session at all
        // cannot be tied to a thread, so it is refused for the debugger only.
        return ctx?.agentId === "debugger"
          ? block("Editing is not available in this context.")
          : stripAttachments;
      }
      const session = parseSession(sessionKey);
      if (!session) {
        return block("Report amendments are only available inside an alert thread.");
      }

      // Target: any supplied target must be this thread's channel, and one must be present.
      const channel = params.channel;
      if (channel !== undefined && String(channel).trim().toLowerCase() !== "slack") {
        return block(`Report amendments are limited to this Slack thread. ${NEW_CARD_FALLBACK}`);
      }
      if (params.targets !== undefined) {
        return block(`Report amendments take a single target in this thread's channel. ${NEW_CARD_FALLBACK}`);
      }
      const targets = ["target", "to", "channelId"]
        .map((key) => params[key])
        .filter((value) => value !== undefined && value !== null && value !== "");
      if (
        targets.length === 0 ||
        !targets.every((value) => readChannelId(value) === session.channelId)
      ) {
        return block(`Report amendments must target this thread's channel. ${NEW_CARD_FALLBACK}`);
      }

      // Message: one well-formed ts that this plugin recorded as a card in this session.
      const ids = [params.messageId, params.message_id].filter(
        (value) => value !== undefined && value !== null && value !== "",
      );
      const messageId = ids[0];
      if (
        ids.length === 0 ||
        typeof messageId !== "string" ||
        !SLACK_TS.test(messageId) ||
        !ids.every((value) => value === messageId)
      ) {
        return block(
          `messageId must be the timestamp of your own summary card in this thread. ${NEW_CARD_FALLBACK}`,
        );
      }
      if (!cards.get(sessionKey)?.has(messageId)) {
        return block(
          "This message cannot be amended (it is not a summary card this Gateway posted in this " +
            `thread, or the Gateway restarted since). ${NEW_CARD_FALLBACK}`,
        );
      }

      // Content: the same envelope the first reply used, through the same renderer.
      const envelope = classifyEnvelope(params.message, evidenceOptionsFor(sessionKey), ratingFor(sessionKey));
      if (!envelope.marked || !envelope.card) {
        // The reason is a fixed phrase or a field name, never envelope content.
        const why = envelope.marked ? (envelope.reason ?? "invalid card") : "no summary envelope";
        notice(`amendment refused: ${why}`);
        return block(
          `Amended content is not a valid summary envelope (${why}): it must be ${SUMMARY_MARKER}, ` +
            `one JSON line with the summary fields, a blank line, then the full report. ${NEW_CARD_FALLBACK}`,
        );
      }
      let card = envelope.card;
      const runId = typeof (event.runId ?? ctx?.runId) === "string" ? (event.runId ?? ctx?.runId) : undefined;
      try {
        // The memory plugin must see the amended rating, not the first card's.
        publishResult(sessionKey, runId, card);
      } catch {
        notice("priority result not published: registry write failed");
      }
      const human = overrides.get(`${session.channelId}:${messageId}`);
      if (human) {
        // A person's button choice outranks the agent's re-assessment.
        card = { ...card, priority: human.priority, resolved: human.resolved };
      }
      const controls = buttonsAllowed(session) ? controlsFor(card, session) : undefined;
      return {
        params: {
          messageId,
          message_id: messageId,
          message: headlineOf(card),
          ...renderPresentation(card, controls),
        },
      };
    } catch {
      // Only a hostile event can fault before the tool is classified, and an
      // event that cannot be read is not safe to wave through.
      notice("amendment guard failed closed: before_tool_call handler failed");
      return block("The amendment guard failed closed; the tool call was not applied.");
    }
  }

  // ------------------------------------------------------------------ interactive
  /**
   * A refused or invalid click never touches the message. respond.reply and respond.followUp
   * post to Slack's response_url, which replaces the original card, so they are not used at all.
   */
  async function interactive(ctx) {
    const refuse = (reason) => {
      try {
        warn(`livex-slack-summary: button click refused: ${reason}`);
      } catch {
        // Logging is best effort.
      }
      return { handled: true };
    };
    try {
      if (!config.buttons) {
        return refuse("controls not enabled");
      }
      if (ctx.senderId !== config.senderId) {
        return refuse("sender is not the configured responder");
      }
      const channelId = readChannelId(String(ctx.conversationId ?? "").trim());
      if (!channelId || !channelAllowed(config, channelId)) {
        return refuse("channel not enabled");
      }
      const interaction = ctx.interaction;
      if (interaction?.kind !== "button" || typeof interaction.messageTs !== "string") {
        return refuse("control could not be read");
      }
      const payload = typeof interaction.payload === "string" ? interaction.payload : "";
      const separator = payload.indexOf(":");
      const choice = separator > 0 ? payload.slice(0, separator) : "";
      const bind = {
        channelId,
        threadTs: String(interaction.threadTs ?? ctx.threadId ?? ""),
      };
      const card = CHOICES.has(choice)
        ? decodeState(payload.slice(separator + 1), bind, key)
        : undefined;
      if (!card) {
        return refuse("invalid, expired or foreign token");
      }
      const next = applyChoice(card, choice);
      const { blocks, attachments } = renderBlocks(next, controlsFor(next, bind));
      await ctx.respond.editMessage({ text: headlineOf(next), blocks, attachments });
      const cardKey = `${channelId}:${interaction.messageTs}`;
      overrides.delete(cardKey);
      overrides.set(cardKey, {
        priority: next.priority,
        resolved: next.resolved,
      });
      while (overrides.size > MAX_OVERRIDES) {
        overrides.delete(overrides.keys().next().value);
      }
      return { handled: true };
    } catch {
      return refuse("card could not be updated");
    }
  }

  return { config, replyPayloadSending, messageSent, beforeToolCall, afterToolCall, readStatsFor, interactive };
}

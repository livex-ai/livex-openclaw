// Let the verified @openclaw/slack@2026.10.5 package carry ONE legacy Slack attachment
// (colour bar + blocks) next to a block message. Stock outbound drops `attachments`:
//   - send.ts buildSlackPostMessagePayload only copies text, blocks, metadata, threading;
//   - monitor/replies.ts deliverReplies and outbound-adapter.ts sendPayload never forward
//     channelData.slack.attachments;
//   - monitor/events/interactions.block-actions.ts updateSlackInteractionMessage (chat.update)
//     only sends text and blocks.
// This patch forwards `channelData.slack.attachments` (reply path), the plugin interactive
// `editMessage({ attachments })` (button path) and the message-tool `edit` (amendment path) to
// chat.postMessage / chat.update.
//
// Amendment path: message-action-dispatch.ts (channel bundle) -> action-runtime `editMessage` ->
// editSlackMessage -> editSlackRenderedMessage (actions bundle). The tool's own `attachments`
// param is the media-attachment pipeline, so the before_tool_call guard hands the colour bar in a
// separate `livexAttachments` param that the shallow param merge
// (agent-tools.before-tool-call.approval.ts:81-90) delivers to the edit. Slack keeps a message's
// previous attachments on chat.update when the field is omitted, so an edit that sets blocks
// always sends `attachments` (the sanitized `livexAttachments`, else `[]`): no stale colour bar
// under new blocks.
//
// Every attachment goes through livexSanitizeSlackAttachments right before the Slack API call:
// exactly 1 attachment holding only `color` (#RRGGBB), `fallback` (string, at most 4000
// characters) and `blocks` (1-10 blocks, each a verbatim-mrkdwn `section` with only `type` and
// `text` (at most 3000 characters) or a `context` of 1-10 `plain_text` elements). Anything else
// is dropped (the message still posts with its blocks).
// Attachments ride only with a message that has top-level blocks, so text chunks never carry
// them, and they are attached to the first block message of a reply only.
//
// Exact anchors, fail-loud: a missing or ambiguous anchor, an unexpected file digest or an
// already patched file aborts before any file is written. Apply after patch-slack-navigation.mjs
// (the monitor bundle is accepted stock or navigation-patched). Remove this patch when the
// pinned Slack package forwards channel attachments natively.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "livexSanitizeSlackAttachments";

// sha256 of the stock 2026.10.5 files. The monitor bundle is also accepted with the
// navigation backport applied (patch-slack-navigation.mjs runs first in the image build).
const DIGESTS = {
  "send-CyRH2z7u.mjs": ["5512fde89c0c2eb94661daabeda4645f67462172941632772ec0940195a5a52e"],
  "replies-BNr7i3d0.mjs": ["3c0fde69f4cb3cd1347dd65cba9c8d7415c23c2b379056985cf02235a31dd62f"],
  "outbound-adapter-CEh2K9pB.mjs": ["3a9e46873194ffa82bc6616e85cb86e9291b967381adb477864f9e3ebf9319bc"],
  "channel-C6Y0ZA9K.mjs": ["64a04bc5a8af2bfe76a915408872cb22daac2cc1ddc381c2a8b60f77188244fb"],
  "action-runtime-DtOIVezL.mjs": ["15b0deb3edd764a92a344bcf2f26cca33f1126f52c228638334a66be0b4b079c"],
  "actions-Ch4O8XbW.mjs": ["66b3acbacd106efdfa7caccfb4f8cd4d490fd8d0331cf0c25d3b0552bf92fe1e"],
  "monitor-CNECe8FK.mjs": [
    "ef2452d5219c75b3f14a940b62022d1e97bf473bd27bed6c5c7a292236f0b929",
    "e82c3e120178808667bd6f6916426cd135d6f0c11614444368ba54228e1f7ca1",
  ],
};

// Injected verbatim into send (chat.postMessage), actions (chat.update) and monitor (chat.update).
// The inner blocks are exactly what the LiveX summary card renders (renderBlocks in
// livex-slack-summary/core.mjs) and nothing else: a verbatim mrkdwn `section` and a `context`
// of plain_text elements. Images, actions, rich_text, accessories, fields and every other block
// type or key drop the whole attachment. Accepted blocks are rebuilt from known keys.
const SANITIZER = `function ${MARKER}(value) {
\tif (!Array.isArray(value) || value.length !== 1) return void 0;
\tconst attachment = value[0];
\tconst record = (item) => item !== null && typeof item === "object" && !Array.isArray(item);
\tconst only = (item, keys) => Object.keys(item).every((key) => keys.includes(key));
\tconst text = (item) => typeof item === "string" && item.length >= 1 && item.length <= 3000;
\tif (!record(attachment)) return void 0;
\tif (!only(attachment, ["color", "blocks", "fallback"])) return void 0;
\tif (attachment.color !== void 0 && !(typeof attachment.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(attachment.color))) return void 0;
\tif (attachment.fallback !== void 0 && !(typeof attachment.fallback === "string" && attachment.fallback.length <= 4000)) return void 0;
\tconst blocks = attachment.blocks;
\tif (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 10) return void 0;
\tconst section = (block) => only(block, ["type", "text"]) && record(block.text) && only(block.text, ["type", "text", "verbatim"]) && block.text.type === "mrkdwn" && block.text.verbatim === true && text(block.text.text);
\tconst element = (item) => record(item) && only(item, ["type", "text", "emoji"]) && item.type === "plain_text" && text(item.text) && (item.emoji === void 0 || typeof item.emoji === "boolean");
\tconst context = (block) => only(block, ["type", "elements"]) && Array.isArray(block.elements) && block.elements.length >= 1 && block.elements.length <= 10 && block.elements.every(element);
\tif (!blocks.every((block) => record(block) && (block.type === "section" ? section(block) : block.type === "context" && context(block)))) return void 0;
\treturn [{
\t\t...attachment.color !== void 0 ? { color: attachment.color } : {},
\t\t...attachment.fallback !== void 0 ? { fallback: attachment.fallback } : {},
\t\tblocks: blocks.map((block) => block.type === "section" ? {
\t\t\ttype: "section",
\t\t\ttext: { type: "mrkdwn", text: block.text.text, verbatim: true }
\t\t} : {
\t\t\ttype: "context",
\t\t\telements: block.elements.map((item) => ({
\t\t\t\ttype: "plain_text",
\t\t\t\ttext: item.text,
\t\t\t\t...item.emoji !== void 0 ? { emoji: item.emoji } : {}
\t\t\t}))
\t\t})
\t}];
}
`;

const POST_PAYLOAD_HELPER = `function livexSlackAttachmentsField(params) {
\tif (!params.blocks?.length) return {};
\tconst attachments = ${MARKER}(params.attachments);
\treturn attachments ? { attachments } : {};
}
`;

export const EDITS = {
  "send-CyRH2z7u.mjs": [
    {
      // buildSlackPostMessagePayload helpers (send.ts / post-message-payload.ts).
      anchor: "function buildSlackPostMessagePayload(params) {",
      replacement: `${SANITIZER}${POST_PAYLOAD_HELPER}function buildSlackPostMessagePayload(params) {`,
    },
    {
      anchor: "\t\t...params.blocks?.length ? { blocks: params.blocks } : {},\n",
      replacement:
        "\t\t...params.blocks?.length ? { blocks: params.blocks } : {},\n\t\t...livexSlackAttachmentsField(params),\n",
    },
    {
      // The block message of sendMessageSlackQueued (the only part that never chunks).
      anchor: "\t\t\t\t\tblocks,\n\t\t\t\t\tmetadata: initialBlockMetadata,\n",
      replacement:
        "\t\t\t\t\tblocks,\n\t\t\t\t\t...opts.attachments ? { attachments: opts.attachments } : {},\n\t\t\t\t\tmetadata: initialBlockMetadata,\n",
    },
  ],
  "replies-BNr7i3d0.mjs": [
    {
      anchor: "\t\t\t\t...input.blocks ? { blocks: input.blocks } : {},\n",
      replacement:
        "\t\t\t\t...input.blocks ? { blocks: input.blocks } : {},\n\t\t\t\t...input.blocks && input.attachments ? { attachments: input.attachments } : {},\n",
    },
    {
      anchor: '\t\tlet outsideText = authoredTextPlacement === "outside-blocks" ? textRaw ?? "" : "";\n',
      replacement:
        '\t\tlet outsideText = authoredTextPlacement === "outside-blocks" ? textRaw ?? "" : "";\n\t\tlet livexAttachmentsPending = Array.isArray(payload.channelData?.slack?.attachments) ? payload.channelData.slack.attachments : void 0;\n',
    },
    {
      anchor:
        '\t\t\t\tlastResult = await sendReply({\n\t\t\t\t\t...message.blocks ? {\n\t\t\t\t\t\t...message,\n\t\t\t\t\t\ttext: message.nativeDataFallbackBaseText ?? ""\n\t\t\t\t\t} : { text: message.text },\n\t\t\t\t\tthreadTs\n\t\t\t\t});\n',
      replacement:
        '\t\t\t\tconst livexAttachments = message.blocks ? livexAttachmentsPending : void 0;\n\t\t\t\tif (livexAttachments) livexAttachmentsPending = void 0;\n\t\t\t\tlastResult = await sendReply({\n\t\t\t\t\t...message.blocks ? {\n\t\t\t\t\t\t...message,\n\t\t\t\t\t\ttext: message.nativeDataFallbackBaseText ?? ""\n\t\t\t\t\t} : { text: message.text },\n\t\t\t\t\t...livexAttachments ? { attachments: livexAttachments } : {},\n\t\t\t\t\tthreadTs\n\t\t\t\t});\n',
    },
  ],
  "outbound-adapter-CEh2K9pB.mjs": [
    {
      anchor: "\t\t\t...params.blocks ? { blocks: params.blocks } : {},\n",
      replacement:
        "\t\t\t...params.blocks ? { blocks: params.blocks } : {},\n\t\t\t...params.blocks && Array.isArray(params.attachments) ? { attachments: params.attachments } : {},\n",
    },
    {
      anchor:
        "\t\t\t\tfor (const message of deliveryMessages) sentResults.push(await send({\n\t\t\t\t\t...preparedCtx,\n\t\t\t\t\t...message\n\t\t\t\t}));\n",
      replacement:
        "\t\t\t\tlet livexAttachmentsPending = Array.isArray(slackData?.attachments) ? slackData.attachments : void 0;\n\t\t\t\tfor (const message of deliveryMessages) {\n\t\t\t\t\tconst livexAttachments = message.blocks ? livexAttachmentsPending : void 0;\n\t\t\t\t\tif (livexAttachments) livexAttachmentsPending = void 0;\n\t\t\t\t\tsentResults.push(await send({\n\t\t\t\t\t\t...preparedCtx,\n\t\t\t\t\t\t...message,\n\t\t\t\t\t\t...livexAttachments ? { attachments: livexAttachments } : {}\n\t\t\t\t\t}));\n\t\t\t\t}\n",
    },
  ],
  "channel-C6Y0ZA9K.mjs": [
    {
      // handleSlackMessageAction `edit` (message-action-dispatch.ts:218-257).
      anchor: '\t\t\taction: "editMessage",\n\t\t\tchannelId: resolveChannelId(),\n\t\t\tmessageId,\n\t\t\tcontent: accessibleContent,\n\t\t\tblocks\n\t\t});\n',
      replacement:
        '\t\t\taction: "editMessage",\n\t\t\tchannelId: resolveChannelId(),\n\t\t\tmessageId,\n\t\t\tcontent: accessibleContent,\n\t\t\tblocks,\n\t\t\t...Array.isArray(actionParams.livexAttachments) ? { attachments: actionParams.livexAttachments } : {}\n\t\t});\n',
    },
  ],
  "action-runtime-DtOIVezL.mjs": [
    {
      // slackActionRuntime `editMessage`.
      anchor: "\t\t\t\t\t...writeOpts,\n\t\t\t\t\tblocks\n\t\t\t\t});\n",
      replacement:
        "\t\t\t\t\t...writeOpts,\n\t\t\t\t\tblocks,\n\t\t\t\t\t...Array.isArray(params.attachments) ? { attachments: params.attachments } : {} /* livexAttachments */\n\t\t\t\t});\n",
    },
  ],
  "actions-Ch4O8XbW.mjs": [
    {
      anchor: "async function editSlackRenderedMessage(channelId, messageId, content, opts = {}) {\n",
      replacement: `${SANITIZER}async function editSlackRenderedMessage(channelId, messageId, content, opts = {}) {\n`,
    },
    {
      // Always set attachments with blocks: Slack keeps old ones when the field is omitted.
      anchor:
        "SLACK_EDIT_TEXT_MAX_BYTES),\n\t\t...blocks ? { blocks } : {}\n\t};\n",
      replacement: `SLACK_EDIT_TEXT_MAX_BYTES),\n\t\t...blocks ? { blocks, attachments: ${MARKER}(opts.attachments) ?? [] } : {}\n\t};\n`,
    },
  ],
  "monitor-CNECe8FK.mjs": [
    {
      // updateSlackInteractionMessage (interactions.block-actions.ts:211-225).
      anchor: "async function updateSlackInteractionMessage(params, message) {\n",
      replacement: `${SANITIZER}async function updateSlackInteractionMessage(params, message) {\n`,
    },
    {
      anchor:
        "\t\ttext: message.text,\n\t\t...message.blocks ? { blocks: message.blocks } : {}\n\t});\n}\nfunction resolveSlackApprovalTerminalLabel",
      replacement: `\t\ttext: message.text,\n\t\t...message.blocks ? { blocks: message.blocks } : {},\n\t\t...message.blocks && ${MARKER}(message.attachments) ? { attachments: ${MARKER}(message.attachments) } : {}\n\t});\n}\nfunction resolveSlackApprovalTerminalLabel`,
    },
    {
      // The plugin interactive respond.editMessage.
      anchor:
        '\t\t\teditMessage: async ({ text, blocks }) => {\n\t\t\t\tawait updateSlackInteractionMessage(params, {\n\t\t\t\t\ttext: text ?? params.parsed.typedBody.message?.text ?? "",\n\t\t\t\t\tblocks: Array.isArray(blocks) ? blocks : void 0\n\t\t\t\t});\n',
      replacement:
        '\t\t\teditMessage: async ({ text, blocks, attachments }) => {\n\t\t\t\tawait updateSlackInteractionMessage(params, {\n\t\t\t\t\ttext: text ?? params.parsed.typedBody.message?.text ?? "",\n\t\t\t\t\tblocks: Array.isArray(blocks) ? blocks : void 0,\n\t\t\t\t\tattachments\n\t\t\t\t});\n',
    },
  ],
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function replaceOnce(source, { anchor, replacement }, label) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`Slack attachments patch anchor is missing or ambiguous in ${label}: ${JSON.stringify(anchor.slice(0, 80))}`);
  }
  return source.replace(anchor, () => replacement);
}

/** Returns { file -> patched source } without writing; throws before any change is possible. */
export function patchSlackAttachments(setupDir, digests = DIGESTS) {
  const patched = {};
  for (const [file, edits] of Object.entries(EDITS)) {
    const source = fs.readFileSync(path.join(setupDir, file), "utf8");
    if (source.includes(MARKER) || source.includes("livexAttachments")) {
      throw new Error(`Slack attachments patch is already applied to ${file}`);
    }
    if (!digests[file].includes(sha256(source))) {
      throw new Error(`Unexpected ${file} for the Slack attachments patch`);
    }
    patched[file] = edits.reduce((text, edit) => replaceOnce(text, edit, file), source);
  }
  return patched;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [packageDir] = process.argv.slice(2);
  const setupDir = path.join(packageDir, "dist/.setup");
  const patched = patchSlackAttachments(setupDir);
  for (const [file, text] of Object.entries(patched)) {
    fs.writeFileSync(path.join(setupDir, file), text);
  }
}

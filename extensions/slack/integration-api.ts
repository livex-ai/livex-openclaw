// Keep external consumers independent of Slack channel and setup registration.
export { resolveSlackAccount } from "./src/accounts.js";
export { createSlackWebClient, createSlackWriteClient } from "./src/client.js";
export {
  SLACK_ROOT_MESSAGE_SIGNAL,
  type SlackRootMessageSignalSource,
} from "./src/monitor/message-signals.js";

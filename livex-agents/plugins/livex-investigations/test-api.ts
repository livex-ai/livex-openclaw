/** Explicit cross-package integration fixture surface; never imported by runtime code. */
export { createInvestigationDelivery } from "./delivery.js";
export {
  closeInvestigationTurnRegistry,
  createInvestigationTurnRegistry,
  getInvestigationTurnRegistry,
  tryGetInvestigationTurnRegistry,
  type InvestigationTurn,
} from "./runtime.js";
export {
  oncallReportProfile,
  preparedFixture,
  withOncallReportProfile,
} from "./profile.test-support.js";
export {
  parseCompletedInvestigations,
  serializeCatalog,
  type CompletedInvestigation,
  type HistoryScope,
} from "./schema.js";
export { readCatalog } from "./store.js";

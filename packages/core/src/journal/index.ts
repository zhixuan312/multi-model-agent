export {
  allocateNextNodeId,
  parseJournalNodeDocument,
  renderNodeFilename,
  renderNodeMarkdown,
  validateJournalLinkSet,
} from './node-codec.js';
export type {
  JournalLink,
  JournalLinkType,
  JournalNodeDocument,
  JournalNodeStatus,
  JournalNodeType,
} from './node-codec.js';
export { JournalStore } from './store.js';
export type {
  ApplyRecordInput,
  ApplyRecordResult,
  CreateDecision,
  JournalRecordDecision,
  MergeDecision,
} from './store.js';
export {
  JournalIndexStore,
  JOURNAL_INDEX_DB_FILENAME,
  JOURNAL_INDEX_SCHEMA_VERSION,
} from './index-store.js';
export type {
  IndexedDocument,
  IndexedLink,
  IndexHealth,
  LexicalHit,
} from './index-store.js';
export { searchCandidatesForRecall, searchCandidatesForRecord } from './search.js';
export type { JournalCandidate } from './search.js';

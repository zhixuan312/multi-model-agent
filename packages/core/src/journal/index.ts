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
  searchCandidatesForRecall,
  searchCandidatesForRecord,
} from './adapters/journal-adapter.js';
export type {
  IndexedDocument,
  IndexedLink,
  IndexHealth,
  LexicalHit,
  JournalCandidate,
} from './adapters/journal-adapter.js';

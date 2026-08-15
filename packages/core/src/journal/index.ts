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
  searchCandidatesForRecordBatch,
} from './adapters/journal-adapter.js';
export type {
  IndexedDocument,
  IndexedDocumentMeta,
  IndexedLink,
  IndexHealth,
  JournalCandidate,
} from './adapters/journal-adapter.js';
export { CorpusIndex } from './engine/index-store.js';
export type {
  CorpusAdapter,
  CorpusRecord,
  StoredRecord,
  StoredRecordMeta,
} from './engine/types.js';

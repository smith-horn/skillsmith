/**
 * @fileoverview Public barrel for the change-journal module
 *               (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/core/journal
 *
 * Consumed by `@skillsmith/mcp-server`'s apply-family tools
 * (`apply_namespace_rename`, `apply_recommended_edit`, `undo_apply`) via the
 * `@skillsmith/core/journal` subpath export.
 */

export {
  JOURNAL_SCHEMA_VERSION,
  type JournalAction,
  type JournalRecord,
  type JournalRecordFields,
  type JournalRecordInput,
} from './types.js'

export { sha256Hex, JOURNAL_GENESIS_HASH } from './hash.js'

export {
  JOURNAL_DIR_ENV_VAR,
  getJournalFilePath,
  getJournalSessionId,
  resetJournalSessionIdForTests,
} from './path.js'

export {
  appendJournalRecord,
  computeRecordHash,
  isCorruptTailError,
  type JournalCorruptTailError,
} from './writer.js'

export { verifyJournalChain, readJournalRecords, type ChainVerificationResult } from './reader.js'

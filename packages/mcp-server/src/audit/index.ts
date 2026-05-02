/**
 * @fileoverview Public barrel for the consumer-namespace audit module
 *               (SMI-4587 Wave 1 Step 9). Wave 2/3/4 callers import from
 *               this entrypoint instead of reaching into individual files.
 * @module @skillsmith/mcp-server/audit
 *
 * Surface:
 *   - Detection:   `detectCollisions`, kind-specific helpers
 *   - History:     `writeAuditHistory`, `readAuditHistory`, `newAuditId`
 *   - Report:      `writeAuditReport`, `renderAuditReport`
 *   - Telemetry:   `emitAuditCompleteEvent`
 *   - Bootstrap:   `bootstrapUnmanagedSkills`, `isUnmanagedSkill`
 *   - Types:       `InventoryAuditResult`, collision flag types, branded ids
 */

export {
  bootstrapUnmanagedSkills,
  detectCollisions,
  detectExactCollisions,
  detectGenericTokenFlags,
  getLastBootstrapWarnings,
  isUnmanagedSkill,
} from './collision-detector.js'

export type { BootstrapFn, DetectCollisionsOptions } from './collision-detector.js'

export {
  deriveCollisionId,
  hasClaudeMdEntries,
  newAuditId,
  readAuditHistory,
  writeAuditHistory,
} from './audit-history.js'

export type { AuditHistoryOptions, WriteAuditHistoryResult } from './audit-history.js'

export { renderAuditReport, writeAuditReport } from './audit-report-writer.js'

export type {
  AuditReportRenderOptions,
  AuditReportWriteOptions,
  AuditReportWriteResult,
} from './audit-report-writer.js'

export { emitAuditCompleteEvent } from '../tools/namespace-audit/telemetry.js'
export type {
  AuditCompleteContext,
  AuditCompleteTelemetryOptions,
} from '../tools/namespace-audit/telemetry.js'

export type {
  AuditId,
  CollisionId,
  ExactCollisionFlag,
  GenericTokenFlag,
  InventoryAuditResult,
  SemanticCollisionFlag,
} from './collision-detector.types.js'

// SMI-4588 Wave 2 PR #1 — namespace-overrides ledger surface.
export {
  appendOverride,
  findOverride,
  readLedger,
  readLedgerResult,
  writeLedger,
} from './namespace-overrides.js'

export type { LedgerPathOptions } from './namespace-overrides.js'

export { CURRENT_VERSION as NAMESPACE_OVERRIDES_CURRENT_VERSION } from './namespace-overrides.types.js'

export type {
  LedgerVersion,
  LedgerVersionUnsupportedError,
  OverrideRecord,
  OverridesLedger,
  ReadLedgerResult,
} from './namespace-overrides.types.js'

// SMI-4588 Wave 2 PR #1 — shared namespace-audit types (PRs #3/#4 consumers).
export type { NamespaceWarning, PendingCollision } from './namespace-audit.types.js'

// SMI-4588 Wave 2 PR #2 — rename engine + suggestion chain.
export { applyRename, generateSuggestionChain, REVERT_SUMMARY_PREFIX } from './rename-engine.js'

export type {
  ApplyRenameRequest,
  ApplyRenameResult,
  RenameAction,
  RenameActionRequest,
  RenameError,
  RenameSuggestion,
  SuggestionChain,
} from './rename-engine.types.js'

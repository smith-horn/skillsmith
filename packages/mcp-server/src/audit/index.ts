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

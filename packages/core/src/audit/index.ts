/**
 * @fileoverview Public barrel for the audit shared helpers (SMI-4590 Wave 4 PR 3).
 * @module @skillsmith/core/audit
 *
 * Subpath export: `@skillsmith/core/audit`. Aggregates the audit-mode
 * resolver (existing, originally added in Wave 1 / SMI-4587) and the
 * audit-exclusions schema/loader/gate (new in Wave 4 PR 3). Consumers
 * (`mcp-server`, `cli`, `website`) import from this path; PR 4–6 add
 * additional exports here as Wave 4 lands.
 */

export {
  isAuditMode,
  resolveAuditMode,
  tierDefault,
  type AuditMode,
  type ResolveAuditModeOptions,
  type Tier,
} from '../config/audit-mode.js'

export {
  getExclusionsPath,
  isExcluded,
  loadExclusions,
  tierAllowsAuditMode,
  type LoadExclusionsOptions,
} from './exclusions.js'

export type {
  ExcludableEntry,
  ExclusionEntry,
  ExclusionsConfig,
} from './exclusions.types.js'

export { emitInstallEvent, type InstallEventPayload } from './remote-audit.js'

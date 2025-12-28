/**
 * SMI-587: Security module exports
 * SMI-685: Enhanced with severity scoring types
 */

export { SecurityScanner } from './scanner.js'
export type {
  SecurityFinding,
  SecurityFindingType,
  SecuritySeverity,
  ScanReport,
  ScannerOptions,
  RiskScoreBreakdown,
} from './scanner.js'

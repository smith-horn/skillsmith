/**
 * Security Scanner Module - SMI-587, SMI-685, SMI-882, SMI-1189
 *
 * Re-exports for security scanning functionality.
 */

// Types
export type {
  SecurityFindingType,
  SecuritySeverity,
  SecurityFinding,
  RiskScoreBreakdown,
  ScanReport,
  ScannerOptions,
} from './types.js'

// Patterns (for testing/extending)
export {
  DEFAULT_ALLOWED_DOMAINS,
  SENSITIVE_PATH_PATTERNS,
  JAILBREAK_PATTERNS,
  SUSPICIOUS_PATTERNS,
  SOCIAL_ENGINEERING_PATTERNS,
  PROMPT_LEAKING_PATTERNS,
  DATA_EXFILTRATION_PATTERNS,
  PRIVILEGE_ESCALATION_PATTERNS,
} from './patterns.js'

// Weights (for testing/extending)
export { SEVERITY_WEIGHTS, CATEGORY_WEIGHTS } from './weights.js'

// Regex utilities (for testing/extending)
export { MAX_LINE_LENGTH_FOR_REGEX, safeRegexTest, safeRegexCheck } from './regex-utils.js'

// Main class
export { SecurityScanner, default } from './SecurityScanner.js'

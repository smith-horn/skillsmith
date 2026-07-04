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
  HostileUpdateVerdict,
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
  AI_DEFENCE_PATTERNS,
  SSRF_INSTRUCTION_PATTERNS,
  PII_PATTERNS,
  CODE_EXECUTION_PATTERNS,
} from './patterns.js'

// Weights (for testing/extending)
export { SEVERITY_WEIGHTS, CATEGORY_WEIGHTS } from './weights.js'

// Regex utilities (for testing/extending)
export { MAX_LINE_LENGTH_FOR_REGEX, safeRegexTest, safeRegexCheck } from './regex-utils.js'

// Main class
export { SecurityScanner, default } from './SecurityScanner.js'

// Hostile-update comparator (SMI-5535, R0 Wave 2A)
export { compareScanReports, DEFAULT_RISK_THRESHOLD } from './SecurityScanner.hostile-update.js'

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
  TyposquatEnforcementMode,
  // SMI-5876: evidence-tier classification behind jailbreak/ai_defence findings.
  EvidenceType,
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
  // SMI-5876: ruleset version stamp, consumed by the security-audit baseline
  // to force a re-scan when the pattern/evidence-tier definitions change.
  SCANNER_RULESET_VERSION,
} from './patterns.js'

// Weights (for testing/extending)
export { SEVERITY_WEIGHTS, CATEGORY_WEIGHTS } from './weights.js'

// Regex utilities (for testing/extending)
export {
  MAX_LINE_LENGTH_FOR_REGEX,
  MAX_CONTENT_LENGTH_FOR_REGEX,
  safeRegexTest,
  safeRegexCheck,
} from './regex-utils.js'

// Obfuscation-defeat primitive (SMI-4703: reused by
// packages/doc-retrieval-mcp/src/security/memory-injection-scanner.ts's
// normalization pipeline rather than reimplemented there)
export { stripInvisible } from './SecurityScanner.exec.js'

// Confusable/homoglyph normalization primitives (SMI-595 extraction, for testing/extending;
// also reused by SMI-4703's memory-injection-scanner.ts confusable-fold step)
export {
  CONFUSABLES,
  isFullwidthLatin,
  isMathAlphanumeric,
  confusableSkeleton,
} from './confusables.js'

// Typosquat detector (SMI-595)
export {
  BRAND_ALIASES,
  levenshteinDistance,
  scanTyposquat,
  detectTyposquat,
  applyTyposquatEnforcementMode,
  resolveTyposquatEnforcementMode,
  DEFAULT_TYPOSQUAT_ENFORCEMENT_MODE,
} from './typosquat.js'

// Typosquat reference-name list builder (SMI-595)
export {
  buildTyposquatReferenceList,
  DEFAULT_TOP_INSTALLED_LIMIT,
} from './typosquat-reference-list.js'
export type {
  ReferenceSkillEntry,
  InstalledSkillEntry,
  BuildTyposquatReferenceListOptions,
} from './typosquat-reference-list.js'

// describeSignals (SMI-595, for testing/extending)
export { describeSignals } from './SecurityScanner.formatters.js'

// Main class
export { SecurityScanner, default } from './SecurityScanner.js'

// Hostile-update comparator (SMI-5535, R0 Wave 2A)
export { compareScanReports, DEFAULT_RISK_THRESHOLD } from './SecurityScanner.hostile-update.js'

/**
 * Security Scanner Weights - SMI-685, SMI-1189
 *
 * Weight constants for risk score calculation.
 */

import type { SecuritySeverity } from './types.js'

/**
 * Severity weights for risk score calculation
 */
export const SEVERITY_WEIGHTS: Record<SecuritySeverity, number> = {
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
}

/**
 * Category weights for risk score calculation
 */
export const CATEGORY_WEIGHTS: Record<string, number> = {
  jailbreak: 2.0,
  social_engineering: 1.5,
  prompt_leaking: 1.8,
  data_exfiltration: 1.7,
  privilege_escalation: 1.9,
  suspicious_pattern: 1.3,
  sensitive_path: 1.2,
  url: 0.8,
}

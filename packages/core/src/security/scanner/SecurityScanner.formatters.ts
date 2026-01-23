/**
 * Security Scanner Output Formatters
 * @module @skillsmith/core/security/scanner/SecurityScanner.formatters
 */

import type { ScanReport } from './types.js'

// ============================================================================
// Output Formatters
// ============================================================================

/**
 * SMI-1454: Generate minimal refs output for CI/CD integration
 * Outputs findings in a compact, machine-readable format suitable for:
 * - GitHub Actions annotations
 * - IDE problem matchers
 * - CI pipeline integration
 *
 * @param report - The scan report to format
 * @returns Array of minimal ref strings in format "file:line:severity:message"
 */
export function toMinimalRefs(report: ScanReport): string[] {
  return report.findings.map((finding) => {
    const line = finding.lineNumber ?? 0
    const severity = finding.severity.toUpperCase()
    const message = finding.message.replace(/"/g, '\\"')
    // Format: skill_id:line:severity:type:message
    return `${report.skillId}:${line}:${severity}:${finding.type}:${message}`
  })
}

/**
 * SMI-1454: Generate SARIF (Static Analysis Results Interchange Format) output
 * For integration with GitHub Code Scanning and other SARIF consumers
 *
 * @param report - The scan report to format
 * @returns SARIF v2.1.0 compliant output object
 */
export function toSARIF(report: ScanReport): object {
  const rules = [
    { id: 'jailbreak', name: 'Jailbreak Attempt', severity: 'error' },
    { id: 'social_engineering', name: 'Social Engineering', severity: 'warning' },
    { id: 'prompt_leaking', name: 'Prompt Leaking', severity: 'error' },
    { id: 'data_exfiltration', name: 'Data Exfiltration', severity: 'warning' },
    { id: 'privilege_escalation', name: 'Privilege Escalation', severity: 'error' },
    { id: 'suspicious_pattern', name: 'Suspicious Pattern', severity: 'warning' },
    { id: 'sensitive_path', name: 'Sensitive Path', severity: 'warning' },
    { id: 'url', name: 'External URL', severity: 'note' },
    { id: 'ai_defence', name: 'AI Injection', severity: 'error' },
  ]

  const severityToLevel: Record<string, string> = {
    critical: 'error',
    high: 'error',
    medium: 'warning',
    low: 'note',
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Skillsmith Security Scanner',
            version: '1.0.0',
            informationUri: 'https://github.com/smith-horn/skillsmith',
            rules: rules.map((rule) => ({
              id: rule.id,
              name: rule.name,
              shortDescription: { text: rule.name },
              defaultConfiguration: { level: rule.severity },
            })),
          },
        },
        results: report.findings.map((finding) => ({
          ruleId: finding.type,
          level: severityToLevel[finding.severity] ?? 'warning',
          message: { text: finding.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: report.skillId },
                region: {
                  startLine: finding.lineNumber ?? 1,
                  snippet: finding.location ? { text: finding.location } : undefined,
                },
              },
            },
          ],
          properties: {
            confidence: finding.confidence ?? 'high',
            inDocumentationContext: finding.inDocumentationContext ?? false,
          },
        })),
        invocations: [
          {
            executionSuccessful: true,
            endTimeUtc: report.scannedAt.toISOString(),
          },
        ],
      },
    ],
  }
}

/**
 * SMI-1454: Generate GitHub Actions annotations format
 * Outputs findings as GitHub Actions workflow commands for inline annotations
 *
 * @param report - The scan report to format
 * @returns Array of GitHub Actions annotation strings
 */
export function toGitHubAnnotations(report: ScanReport): string[] {
  return report.findings.map((finding) => {
    const severity =
      finding.severity === 'critical' || finding.severity === 'high' ? 'error' : 'warning'
    const line = finding.lineNumber ?? 1
    const message = finding.message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
    return `::${severity} file=${report.skillId},line=${line}::${message}`
  })
}

/**
 * SMI-1454: Generate summary statistics
 * Returns a compact summary object for dashboards and reports
 *
 * @param report - The scan report to summarize
 * @returns Summary object with counts by severity and type
 */
export function toSummary(report: ScanReport): {
  skillId: string
  passed: boolean
  riskScore: number
  totalFindings: number
  bySeverity: Record<string, number>
  byType: Record<string, number>
  scanDurationMs: number
} {
  const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  const byType: Record<string, number> = {}

  for (const finding of report.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1
    byType[finding.type] = (byType[finding.type] || 0) + 1
  }

  return {
    skillId: report.skillId,
    passed: report.passed,
    riskScore: report.riskScore,
    totalFindings: report.findings.length,
    bySeverity,
    byType,
    scanDurationMs: report.scanDurationMs,
  }
}

/**
 * Markdown formatter for generate-optimization-report.
 *
 * Extracted from generate-optimization-report.ts to keep the main file
 * under the 500-line pre-commit cap.
 */

import type { OptimizationReport } from './generate-optimization-report.types.ts'

export function formatMarkdownReport(report: OptimizationReport): string {
  const lines: string[] = []

  lines.push('# Skillsmith Optimization Validation Report')
  lines.push('')
  lines.push('> Comprehensive validation of predicted vs actual optimization gains')
  lines.push('> For Claude Flow team review')
  lines.push('')

  // Metadata
  lines.push('## Report Metadata')
  lines.push('')
  lines.push(`- **Generated:** ${report.metadata.generatedAt}`)
  lines.push(`- **Project Version:** ${report.metadata.projectVersion}`)
  lines.push(`- **Node.js:** ${report.metadata.nodeVersion}`)
  lines.push('')

  // Executive Summary
  lines.push('## Executive Summary')
  lines.push('')
  lines.push('| Category | Key Metric | Status |')
  lines.push('|----------|------------|--------|')
  lines.push(
    `| File Size Reduction | ${report.fileSizeReduction.summary.avgReductionPercent}% avg across ${report.fileSizeReduction.summary.totalFilesReduced} files | ✅ |`
  )

  if (report.transformationValidation.results.length > 0) {
    const validStatus = report.transformationValidation.summary.allValid ? '✅' : '⚠️'
    lines.push(
      `| Transformation Prediction | ${report.transformationValidation.summary.avgPredictedReduction}% avg predicted | ${validStatus} |`
    )
  }

  if (report.abTests) {
    const abStatus = report.abTests.summary.withinTolerancePercent >= 70 ? '✅' : '⚠️'
    lines.push(`| A/B Test Variance | ${report.abTests.summary.avgVariance}% avg | ${abStatus} |`)
  }

  lines.push('')

  // File Size Reduction
  lines.push('## File Size Reduction (SMI-1686)')
  lines.push('')
  lines.push('| Wave | Files | Before (avg) | After (avg) | Reduction |')
  lines.push('|------|-------|--------------|-------------|-----------|')

  for (const wave of report.fileSizeReduction.waves) {
    lines.push(
      `| Wave ${wave.wave} | ${wave.files} | ${wave.beforeAvgLines} lines | ${wave.afterAvgLines} lines | ${wave.reductionPercent}% |`
    )
  }

  lines.push('')
  lines.push(`**Total:** ${report.fileSizeReduction.summary.totalFilesReduced} files reduced, `)
  lines.push(`${report.fileSizeReduction.summary.newModulesCreated} new module files created`)
  lines.push('')

  // Transformation Validation
  if (report.transformationValidation.results.length > 0) {
    lines.push('## Transformation Prediction Validation')
    lines.push('')
    lines.push('| Skill | Original | Optimized | Line Δ | Token Pred | Sub-skills | Valid |')
    lines.push('|-------|----------|-----------|--------|------------|------------|-------|')

    for (const result of report.transformationValidation.results) {
      const status = result.valid ? '✅' : '❌'
      lines.push(
        `| ${result.skillName} | ${result.originalLines} | ${result.optimizedLines} | -${result.lineReductionPercent}% | ${result.predictedTokenReduction}% | ${result.subSkillCount} | ${status} |`
      )
    }

    lines.push('')
  }

  // A/B Tests
  if (report.abTests && report.abTests.results.length > 0) {
    lines.push('## A/B Test Results (Predicted vs Actual)')
    lines.push('')
    lines.push('| Skill | Predicted | Actual | Variance | Within Tolerance |')
    lines.push('|-------|-----------|--------|----------|------------------|')

    for (const result of report.abTests.results) {
      const status = result.withinTolerance ? '✅' : '❌'
      const variance = result.variance > 0 ? `+${result.variance}%` : `${result.variance}%`
      lines.push(
        `| ${result.skillName} | ${result.predictedReduction}% | ${result.actualReduction}% | ${variance} | ${status} |`
      )
    }

    lines.push('')
    lines.push(
      `**Tolerance Rate:** ${report.abTests.summary.withinTolerancePercent}% within ±15% tolerance`
    )
    lines.push('')
  }

  // Conclusions
  lines.push('## Analysis & Recommendations')
  lines.push('')
  lines.push(`**Confidence Level:** ${report.conclusions.overallConfidence.toUpperCase()}`)
  lines.push('')
  lines.push('### Predicted vs Actual Analysis')
  lines.push('')
  lines.push(report.conclusions.predictedVsActualAnalysis)
  lines.push('')
  lines.push('### Recommendations')
  lines.push('')

  for (const rec of report.conclusions.recommendations) {
    lines.push(`- ${rec}`)
  }

  lines.push('')

  // Methodology
  lines.push('## Methodology')
  lines.push('')
  lines.push('### File Size Reduction')
  lines.push('- Measured: Line counts before/after SMI-1686 splitting')
  lines.push('- Source: Git history and completion summary')
  lines.push('')
  lines.push('### Transformation Predictions')
  lines.push('- Measured: TransformationService output statistics')
  lines.push('- Validates: Line reduction, token prediction bounds, structure validity')
  lines.push('- Script: `scripts/validate-predictions.ts`')
  lines.push('')
  lines.push('### A/B Tests (if available)')
  lines.push('- Measured: Actual Claude Code token consumption via `claude --cost`')
  lines.push('- Method: Identical prompts run against original vs optimized skills')
  lines.push('- Script: `scripts/transformation-ab-test.ts`')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('*Generated by Skillsmith Optimization Report Generator*')
  lines.push(`*Report ID: ${Date.now().toString(36)}*`)

  return lines.join('\n')
}

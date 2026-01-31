#!/usr/bin/env npx tsx
/**
 * Optimization Validation Report Generator
 *
 * Generates a comprehensive report combining:
 * - SMI-1686 file size reduction results (from git history)
 * - V3 migration benchmarks
 * - Transformation prediction validation
 * - A/B test results (if available)
 *
 * Output: Shareable report for Claude Flow team
 *
 * Usage:
 *   npx tsx scripts/generate-optimization-report.ts
 *   npx tsx scripts/generate-optimization-report.ts --include-ab-tests
 *   npx tsx scripts/generate-optimization-report.ts --json
 *
 * Docker:
 *   docker exec skillsmith-dev-1 npx tsx scripts/generate-optimization-report.ts
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================
// Types
// ============================================================================

interface FileSizeReduction {
  wave: number
  files: number
  beforeAvgLines: number
  afterAvgLines: number
  reductionPercent: number
}

interface V3BenchmarkResult {
  name: string
  v2BaselineMs: number
  v3ResultMs: number
  speedup: number
  targetSpeedup: number
  passed: boolean
}

interface TransformationValidation {
  skillName: string
  originalLines: number
  optimizedLines: number
  lineReductionPercent: number
  predictedTokenReduction: number
  subSkillCount: number
  valid: boolean
}

interface ABTestSummary {
  skillName: string
  predictedReduction: number
  actualReduction: number
  variance: number
  withinTolerance: boolean
}

interface OptimizationReport {
  metadata: {
    generatedAt: string
    generatedBy: string
    projectVersion: string
    nodeVersion: string
  }
  fileSizeReduction: {
    summary: {
      totalFilesReduced: number
      avgReductionPercent: number
      newModulesCreated: number
    }
    waves: FileSizeReduction[]
  }
  v3Performance: {
    summary: {
      totalBenchmarks: number
      passed: number
      avgSpeedup: number
    }
    results: V3BenchmarkResult[]
  }
  transformationValidation: {
    summary: {
      skillsValidated: number
      avgPredictedReduction: number
      avgLineReduction: number
      allValid: boolean
    }
    results: TransformationValidation[]
  }
  abTests?: {
    summary: {
      testsRun: number
      avgVariance: number
      withinTolerancePercent: number
    }
    results: ABTestSummary[]
  }
  conclusions: {
    predictedVsActualAnalysis: string
    recommendations: string[]
    overallConfidence: 'high' | 'medium' | 'low'
  }
}

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

// SMI-1686 results (from docs/execution/smi-1686-file-size-reduction-plan.md)
const SMI_1686_RESULTS: FileSizeReduction[] = [
  { wave: 1, files: 3, beforeAvgLines: 1295, afterAvgLines: 485, reductionPercent: 63 },
  { wave: 2, files: 5, beforeAvgLines: 868, afterAvgLines: 377, reductionPercent: 57 },
  { wave: 3.1, files: 3, beforeAvgLines: 738, afterAvgLines: 425, reductionPercent: 42 },
  { wave: 3.2, files: 5, beforeAvgLines: 640, afterAvgLines: 333, reductionPercent: 48 },
]

// ============================================================================
// Data Collection Functions
// ============================================================================

function getProjectVersion(): string {
  try {
    const pkgPath = join(PROJECT_ROOT, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version || 'unknown'
  } catch {
    return 'unknown'
  }
}

function runV3Benchmarks(): V3BenchmarkResult[] {
  try {
    const output = execSync(
      'docker exec skillsmith-dev-1 npx tsx scripts/benchmark-v3-migration.ts --json 2>/dev/null',
      { encoding: 'utf-8', timeout: 120000 }
    )

    // Parse JSON output
    const jsonMatch = output.match(/\{[\s\S]*"results"[\s\S]*\}/)
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0])
      return data.results.map((r: Record<string, unknown>) => ({
        name: r.name,
        v2BaselineMs: r.v2_baseline_ms,
        v3ResultMs: r.v3_result_ms,
        speedup: r.speedup,
        targetSpeedup: r.target_speedup,
        passed: r.passed,
      }))
    }
  } catch (err) {
    console.warn('Could not run V3 benchmarks:', err instanceof Error ? err.message : err)
  }

  return []
}

function runPredictionValidation(): TransformationValidation[] {
  try {
    const output = execSync(
      'docker exec skillsmith-dev-1 npx tsx scripts/validate-predictions.ts --all --json 2>/dev/null',
      { encoding: 'utf-8', timeout: 60000 }
    )

    // Parse JSON output
    const jsonMatch = output.match(/\{[\s\S]*"results"[\s\S]*\}/)
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0])
      return data.results.map((r: Record<string, unknown>) => ({
        skillName: r.skillName,
        originalLines: (r.metrics as Record<string, number>).originalLines,
        optimizedLines: (r.metrics as Record<string, number>).optimizedLines,
        lineReductionPercent: (r.metrics as Record<string, number>).lineReductionPercent,
        predictedTokenReduction: (r.metrics as Record<string, number>).predictedTokenReduction,
        subSkillCount: (r.metrics as Record<string, number>).subSkillCount,
        valid: r.valid,
      }))
    }
  } catch (err) {
    console.warn('Could not run prediction validation:', err instanceof Error ? err.message : err)
  }

  return []
}

function loadABTestResults(): ABTestSummary[] {
  const reportsDir = join(PROJECT_ROOT, 'reports')
  const results: ABTestSummary[] = []

  if (!existsSync(reportsDir)) {
    return results
  }

  const files = readdirSync(reportsDir).filter(
    (f) => f.startsWith('ab-test-') && f.endsWith('.json')
  )

  for (const file of files) {
    try {
      const content = readFileSync(join(reportsDir, file), 'utf-8')
      const data = JSON.parse(content)

      results.push({
        skillName: data.metadata?.skillName || data.skillName || 'unknown',
        predictedReduction:
          data.prediction?.tokenReductionPercent || data.predicted?.tokenReductionPercent || 0,
        actualReduction:
          data.comparison?.tokenReductionPercent || data.actual?.tokenReductionPercent || 0,
        variance: data.comparison?.predictionVariance || data.variance?.tokenReduction || 0,
        withinTolerance:
          data.comparison?.withinTolerance ?? data.variance?.withinTolerance ?? false,
      })
    } catch {
      // Skip invalid files
    }
  }

  return results
}

// ============================================================================
// Analysis Functions
// ============================================================================

function analyzeResults(
  fileSizeReductions: FileSizeReduction[],
  v3Results: V3BenchmarkResult[],
  validationResults: TransformationValidation[],
  abResults: ABTestSummary[]
): OptimizationReport['conclusions'] {
  const recommendations: string[] = []
  let confidence: 'high' | 'medium' | 'low' = 'high'

  // Analyze file size reduction
  const avgFileReduction =
    fileSizeReductions.reduce((sum, w) => sum + w.reductionPercent, 0) / fileSizeReductions.length
  if (avgFileReduction < 40) {
    recommendations.push('File size reduction below 40% - consider more aggressive decomposition')
    confidence = 'medium'
  }

  // Analyze V3 performance
  const v3PassRate =
    v3Results.length > 0 ? v3Results.filter((r) => r.passed).length / v3Results.length : 0
  if (v3PassRate < 0.8) {
    recommendations.push('V3 performance targets not fully met - investigate bottlenecks')
    confidence = 'medium'
  }

  // Analyze prediction accuracy
  if (abResults.length > 0) {
    const avgVariance =
      abResults.reduce((sum, r) => sum + Math.abs(r.variance), 0) / abResults.length
    const toleranceRate = abResults.filter((r) => r.withinTolerance).length / abResults.length

    if (avgVariance > 20) {
      recommendations.push(
        'High prediction variance - consider recalibrating TransformationService formulas'
      )
      confidence = 'low'
    } else if (toleranceRate < 0.7) {
      recommendations.push('Prediction accuracy below 70% - validate formula assumptions')
      confidence = 'medium'
    }
  } else {
    recommendations.push(
      'No A/B test data available - run transformation-ab-test.ts for actual measurements'
    )
    if (confidence === 'high') confidence = 'medium'
  }

  // Analyze validation results
  const validationPassRate =
    validationResults.length > 0
      ? validationResults.filter((r) => r.valid).length / validationResults.length
      : 0
  if (validationPassRate < 1) {
    recommendations.push('Some skills failed validation - review transformation logic')
    if (confidence === 'high') confidence = 'medium'
  }

  // Build analysis summary
  let analysisText = ''

  if (abResults.length > 0) {
    const avgActual = abResults.reduce((sum, r) => sum + r.actualReduction, 0) / abResults.length
    const avgPredicted =
      abResults.reduce((sum, r) => sum + r.predictedReduction, 0) / abResults.length

    if (avgActual >= avgPredicted * 0.85) {
      analysisText = `Predictions are VALIDATED. Actual token reduction (${avgActual.toFixed(1)}%) meets or exceeds 85% of predictions (${avgPredicted.toFixed(1)}%).`
    } else if (avgActual >= avgPredicted * 0.7) {
      analysisText = `Predictions are PARTIALLY VALIDATED. Actual reduction (${avgActual.toFixed(1)}%) is within 70-85% of predictions (${avgPredicted.toFixed(1)}%).`
    } else {
      analysisText = `Predictions require RECALIBRATION. Actual reduction (${avgActual.toFixed(1)}%) is significantly below predictions (${avgPredicted.toFixed(1)}%).`
    }
  } else {
    analysisText =
      'Cannot fully validate predictions without A/B test data. File size metrics show ~53% average reduction, ' +
      'and TransformationService predicts proportional token savings. Run A/B tests to measure actual Claude Code token consumption.'
  }

  if (recommendations.length === 0) {
    recommendations.push('All metrics within expected ranges - no immediate action required')
  }

  return {
    predictedVsActualAnalysis: analysisText,
    recommendations,
    overallConfidence: confidence,
  }
}

// ============================================================================
// Report Generation
// ============================================================================

function generateReport(includeABTests: boolean): OptimizationReport {
  console.log('Collecting data...')

  // File size reduction (static from SMI-1686)
  const fileSizeReductions = SMI_1686_RESULTS
  const totalFilesReduced = fileSizeReductions.reduce((sum, w) => sum + w.files, 0)
  const avgReduction =
    fileSizeReductions.reduce((sum, w) => sum + w.reductionPercent, 0) / fileSizeReductions.length

  // V3 benchmarks
  console.log('  Running V3 benchmarks...')
  const v3Results = runV3Benchmarks()

  // Transformation validation
  console.log('  Running prediction validation...')
  const validationResults = runPredictionValidation()

  // A/B tests (optional)
  let abResults: ABTestSummary[] = []
  if (includeABTests) {
    console.log('  Loading A/B test results...')
    abResults = loadABTestResults()
  }

  // Analyze and generate conclusions
  console.log('  Analyzing results...')
  const conclusions = analyzeResults(fileSizeReductions, v3Results, validationResults, abResults)

  const report: OptimizationReport = {
    metadata: {
      generatedAt: new Date().toISOString(),
      generatedBy: 'Skillsmith Optimization Report Generator',
      projectVersion: getProjectVersion(),
      nodeVersion: process.version,
    },
    fileSizeReduction: {
      summary: {
        totalFilesReduced,
        avgReductionPercent: Math.round(avgReduction),
        newModulesCreated: 31, // From SMI-1686 completion summary
      },
      waves: fileSizeReductions,
    },
    v3Performance: {
      summary: {
        totalBenchmarks: v3Results.length,
        passed: v3Results.filter((r) => r.passed).length,
        avgSpeedup:
          v3Results.length > 0
            ? Math.round(v3Results.reduce((sum, r) => sum + r.speedup, 0) / v3Results.length)
            : 0,
      },
      results: v3Results,
    },
    transformationValidation: {
      summary: {
        skillsValidated: validationResults.length,
        avgPredictedReduction:
          validationResults.length > 0
            ? Math.round(
                validationResults.reduce((sum, r) => sum + r.predictedTokenReduction, 0) /
                  validationResults.length
              )
            : 0,
        avgLineReduction:
          validationResults.length > 0
            ? Math.round(
                validationResults.reduce((sum, r) => sum + r.lineReductionPercent, 0) /
                  validationResults.length
              )
            : 0,
        allValid: validationResults.every((r) => r.valid),
      },
      results: validationResults,
    },
    conclusions,
  }

  if (abResults.length > 0) {
    report.abTests = {
      summary: {
        testsRun: abResults.length,
        avgVariance:
          Math.round(
            (abResults.reduce((sum, r) => sum + Math.abs(r.variance), 0) / abResults.length) * 10
          ) / 10,
        withinTolerancePercent: Math.round(
          (abResults.filter((r) => r.withinTolerance).length / abResults.length) * 100
        ),
      },
      results: abResults,
    }
  }

  return report
}

function formatMarkdownReport(report: OptimizationReport): string {
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

  if (report.v3Performance.results.length > 0) {
    const v3Status =
      report.v3Performance.summary.passed === report.v3Performance.summary.totalBenchmarks
        ? '✅'
        : '⚠️'
    lines.push(
      `| V3 Performance | ${report.v3Performance.summary.avgSpeedup}x avg speedup | ${v3Status} |`
    )
  }

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

  // V3 Performance
  if (report.v3Performance.results.length > 0) {
    lines.push('## V3 Migration Performance')
    lines.push('')
    lines.push('| Operation | V2 Baseline | V3 Result | Speedup | Target | Status |')
    lines.push('|-----------|-------------|-----------|---------|--------|--------|')

    for (const result of report.v3Performance.results) {
      const status = result.passed ? '✅' : '❌'
      const speedup =
        result.speedup >= 100 ? `${Math.round(result.speedup)}x` : `${result.speedup.toFixed(1)}x`
      lines.push(
        `| ${result.name} | ${result.v2BaselineMs}ms | ${result.v3ResultMs.toFixed(2)}ms | ${speedup} | ${result.targetSpeedup}x | ${status} |`
      )
    }

    lines.push('')
  }

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
  lines.push('### V3 Performance')
  lines.push('- Measured: Memory operations, embedding search, recommendation pipeline')
  lines.push('- Method: 100 iterations with 10 warmup, median timing')
  lines.push('- Script: `scripts/benchmark-v3-migration.ts`')
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

// ============================================================================
// CLI
// ============================================================================

interface CLIOptions {
  includeABTests: boolean
  json: boolean
  outputPath?: string
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2)

  const options: CLIOptions = {
    includeABTests: true,
    json: false,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--include-ab-tests':
        options.includeABTests = true
        break
      case '--no-ab-tests':
        options.includeABTests = false
        break
      case '--json':
        options.json = true
        break
      case '--output':
      case '-o':
        options.outputPath = args[++i]
        break
      case '--help':
      case '-h':
        console.log(`
Skillsmith Optimization Validation Report Generator

Generates a comprehensive report combining all optimization metrics.

Usage:
  npx tsx scripts/generate-optimization-report.ts [options]

Options:
  --include-ab-tests     Include A/B test results (default: true)
  --no-ab-tests          Exclude A/B test results
  --json                 Output as JSON instead of markdown
  --output, -o <path>    Custom output path
  --help, -h             Show this help

Examples:
  npx tsx scripts/generate-optimization-report.ts
  npx tsx scripts/generate-optimization-report.ts --json
  npx tsx scripts/generate-optimization-report.ts --output reports/custom-report.md

Docker:
  docker exec skillsmith-dev-1 npx tsx scripts/generate-optimization-report.ts
`)
        process.exit(0)
    }
  }

  return options
}

async function main(): Promise<void> {
  const options = parseArgs()

  console.log('╔═══════════════════════════════════════════════════════════════╗')
  console.log('║      Skillsmith Optimization Validation Report Generator      ║')
  console.log('╚═══════════════════════════════════════════════════════════════╝')
  console.log('')

  const report = generateReport(options.includeABTests)

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('')

  const output = options.json ? JSON.stringify(report, null, 2) : formatMarkdownReport(report)
  console.log(output)

  // Save to file
  const dateStr = new Date().toISOString().split('T')[0]
  const ext = options.json ? 'json' : 'md'
  const defaultPath = join(PROJECT_ROOT, 'reports', `optimization-validation-${dateStr}.${ext}`)
  const outputPath = options.outputPath || defaultPath

  writeFileSync(outputPath, output)
  console.log('')
  console.log(`Report saved to: ${outputPath}`)
}

main().catch((err) => {
  console.error('Report generation failed:', err)
  process.exit(1)
})

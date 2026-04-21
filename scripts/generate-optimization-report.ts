#!/usr/bin/env npx tsx
/**
 * Optimization Validation Report Generator
 *
 * Generates a comprehensive report combining:
 * - SMI-1686 file size reduction results (from git history)
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

import { formatMarkdownReport } from './generate-optimization-report.formatters.ts'
import {
  type ABTestSummary,
  type FileSizeReduction,
  type OptimizationReport,
  SMI_1686_RESULTS,
  type TransformationValidation,
} from './generate-optimization-report.types.ts'

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

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
  const conclusions = analyzeResults(fileSizeReductions, validationResults, abResults)

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

/**
 * SMI-1189: Scanner
 *
 * Main scanning logic for imported skills.
 */

import * as path from 'path'
import { SecurityScanner } from '../../security/index.js'
import type {
  ImportedSkill,
  SkillScanResult,
  FindingWithContext,
  ScannerCliOptions,
  JsonOutput,
} from './types.js'
import {
  shouldQuarantine,
  getPassFailStats,
  calculateAverageRiskScore,
  calculateMaxRiskScore,
  type TrustScorerConfig,
  DEFAULT_TRUST_CONFIG,
} from './trust-scorer.js'
import { determineSeverityCategory, countBySeverity } from './categorizer.js'
import {
  extractScannableContent,
  readImportedSkills,
  ensureDirectoryExists,
  fileExists,
  writeJsonFile,
} from './file-scanner.js'
import {
  formatDuration,
  logHeader,
  logFindings,
  logProgress,
  logCompletion,
  logFileOutput,
  logScanStart,
  logProgressBar,
  clearProgressLine,
  logQuarantineTable,
  logCategorizedResults,
} from './logger.js'
import {
  logSummary,
  generateSecurityReport,
  generateQuarantineOutput,
  generateSafeSkillsOutput,
  logRecommendations,
} from './reporter.js'

/**
 * Scanner configuration
 */
export interface ScannerConfig {
  /** Default input file path */
  defaultInput: string
  /** Output directory for reports */
  outputDir: string
  /** Scanner options */
  scannerOptions: {
    riskThreshold: number
  }
  /** Trust scorer config */
  trustConfig: TrustScorerConfig
  /** Progress logging interval */
  progressInterval: number
}

/** Default scanner configuration */
export const DEFAULT_CONFIG: ScannerConfig = {
  defaultInput: './data/imported-skills.json',
  outputDir: './data',
  scannerOptions: {
    riskThreshold: 40,
  },
  trustConfig: DEFAULT_TRUST_CONFIG,
  progressInterval: 100,
}

/**
 * Scan a single skill and return the result
 *
 * @param skill - The skill to scan
 * @param scanner - The security scanner instance
 * @param config - Trust scorer configuration
 * @returns The scan result
 */
export function scanSkill(
  skill: ImportedSkill,
  scanner: SecurityScanner,
  config: TrustScorerConfig = DEFAULT_TRUST_CONFIG
): SkillScanResult {
  const content = extractScannableContent(skill)
  const report = scanner.scan(skill.id, content)
  const isQuarantined = shouldQuarantine(report, config)
  const severityCategory = determineSeverityCategory(report.findings)

  return {
    skillId: skill.id,
    skillName: skill.name,
    author: skill.author || 'unknown',
    source: skill.source || 'unknown',
    scanReport: report,
    severityCategory,
    isQuarantined,
    scanTimestamp: new Date().toISOString(),
  }
}

/** Default CLI options */
export const DEFAULT_CLI_OPTIONS: ScannerCliOptions = {
  json: false,
  verbose: false,
  quiet: false,
  inputPath: DEFAULT_CONFIG.defaultInput,
}

/**
 * Generate JSON output for machine-readable format
 */
function generateJsonOutput(
  results: SkillScanResult[],
  config: ScannerConfig,
  durationMs: number
): JsonOutput {
  const { passed, quarantined: quarantinedCount } = getPassFailStats(results)
  const bySeverity = countBySeverity(results)
  const avgRiskScore = calculateAverageRiskScore(results)
  const maxRiskScore = calculateMaxRiskScore(results)

  const quarantinedSkills = results
    .filter((r) => r.isQuarantined)
    .sort((a, b) => b.scanReport.riskScore - a.scanReport.riskScore)
    .map((r) => ({
      skillId: r.skillId,
      riskScore: r.scanReport.riskScore,
      severity: r.severityCategory,
      topFinding:
        r.scanReport.findings.length > 0
          ? `${r.scanReport.findings[0].type}: ${r.scanReport.findings[0].message}`
          : 'N/A',
    }))

  const safeSkills = results
    .filter((r) => !r.isQuarantined)
    .sort((a, b) => a.scanReport.riskScore - b.scanReport.riskScore)
    .map((r) => ({
      skillId: r.skillId,
      riskScore: r.scanReport.riskScore,
    }))

  return {
    success: true,
    summary: {
      totalScanned: results.length,
      passed,
      quarantined: quarantinedCount,
      bySeverity,
      averageRiskScore: Math.round(avgRiskScore * 100) / 100,
      maxRiskScore,
      duration: Math.round(durationMs),
      skillsPerSecond: Math.round((results.length / durationMs) * 1000 * 10) / 10,
    },
    quarantined: quarantinedSkills,
    safe: safeSkills,
    outputFiles: {
      report: path.join(config.outputDir, 'security-report.json'),
      quarantine: path.join(config.outputDir, 'quarantine-skills.json'),
      safe: path.join(config.outputDir, 'safe-skills.json'),
    },
  }
}

/**
 * Scan all imported skills
 *
 * @param inputPath - Path to the imported skills JSON file
 * @param config - Scanner configuration
 * @param cliOptions - CLI options for output control
 */
export async function scanImportedSkills(
  inputPath: string,
  config: ScannerConfig = DEFAULT_CONFIG,
  cliOptions: Partial<ScannerCliOptions> = {}
): Promise<void> {
  const options = { ...DEFAULT_CLI_OPTIONS, ...cliOptions, inputPath }
  const startTime = performance.now()

  // Validate input file exists (always check, regardless of output mode)
  if (!fileExists(inputPath)) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: `Input file not found: ${inputPath}` }))
    } else {
      console.error(`Error: Input file not found: ${inputPath}`)
      console.error(
        'Usage: npx tsx packages/core/src/scripts/scan-imported-skills.ts [options] [path-to-imported-skills.json]'
      )
      console.error('\nOptions:')
      console.error('  --json      Output results in JSON format (machine-readable)')
      console.error('  --verbose   Show detailed output')
      console.error('  --quiet     Minimal output')
    }
    process.exit(1)
  }

  // Ensure output directory exists
  ensureDirectoryExists(config.outputDir)

  // Read and parse imported skills
  let skills: ImportedSkill[]
  try {
    skills = await readImportedSkills(inputPath)
  } catch (error) {
    if (options.json) {
      console.log(
        JSON.stringify({
          success: false,
          error: `Failed to read input: ${(error as Error).message}`,
        })
      )
    } else {
      console.error(`Error reading/parsing input file: ${(error as Error).message}`)
    }
    process.exit(1)
  }

  // For JSON output, skip all console logging until the end
  if (!options.json && !options.quiet) {
    logScanStart(skills.length, inputPath, config.outputDir)
  }

  // Initialize scanner
  const scanner = new SecurityScanner(config.scannerOptions)

  // Scan all skills
  const results: SkillScanResult[] = []
  const allFindings: FindingWithContext[] = []
  let processedCount = 0

  // Use progress bar for interactive output
  const useProgressBar = !options.json && !options.quiet && process.stdout.isTTY

  for (const skill of skills) {
    processedCount++

    const result = scanSkill(skill, scanner, config.trustConfig)
    results.push(result)

    // Collect findings with skill context
    for (const finding of result.scanReport.findings) {
      allFindings.push({ ...finding, skillId: skill.id })
    }

    // Log progress
    if (useProgressBar) {
      logProgressBar(processedCount, skills.length, true)
    } else if (!options.json && !options.quiet && processedCount % config.progressInterval === 0) {
      logProgress(processedCount, skills.length)
    }
  }

  // Clear progress bar line
  if (useProgressBar) {
    clearProgressLine()
  }

  if (!options.json && !options.quiet) {
    logCompletion(processedCount, skills.length)
  }

  // Log critical and high findings (if not JSON mode)
  const criticalFindings = allFindings.filter((f) => f.severity === 'critical')
  const highFindings = allFindings.filter((f) => f.severity === 'high')

  if (!options.json && !options.quiet) {
    logFindings(criticalFindings, 20, 'CRITICAL FINDINGS')
    logFindings(highFindings, 10, 'HIGH SEVERITY FINDINGS')
  }

  // Print categorized results
  if (!options.json && !options.quiet) {
    logCategorizedResults(results)
  }

  // Print quarantine table (if not JSON mode)
  if (!options.json && !options.quiet) {
    logHeader('QUARANTINED SKILLS')
    logQuarantineTable(results)
  }

  // Print summary
  if (!options.json && !options.quiet) {
    logSummary(results)
  }

  // Generate output files
  if (!options.json && !options.quiet) {
    console.log('Generating output files...\n')
  }

  // 1. Full security report
  const securityReport = generateSecurityReport(results, allFindings, inputPath)
  const reportPath = path.join(config.outputDir, 'security-report.json')
  await writeJsonFile(reportPath, securityReport)
  if (!options.json && !options.quiet) {
    logFileOutput('security-report.json', results.length)
  }

  // 2. Quarantine list
  const quarantineOutput = generateQuarantineOutput(results)
  const quarantinePath = path.join(config.outputDir, 'quarantine-skills.json')
  await writeJsonFile(quarantinePath, quarantineOutput)
  if (!options.json && !options.quiet) {
    logFileOutput('quarantine-skills.json', quarantineOutput.count, 'blocked')
  }

  // 3. Safe skills list
  const safeOutput = generateSafeSkillsOutput(results)
  const safePath = path.join(config.outputDir, 'safe-skills.json')
  await writeJsonFile(safePath, safeOutput)
  if (!options.json && !options.quiet) {
    logFileOutput('safe-skills.json', safeOutput.count, 'approved')
  }

  // Final timing
  const endTime = performance.now()
  const durationMs = endTime - startTime
  const duration = formatDuration(durationMs)

  // JSON output mode
  if (options.json) {
    const jsonOutput = generateJsonOutput(results, config, durationMs)
    console.log(JSON.stringify(jsonOutput, null, 2))
    return
  }

  // Human-readable completion output
  if (!options.quiet) {
    const border = '═'.repeat(60)
    console.log()
    console.log('\x1b[36m' + border + '\x1b[0m')
    console.log('\x1b[1m                    SCAN COMPLETE\x1b[0m')
    console.log('\x1b[36m' + border + '\x1b[0m')
    console.log()
    console.log(`  Duration:              ${duration}`)
    console.log(`  Skills per second:     ${((results.length / durationMs) * 1000).toFixed(1)}`)
    console.log()
    console.log('  Output files:')
    console.log(`    - ${reportPath}`)
    console.log(`    - ${quarantinePath}`)
    console.log(`    - ${safePath}`)
    console.log()
    console.log('\x1b[36m' + border + '\x1b[0m')
    console.log()

    // Recommendations
    logRecommendations(results, criticalFindings.length)
  }
}

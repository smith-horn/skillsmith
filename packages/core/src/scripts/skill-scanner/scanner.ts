/**
 * SMI-1189: Scanner
 *
 * Main scanning logic for imported skills.
 */

import * as path from 'path'
import { SecurityScanner } from '../../security/index.js'
import type { ImportedSkill, SkillScanResult, FindingWithContext } from './types.js'
import { shouldQuarantine, type TrustScorerConfig, DEFAULT_TRUST_CONFIG } from './trust-scorer.js'
import { determineSeverityCategory } from './categorizer.js'
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

/**
 * Scan all imported skills
 *
 * @param inputPath - Path to the imported skills JSON file
 * @param config - Scanner configuration
 */
export async function scanImportedSkills(
  inputPath: string,
  config: ScannerConfig = DEFAULT_CONFIG
): Promise<void> {
  const startTime = performance.now()

  logHeader('SMI-864: Security Scanner for Imported Skills')
  console.log(`Input file: ${inputPath}`)
  console.log(`Output directory: ${config.outputDir}`)
  console.log()

  // Validate input file exists
  if (!fileExists(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`)
    console.error(
      'Usage: npx tsx packages/core/src/scripts/scan-imported-skills.ts [path-to-imported-skills.json]'
    )
    process.exit(1)
  }

  // Ensure output directory exists
  ensureDirectoryExists(config.outputDir)

  // Read and parse imported skills
  console.log('Reading imported skills...')
  let skills: ImportedSkill[]
  try {
    skills = await readImportedSkills(inputPath)
  } catch (error) {
    console.error(`Error reading/parsing input file: ${(error as Error).message}`)
    process.exit(1)
  }

  console.log(`Found ${skills.length} skills to scan\n`)

  // Initialize scanner
  const scanner = new SecurityScanner(config.scannerOptions)

  // Scan all skills
  const results: SkillScanResult[] = []
  const allFindings: FindingWithContext[] = []
  let processedCount = 0

  console.log('Scanning skills...')

  for (const skill of skills) {
    processedCount++

    const result = scanSkill(skill, scanner, config.trustConfig)
    results.push(result)

    // Collect findings with skill context
    for (const finding of result.scanReport.findings) {
      allFindings.push({ ...finding, skillId: skill.id })
    }

    // Log progress
    if (processedCount % config.progressInterval === 0) {
      logProgress(processedCount, skills.length)
    }
  }

  logCompletion(processedCount, skills.length)

  // Log critical and high findings
  const criticalFindings = allFindings.filter((f) => f.severity === 'critical')
  const highFindings = allFindings.filter((f) => f.severity === 'high')

  logFindings(criticalFindings, 20, 'CRITICAL FINDINGS')
  logFindings(highFindings, 10, 'HIGH SEVERITY FINDINGS')

  // Print summary
  logSummary(results)

  // Generate output files
  console.log('Generating output files...\n')

  // 1. Full security report
  const securityReport = generateSecurityReport(results, allFindings, inputPath)
  const reportPath = path.join(config.outputDir, 'security-report.json')
  await writeJsonFile(reportPath, securityReport)
  logFileOutput('security-report.json', results.length)

  // 2. Quarantine list
  const quarantineOutput = generateQuarantineOutput(results)
  const quarantinePath = path.join(config.outputDir, 'quarantine-skills.json')
  await writeJsonFile(quarantinePath, quarantineOutput)
  logFileOutput('quarantine-skills.json', quarantineOutput.count, 'blocked')

  // 3. Safe skills list
  const safeOutput = generateSafeSkillsOutput(results)
  const safePath = path.join(config.outputDir, 'safe-skills.json')
  await writeJsonFile(safePath, safeOutput)
  logFileOutput('safe-skills.json', safeOutput.count, 'approved')

  // Final timing
  const endTime = performance.now()
  const duration = formatDuration(endTime - startTime)

  console.log('\n' + '='.repeat(60))
  console.log('                    SCAN COMPLETE')
  console.log('='.repeat(60))
  console.log(`  Duration:              ${duration}`)
  console.log(
    `  Skills per second:     ${((results.length / (endTime - startTime)) * 1000).toFixed(1)}`
  )
  console.log()
  console.log('  Output files:')
  console.log(`    - ${reportPath}`)
  console.log(`    - ${quarantinePath}`)
  console.log(`    - ${safePath}`)
  console.log('='.repeat(60) + '\n')

  // Recommendations
  logRecommendations(results, criticalFindings.length)
}

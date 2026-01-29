#!/usr/bin/env npx tsx
/**
 * Transformation Prediction Validator
 *
 * Validates TransformationService predictions against measurable file metrics.
 * This script runs WITHOUT Claude Code CLI - useful for CI validation.
 *
 * Validates:
 * - Line count reduction matches prediction formula
 * - Token reduction estimate is within reasonable bounds
 * - Decomposition produces valid skill structure
 *
 * Usage:
 *   npx tsx scripts/validate-predictions.ts
 *   npx tsx scripts/validate-predictions.ts --skill governance
 *   npx tsx scripts/validate-predictions.ts --all --json
 *
 * Docker:
 *   docker exec skillsmith-dev-1 npx tsx scripts/validate-predictions.ts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================
// Types
// ============================================================================

interface ValidationResult {
  skillName: string
  skillPath: string
  valid: boolean
  errors: string[]
  warnings: string[]
  metrics: {
    originalLines: number
    optimizedLines: number
    lineReductionPercent: number
    predictedTokenReduction: number
    subSkillCount: number
    subagentGenerated: boolean
    tasksParallelized: boolean
    transformDurationMs: number
  }
  validation: {
    lineReductionValid: boolean
    tokenPredictionValid: boolean
    structureValid: boolean
    subSkillsValid: boolean
  }
}

interface ValidationReport {
  timestamp: string
  skillsValidated: number
  passed: number
  failed: number
  results: ValidationResult[]
  summary: {
    avgLineReduction: number
    avgTokenPrediction: number
    avgTransformDuration: number
    allPassed: boolean
  }
}

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

// Token reduction formula bounds (from TransformationService analysis)
const TOKEN_REDUCTION_MIN = 0 // No reduction
const TOKEN_REDUCTION_MAX = 80 // Capped at 80%
// Reserved for future use in advanced prediction models:
// const SUBAGENT_BONUS = 20 // Subagent adds 20%
// const BATCH_BONUS_FACTOR = 0.5 // Half of batch savings percent

// ============================================================================
// Utility Functions
// ============================================================================

function countLines(content: string): number {
  return content.split('\n').length
}

function extractFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}

  const frontmatter: Record<string, string> = {}
  const lines = match[1].split('\n')

  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line
        .slice(colonIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
      frontmatter[key] = value
    }
  }

  return frontmatter
}

function validateSkillStructure(content: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Must have frontmatter
  if (!content.startsWith('---')) {
    errors.push('Missing YAML frontmatter')
  }

  // Must have name and description
  const frontmatter = extractFrontmatter(content)
  if (!frontmatter.name) {
    errors.push('Missing "name" in frontmatter')
  }
  if (!frontmatter.description) {
    errors.push('Missing "description" in frontmatter')
  }

  // Must have at least one heading
  if (!content.match(/^#{1,6}\s+.+/m)) {
    errors.push('Missing markdown headings')
  }

  return { valid: errors.length === 0, errors }
}

// ============================================================================
// Transformation Integration
// ============================================================================

interface TransformationResult {
  transformed: boolean
  mainSkillContent: string
  subSkills: Array<{ filename: string; content: string }>
  subagent?: { filename: string; content: string }
  stats: {
    originalLines: number
    optimizedLines: number
    subSkillCount: number
    tasksParallelized: boolean
    subagentGenerated: boolean
    tokenReductionPercent: number
    transformDurationMs: number
  }
  analysis?: {
    taskPatterns?: {
      batchSavingsPercent: number
    }
  }
}

async function loadTransformationService(): Promise<{
  TransformationService: new () => {
    transformWithoutCache: (name: string, desc: string, content: string) => TransformationResult
  }
}> {
  // Try dist first (production), then src (development)
  const distPath = join(PROJECT_ROOT, 'packages/core/dist/services/TransformationService.js')
  const srcPath = join(PROJECT_ROOT, 'packages/core/src/services/TransformationService.ts')

  if (existsSync(distPath)) {
    return import(distPath)
  } else if (existsSync(srcPath)) {
    // For development, use tsx to compile on-the-fly
    return import(srcPath)
  }

  throw new Error('TransformationService not found. Run `npm run build` first.')
}

// ============================================================================
// Validation Logic
// ============================================================================

async function validateSkill(
  skillPath: string,
  TransformationService: new () => {
    transformWithoutCache: (name: string, desc: string, content: string) => TransformationResult
  }
): Promise<ValidationResult> {
  const skillName = skillPath.split('/').slice(-2)[0] // Get skill folder name
  const content = readFileSync(skillPath, 'utf-8')
  const frontmatter = extractFrontmatter(content)

  const result: ValidationResult = {
    skillName,
    skillPath,
    valid: true,
    errors: [],
    warnings: [],
    metrics: {
      originalLines: 0,
      optimizedLines: 0,
      lineReductionPercent: 0,
      predictedTokenReduction: 0,
      subSkillCount: 0,
      subagentGenerated: false,
      tasksParallelized: false,
      transformDurationMs: 0,
    },
    validation: {
      lineReductionValid: true,
      tokenPredictionValid: true,
      structureValid: true,
      subSkillsValid: true,
    },
  }

  // Basic structure validation
  const structureCheck = validateSkillStructure(content)
  if (!structureCheck.valid) {
    result.errors.push(...structureCheck.errors)
    result.validation.structureValid = false
  }

  // Transform the skill
  try {
    const service = new TransformationService()
    const transformResult = service.transformWithoutCache(
      frontmatter.name || skillName,
      frontmatter.description || '',
      content
    )

    result.metrics = {
      originalLines: transformResult.stats.originalLines,
      optimizedLines: transformResult.stats.optimizedLines,
      lineReductionPercent: Math.round(
        ((transformResult.stats.originalLines - transformResult.stats.optimizedLines) /
          transformResult.stats.originalLines) *
          100
      ),
      predictedTokenReduction: transformResult.stats.tokenReductionPercent,
      subSkillCount: transformResult.stats.subSkillCount,
      subagentGenerated: transformResult.stats.subagentGenerated,
      tasksParallelized: transformResult.stats.tasksParallelized,
      transformDurationMs: transformResult.stats.transformDurationMs,
    }

    // Validate token prediction is within bounds
    if (
      transformResult.stats.tokenReductionPercent < TOKEN_REDUCTION_MIN ||
      transformResult.stats.tokenReductionPercent > TOKEN_REDUCTION_MAX
    ) {
      result.errors.push(
        `Token reduction ${transformResult.stats.tokenReductionPercent}% outside valid range [${TOKEN_REDUCTION_MIN}, ${TOKEN_REDUCTION_MAX}]`
      )
      result.validation.tokenPredictionValid = false
    }

    // Validate line reduction makes sense
    if (transformResult.stats.optimizedLines > transformResult.stats.originalLines) {
      result.errors.push(
        `Optimized lines (${transformResult.stats.optimizedLines}) exceeds original (${transformResult.stats.originalLines})`
      )
      result.validation.lineReductionValid = false
    }

    // Validate sub-skills have content
    for (const subSkill of transformResult.subSkills) {
      if (countLines(subSkill.content) < 5) {
        result.warnings.push(
          `Sub-skill ${subSkill.filename} has very few lines (${countLines(subSkill.content)})`
        )
      }

      const subCheck = validateSkillStructure(subSkill.content)
      if (!subCheck.valid) {
        result.errors.push(`Sub-skill ${subSkill.filename}: ${subCheck.errors.join(', ')}`)
        result.validation.subSkillsValid = false
      }
    }

    // Validate subagent if generated
    if (transformResult.subagent) {
      if (countLines(transformResult.subagent.content) < 10) {
        result.warnings.push('Generated subagent has very few lines')
      }
    }

    // Check for expected correlation between features and token reduction
    const expectedMinReduction = transformResult.stats.subSkillCount > 0 ? 10 : 0
    if (transformResult.stats.tokenReductionPercent < expectedMinReduction) {
      result.warnings.push(
        `Token reduction (${transformResult.stats.tokenReductionPercent}%) seems low for ${transformResult.stats.subSkillCount} sub-skills`
      )
    }

    // Warn if subagent was generated but no parallelization detected
    if (transformResult.stats.subagentGenerated && !transformResult.stats.tasksParallelized) {
      result.warnings.push('Subagent generated without task parallelization - may be suboptimal')
    }
  } catch (err) {
    result.errors.push(`Transformation failed: ${err instanceof Error ? err.message : String(err)}`)
    result.valid = false
    return result
  }

  result.valid = result.errors.length === 0
  return result
}

async function discoverSkills(skillsDir: string): Promise<string[]> {
  const skills: string[] = []

  if (!existsSync(skillsDir)) {
    return skills
  }

  const entries = readdirSync(skillsDir)
  for (const entry of entries) {
    const skillPath = join(skillsDir, entry, 'SKILL.md')
    if (existsSync(skillPath)) {
      skills.push(skillPath)
    }
  }

  return skills
}

// ============================================================================
// Report Generation
// ============================================================================

function generateMarkdownReport(report: ValidationReport): string {
  const lines: string[] = []

  lines.push('# Transformation Prediction Validation Report')
  lines.push('')
  lines.push(`**Date:** ${report.timestamp}`)
  lines.push(`**Skills Validated:** ${report.skillsValidated}`)
  lines.push(`**Passed:** ${report.passed}`)
  lines.push(`**Failed:** ${report.failed}`)
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push('| Metric | Average |')
  lines.push('|--------|---------|')
  lines.push(`| Line Reduction | ${report.summary.avgLineReduction.toFixed(1)}% |`)
  lines.push(`| Token Prediction | ${report.summary.avgTokenPrediction.toFixed(1)}% |`)
  lines.push(`| Transform Duration | ${report.summary.avgTransformDuration.toFixed(1)}ms |`)
  lines.push('')

  const status = report.summary.allPassed ? '✅ ALL PASSED' : '❌ SOME FAILED'
  lines.push(`**Overall Status:** ${status}`)
  lines.push('')

  lines.push('## Results by Skill')
  lines.push('')
  lines.push('| Skill | Original | Optimized | Line Δ | Token Pred | Sub-skills | Status |')
  lines.push('|-------|----------|-----------|--------|------------|------------|--------|')

  for (const result of report.results) {
    const status = result.valid ? '✅' : '❌'
    lines.push(
      `| ${result.skillName} | ${result.metrics.originalLines} | ${result.metrics.optimizedLines} | -${result.metrics.lineReductionPercent}% | ${result.metrics.predictedTokenReduction}% | ${result.metrics.subSkillCount} | ${status} |`
    )
  }

  lines.push('')

  // Show errors and warnings
  const failedResults = report.results.filter((r) => !r.valid || r.warnings.length > 0)
  if (failedResults.length > 0) {
    lines.push('## Issues')
    lines.push('')

    for (const result of failedResults) {
      if (result.errors.length > 0 || result.warnings.length > 0) {
        lines.push(`### ${result.skillName}`)
        lines.push('')

        for (const error of result.errors) {
          lines.push(`- ❌ **Error:** ${error}`)
        }
        for (const warning of result.warnings) {
          lines.push(`- ⚠️ **Warning:** ${warning}`)
        }
        lines.push('')
      }
    }
  }

  lines.push('## Validation Criteria')
  lines.push('')
  lines.push('- **Line Reduction Valid:** Optimized lines ≤ original lines')
  lines.push(
    `- **Token Prediction Valid:** Prediction in range [${TOKEN_REDUCTION_MIN}%, ${TOKEN_REDUCTION_MAX}%]`
  )
  lines.push('- **Structure Valid:** Has frontmatter with name/description, has headings')
  lines.push('- **Sub-skills Valid:** Each sub-skill has valid structure')
  lines.push('')
  lines.push('---')
  lines.push('*Generated by Skillsmith Prediction Validator*')

  return lines.join('\n')
}

// ============================================================================
// CLI
// ============================================================================

interface CLIOptions {
  skillName?: string
  skillPath?: string
  all: boolean
  json: boolean
  verbose: boolean
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2)

  const options: CLIOptions = {
    all: false,
    json: false,
    verbose: true,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--skill':
      case '-s':
        options.skillName = args[++i]
        break
      case '--skill-path':
        options.skillPath = args[++i]
        break
      case '--all':
      case '-a':
        options.all = true
        break
      case '--json':
        options.json = true
        break
      case '--quiet':
      case '-q':
        options.verbose = false
        break
      case '--help':
      case '-h':
        console.log(`
Skillsmith Transformation Prediction Validator

Validates TransformationService predictions against file metrics.
Runs without Claude Code CLI - suitable for CI environments.

Usage:
  npx tsx scripts/validate-predictions.ts [options]

Options:
  --skill, -s <name>     Validate specific skill by name
  --skill-path <path>    Validate skill at specific path
  --all, -a              Validate all discoverable skills
  --json                 Output results as JSON
  --quiet, -q            Suppress verbose output
  --help, -h             Show this help

Examples:
  npx tsx scripts/validate-predictions.ts --skill governance
  npx tsx scripts/validate-predictions.ts --all
  npx tsx scripts/validate-predictions.ts --all --json

Docker:
  docker exec skillsmith-dev-1 npx tsx scripts/validate-predictions.ts --all
`)
        process.exit(0)
    }
  }

  if (!options.skillName && !options.skillPath && !options.all) {
    options.all = true // Default to validating all
  }

  return options
}

async function main(): Promise<void> {
  const options = parseArgs()

  console.log('╔═══════════════════════════════════════════════════════════════╗')
  console.log('║      Skillsmith Transformation Prediction Validator           ║')
  console.log('╚═══════════════════════════════════════════════════════════════╝')
  console.log('')

  // Load TransformationService
  let TransformationService: Awaited<
    ReturnType<typeof loadTransformationService>
  >['TransformationService']
  try {
    const module = await loadTransformationService()
    TransformationService = module.TransformationService
    if (options.verbose) {
      console.log('✅ TransformationService loaded')
    }
  } catch (err) {
    console.error('❌ Failed to load TransformationService:', err)
    console.error('   Run: docker exec skillsmith-dev-1 npm run build')
    process.exit(1)
  }

  // Discover skills to validate
  let skillPaths: string[] = []

  if (options.skillPath) {
    skillPaths = [options.skillPath]
  } else if (options.skillName) {
    const projectPath = join(PROJECT_ROOT, '.claude/skills', options.skillName, 'SKILL.md')
    const homePath = join(process.env.HOME || '', '.claude/skills', options.skillName, 'SKILL.md')

    if (existsSync(projectPath)) {
      skillPaths = [projectPath]
    } else if (existsSync(homePath)) {
      skillPaths = [homePath]
    } else {
      console.error(`Skill not found: ${options.skillName}`)
      process.exit(1)
    }
  } else if (options.all) {
    // Discover all skills
    const projectSkills = await discoverSkills(join(PROJECT_ROOT, '.claude/skills'))
    const homeSkills = await discoverSkills(join(process.env.HOME || '', '.claude/skills'))
    skillPaths = [...projectSkills, ...homeSkills]
  }

  if (skillPaths.length === 0) {
    console.error('No skills found to validate')
    process.exit(1)
  }

  if (options.verbose) {
    console.log(`Found ${skillPaths.length} skill(s) to validate`)
    console.log('')
  }

  // Validate each skill
  const results: ValidationResult[] = []

  for (const skillPath of skillPaths) {
    if (options.verbose) {
      const skillName = skillPath.split('/').slice(-2)[0]
      process.stdout.write(`Validating ${skillName}... `)
    }

    const result = await validateSkill(skillPath, TransformationService)
    results.push(result)

    if (options.verbose) {
      console.log(result.valid ? '✅' : '❌')
    }
  }

  // Generate report
  const validResults = results.filter((r) => r.metrics.originalLines > 0)
  const report: ValidationReport = {
    timestamp: new Date().toISOString(),
    skillsValidated: results.length,
    passed: results.filter((r) => r.valid).length,
    failed: results.filter((r) => !r.valid).length,
    results,
    summary: {
      avgLineReduction:
        validResults.length > 0
          ? validResults.reduce((sum, r) => sum + r.metrics.lineReductionPercent, 0) /
            validResults.length
          : 0,
      avgTokenPrediction:
        validResults.length > 0
          ? validResults.reduce((sum, r) => sum + r.metrics.predictedTokenReduction, 0) /
            validResults.length
          : 0,
      avgTransformDuration:
        validResults.length > 0
          ? validResults.reduce((sum, r) => sum + r.metrics.transformDurationMs, 0) /
            validResults.length
          : 0,
      allPassed: results.every((r) => r.valid),
    },
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(generateMarkdownReport(report))
  }

  // Exit with error if any validations failed
  if (!report.summary.allPassed) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Validation failed:', err)
  process.exit(1)
})

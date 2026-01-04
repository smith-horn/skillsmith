/**
 * SMI-863: Skill Validation and Deduplication Pipeline
 *
 * Validates skill data against schema rules and deduplicates
 * entries using repository URL as primary key with source priority.
 *
 * Usage:
 *   npx tsx packages/core/src/scripts/validate-skills.ts [--input skills.json] [--output-dir data]
 *
 * Validation Rules:
 * 1. Name present (non-empty)
 * 2. Author present (use repo owner if missing)
 * 3. Description present (use first 100 chars of name if missing)
 * 4. Valid ID format (author/name)
 * 5. Quality score 0-100
 * 6. Valid trust tier enum
 *
 * Deduplication:
 * - Primary key: repo_url
 * - Source priority: anthropic-official (100) > github (80) > claude-plugins (40)
 * - Keep higher quality score on conflict
 * - Semantic similarity detection (threshold 0.85)
 */

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { z } from 'zod'
import { EmbeddingService } from '../embeddings/index.js'

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  /** Default input file path */
  DEFAULT_INPUT: './data/skills.json',
  /** Default output directory */
  DEFAULT_OUTPUT_DIR: './data',
  /** Semantic similarity threshold for duplicate detection */
  SIMILARITY_THRESHOLD: 0.85,
  /** Source priority scores */
  SOURCE_PRIORITY: {
    'anthropic-official': 100,
    github: 80,
    'claude-plugins': 40,
    unknown: 0,
  } as Record<string, number>,
  /** Valid trust tiers */
  VALID_TRUST_TIERS: ['verified', 'community', 'experimental', 'unknown'] as const,
} as const

// ============================================================================
// Type Definitions
// ============================================================================

type TrustTier = (typeof CONFIG.VALID_TRUST_TIERS)[number]

/** Raw skill input that may have missing or invalid fields */
interface RawSkillInput {
  id?: string
  name?: string
  description?: string | null
  author?: string | null
  repo_url?: string | null
  repoUrl?: string | null
  quality_score?: number | null
  qualityScore?: number | null
  trust_tier?: string | null
  trustTier?: string | null
  tags?: string[]
  source?: string
  stars?: number
  [key: string]: unknown
}

/** Validated skill with all required fields */
interface ValidatedSkill {
  id: string
  name: string
  description: string
  author: string
  repo_url: string | null
  quality_score: number
  trust_tier: TrustTier
  tags: string[]
  source: string
}

/** Validation error for a single field */
interface ValidationFieldError {
  field: string
  message: string
  value?: unknown
}

/** Result of validating a single skill */
interface SkillValidationResult {
  valid: boolean
  skill: ValidatedSkill | null
  original: RawSkillInput
  errors: ValidationFieldError[]
  warnings: string[]
  fixes: string[]
}

/** Duplicate detection result */
interface DuplicateEntry {
  kept: ValidatedSkill
  discarded: ValidatedSkill
  reason: 'repo_url' | 'semantic_similarity'
  similarity?: number
}

/** Overall validation report */
interface ValidationReport {
  timestamp: string
  summary: {
    total_input: number
    valid_skills: number
    invalid_skills: number
    duplicates_removed: number
    auto_fixes_applied: number
    errors_by_field: Record<string, number>
  }
  errors: Array<{
    skill_id: string | undefined
    skill_name: string | undefined
    errors: ValidationFieldError[]
  }>
  warnings: Array<{
    skill_id: string | undefined
    skill_name: string | undefined
    warnings: string[]
  }>
  fixes: Array<{
    skill_id: string | undefined
    skill_name: string | undefined
    fixes: string[]
  }>
}

/** Duplicates report */
interface DuplicatesReport {
  timestamp: string
  summary: {
    total_duplicates: number
    by_repo_url: number
    by_semantic_similarity: number
  }
  duplicates: DuplicateEntry[]
}

// ============================================================================
// Zod Schema for Validation
// ============================================================================

const TrustTierSchema = z.enum(CONFIG.VALID_TRUST_TIERS)

const _ValidatedSkillSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[^/]+\/[^/]+$/, 'ID must be in format author/name'),
  name: z.string().min(1),
  description: z.string().min(1),
  author: z.string().min(1),
  repo_url: z.string().url().nullable(),
  quality_score: z.number().min(0).max(100),
  trust_tier: TrustTierSchema,
  tags: z.array(z.string()),
  source: z.string().min(1),
})

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Extract owner from repo URL
 */
function extractOwnerFromRepoUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null

  try {
    const url = new URL(repoUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    return parts[0] || null
  } catch {
    return null
  }
}

/**
 * Generate skill ID from author and name
 */
function generateSkillId(author: string, name: string): string {
  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  return `${sanitize(author)}/${sanitize(name)}`
}

/**
 * Normalize quality score to 0-100 range
 */
function normalizeQualityScore(score: number | null | undefined): number {
  if (score === null || score === undefined) return 50 // Default score

  // If score is 0-1, convert to 0-100
  if (score >= 0 && score <= 1) {
    return Math.round(score * 100)
  }

  // Clamp to 0-100
  return Math.max(0, Math.min(100, Math.round(score)))
}

/**
 * Normalize trust tier to valid enum value
 */
function normalizeTrustTier(tier: string | null | undefined): TrustTier {
  if (!tier) return 'unknown'

  const normalized = tier.toLowerCase().trim()

  // Map common variations
  const mappings: Record<string, TrustTier> = {
    verified: 'verified',
    official: 'verified',
    'anthropic-official': 'verified',
    community: 'community',
    experimental: 'experimental',
    beta: 'experimental',
    unknown: 'unknown',
    unverified: 'unknown',
    standard: 'community',
  }

  return mappings[normalized] || 'unknown'
}

/**
 * Normalize source name
 */
function normalizeSource(source: string | null | undefined): string {
  if (!source) return 'unknown'
  return source.toLowerCase().trim()
}

/**
 * Generate hash for repo URL deduplication
 */
function hashRepoUrl(repoUrl: string): string {
  return createHash('md5').update(repoUrl.toLowerCase().trim()).digest('hex')
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate a single skill and apply auto-fixes where possible
 */
function validateSkill(raw: RawSkillInput): SkillValidationResult {
  const errors: ValidationFieldError[] = []
  const warnings: string[] = []
  const fixes: string[] = []

  // Normalize field names (handle both snake_case and camelCase)
  const repoUrl = raw.repo_url ?? raw.repoUrl ?? null
  const qualityScore = raw.quality_score ?? raw.qualityScore ?? null
  const trustTier = raw.trust_tier ?? raw.trustTier ?? null

  // 1. Validate name (required)
  const name = raw.name?.trim() || ''
  if (!name) {
    errors.push({ field: 'name', message: 'Name is required and cannot be empty' })
  }

  // 2. Validate author (use repo owner if missing)
  let author = raw.author?.trim() || ''
  if (!author) {
    const ownerFromUrl = extractOwnerFromRepoUrl(repoUrl)
    if (ownerFromUrl) {
      author = ownerFromUrl
      fixes.push(`Auto-filled author from repo URL: "${author}"`)
    } else {
      errors.push({
        field: 'author',
        message: 'Author is required (could not extract from repo URL)',
      })
    }
  }

  // 3. Validate description (use first 100 chars of name if missing)
  let description = raw.description?.trim() || ''
  if (!description) {
    if (name) {
      description = name.length > 100 ? name.substring(0, 100) + '...' : name
      fixes.push(`Auto-filled description from name: "${description}"`)
    } else {
      errors.push({ field: 'description', message: 'Description is required' })
    }
  }

  // 4. Validate ID format (author/name)
  let id = raw.id?.trim() || ''
  if (!id && author && name) {
    id = generateSkillId(author, name)
    fixes.push(`Auto-generated ID: "${id}"`)
  }

  if (id && !id.match(/^[^/]+\/[^/]+$/)) {
    if (author && name) {
      const newId = generateSkillId(author, name)
      fixes.push(`Fixed invalid ID format: "${id}" -> "${newId}"`)
      id = newId
    } else {
      errors.push({
        field: 'id',
        message: 'ID must be in format author/name',
        value: id,
      })
    }
  }

  // 5. Validate quality score (0-100)
  const normalizedScore = normalizeQualityScore(qualityScore)
  if (qualityScore !== null && qualityScore !== undefined) {
    if (qualityScore < 0 || qualityScore > 100) {
      if (qualityScore >= 0 && qualityScore <= 1) {
        fixes.push(
          `Normalized quality score from 0-1 to 0-100: ${qualityScore} -> ${normalizedScore}`
        )
      } else {
        fixes.push(`Clamped quality score to 0-100: ${qualityScore} -> ${normalizedScore}`)
      }
    }
  } else {
    warnings.push('Quality score missing, defaulted to 50')
  }

  // 6. Validate trust tier (enum)
  const normalizedTrustTier = normalizeTrustTier(trustTier)
  if (trustTier && !CONFIG.VALID_TRUST_TIERS.includes(trustTier as TrustTier)) {
    fixes.push(`Normalized trust tier: "${trustTier}" -> "${normalizedTrustTier}"`)
  }

  // Validate source
  const source = normalizeSource(raw.source)
  if (!raw.source) {
    warnings.push('Source missing, defaulted to "unknown"')
  }

  // Validate tags
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : []

  // Check repo_url format if present
  if (repoUrl) {
    try {
      new URL(repoUrl)
    } catch {
      warnings.push(`Invalid repo URL format: "${repoUrl}"`)
    }
  }

  // Build validated skill if no critical errors
  if (errors.length === 0 && name && author && description && id) {
    const validatedSkill: ValidatedSkill = {
      id,
      name,
      description,
      author,
      repo_url: repoUrl,
      quality_score: normalizedScore,
      trust_tier: normalizedTrustTier,
      tags,
      source,
    }

    return {
      valid: true,
      skill: validatedSkill,
      original: raw,
      errors: [],
      warnings,
      fixes,
    }
  }

  return {
    valid: false,
    skill: null,
    original: raw,
    errors,
    warnings,
    fixes,
  }
}

// ============================================================================
// Deduplication Functions
// ============================================================================

/**
 * Compare two skills and determine which to keep based on source priority and quality
 */
function compareSkillsForDedup(a: ValidatedSkill, b: ValidatedSkill): 'a' | 'b' {
  const priorityA = CONFIG.SOURCE_PRIORITY[a.source] ?? CONFIG.SOURCE_PRIORITY.unknown
  const priorityB = CONFIG.SOURCE_PRIORITY[b.source] ?? CONFIG.SOURCE_PRIORITY.unknown

  // Higher source priority wins
  if (priorityA !== priorityB) {
    return priorityA > priorityB ? 'a' : 'b'
  }

  // Same source priority - higher quality score wins
  return a.quality_score >= b.quality_score ? 'a' : 'b'
}

/**
 * Deduplicate skills by repo_url
 */
function deduplicateByRepoUrl(skills: ValidatedSkill[]): {
  unique: ValidatedSkill[]
  duplicates: DuplicateEntry[]
} {
  const seen = new Map<string, ValidatedSkill>()
  const duplicates: DuplicateEntry[] = []

  for (const skill of skills) {
    if (!skill.repo_url) {
      // Skills without repo_url are kept (will be checked for semantic similarity)
      // Use ID as key for skills without repo_url
      const key = `no-url:${skill.id}`
      if (!seen.has(key)) {
        seen.set(key, skill)
      }
      continue
    }

    const key = hashRepoUrl(skill.repo_url)
    const existing = seen.get(key)

    if (existing) {
      const winner = compareSkillsForDedup(existing, skill)
      if (winner === 'b') {
        duplicates.push({
          kept: skill,
          discarded: existing,
          reason: 'repo_url',
        })
        seen.set(key, skill)
      } else {
        duplicates.push({
          kept: existing,
          discarded: skill,
          reason: 'repo_url',
        })
      }
    } else {
      seen.set(key, skill)
    }
  }

  return {
    unique: Array.from(seen.values()),
    duplicates,
  }
}

/**
 * Detect semantic duplicates using embedding similarity
 */
async function detectSemanticDuplicates(
  skills: ValidatedSkill[],
  threshold: number = CONFIG.SIMILARITY_THRESHOLD
): Promise<{
  unique: ValidatedSkill[]
  duplicates: DuplicateEntry[]
}> {
  if (skills.length === 0) {
    return { unique: [], duplicates: [] }
  }

  // Use fallback mode for faster processing
  const embeddingService = new EmbeddingService({ useFallback: true })
  const duplicates: DuplicateEntry[] = []
  const unique: ValidatedSkill[] = []
  const embeddings = new Map<string, Float32Array>()

  try {
    // Generate embeddings for all skills
    for (const skill of skills) {
      const text = `${skill.name} ${skill.description}`
      const embedding = await embeddingService.embed(text)
      embeddings.set(skill.id, embedding)
    }

    // Check each skill against accepted unique skills
    for (const skill of skills) {
      const skillEmbedding = embeddings.get(skill.id)!
      let isDuplicate = false

      for (const uniqueSkill of unique) {
        const uniqueEmbedding = embeddings.get(uniqueSkill.id)!
        const similarity = embeddingService.cosineSimilarity(skillEmbedding, uniqueEmbedding)

        if (similarity >= threshold) {
          // Found semantic duplicate
          const winner = compareSkillsForDedup(uniqueSkill, skill)
          if (winner === 'b') {
            // New skill is better - swap
            const index = unique.indexOf(uniqueSkill)
            unique[index] = skill
            duplicates.push({
              kept: skill,
              discarded: uniqueSkill,
              reason: 'semantic_similarity',
              similarity,
            })
          } else {
            duplicates.push({
              kept: uniqueSkill,
              discarded: skill,
              reason: 'semantic_similarity',
              similarity,
            })
          }
          isDuplicate = true
          break
        }
      }

      if (!isDuplicate) {
        unique.push(skill)
      }
    }
  } finally {
    embeddingService.close()
  }

  return { unique, duplicates }
}

// ============================================================================
// Pipeline Functions
// ============================================================================

/**
 * Run the complete validation and deduplication pipeline
 */
export async function runValidationPipeline(
  inputPath: string,
  outputDir: string
): Promise<{
  validatedSkills: ValidatedSkill[]
  validationReport: ValidationReport
  duplicatesReport: DuplicatesReport
}> {
  console.log('='.repeat(60))
  console.log('SMI-863: Skill Validation and Deduplication Pipeline')
  console.log('='.repeat(60))
  console.log()

  // Read input file
  console.log(`Reading input: ${inputPath}`)
  const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf-8'))
  const rawSkills: RawSkillInput[] = Array.isArray(inputData) ? inputData : inputData.skills || []
  console.log(`Found ${rawSkills.length} skills to process`)
  console.log()

  // Validate all skills
  console.log('Phase 1: Validation')
  console.log('-'.repeat(40))
  const validationResults = rawSkills.map(validateSkill)
  const validSkills = validationResults.filter((r) => r.valid).map((r) => r.skill!)
  const invalidResults = validationResults.filter((r) => !r.valid)

  console.log(`  Valid: ${validSkills.length}`)
  console.log(`  Invalid: ${invalidResults.length}`)
  console.log(
    `  Auto-fixes applied: ${validationResults.reduce((sum, r) => sum + r.fixes.length, 0)}`
  )
  console.log()

  // Deduplicate by repo_url
  console.log('Phase 2: Deduplication by repo_url')
  console.log('-'.repeat(40))
  const repoUrlDedup = deduplicateByRepoUrl(validSkills)
  console.log(`  Before: ${validSkills.length}`)
  console.log(`  After: ${repoUrlDedup.unique.length}`)
  console.log(`  Duplicates: ${repoUrlDedup.duplicates.length}`)
  console.log()

  // Semantic similarity detection
  console.log('Phase 3: Semantic similarity detection')
  console.log('-'.repeat(40))
  const semanticDedup = await detectSemanticDuplicates(repoUrlDedup.unique)
  console.log(`  Before: ${repoUrlDedup.unique.length}`)
  console.log(`  After: ${semanticDedup.unique.length}`)
  console.log(`  Semantic duplicates: ${semanticDedup.duplicates.length}`)
  console.log()

  // Combine all duplicates
  const allDuplicates = [...repoUrlDedup.duplicates, ...semanticDedup.duplicates]

  // Build validation report
  const errorsByField: Record<string, number> = {}
  for (const result of invalidResults) {
    for (const error of result.errors) {
      errorsByField[error.field] = (errorsByField[error.field] || 0) + 1
    }
  }

  const validationReport: ValidationReport = {
    timestamp: new Date().toISOString(),
    summary: {
      total_input: rawSkills.length,
      valid_skills: validSkills.length,
      invalid_skills: invalidResults.length,
      duplicates_removed: allDuplicates.length,
      auto_fixes_applied: validationResults.reduce((sum, r) => sum + r.fixes.length, 0),
      errors_by_field: errorsByField,
    },
    errors: invalidResults.map((r) => ({
      skill_id: r.original.id,
      skill_name: r.original.name,
      errors: r.errors,
    })),
    warnings: validationResults
      .filter((r) => r.warnings.length > 0)
      .map((r) => ({
        skill_id: r.skill?.id || r.original.id,
        skill_name: r.skill?.name || r.original.name,
        warnings: r.warnings,
      })),
    fixes: validationResults
      .filter((r) => r.fixes.length > 0)
      .map((r) => ({
        skill_id: r.skill?.id || r.original.id,
        skill_name: r.skill?.name || r.original.name,
        fixes: r.fixes,
      })),
  }

  // Build duplicates report
  const duplicatesReport: DuplicatesReport = {
    timestamp: new Date().toISOString(),
    summary: {
      total_duplicates: allDuplicates.length,
      by_repo_url: repoUrlDedup.duplicates.length,
      by_semantic_similarity: semanticDedup.duplicates.length,
    },
    duplicates: allDuplicates,
  }

  // Write output files
  console.log('Phase 4: Writing output files')
  console.log('-'.repeat(40))

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  const validatedSkillsPath = path.join(outputDir, 'validated-skills.json')
  const validationReportPath = path.join(outputDir, 'validation-report.json')
  const duplicatesReportPath = path.join(outputDir, 'duplicates-report.json')

  fs.writeFileSync(validatedSkillsPath, JSON.stringify(semanticDedup.unique, null, 2))
  console.log(`  Validated skills: ${validatedSkillsPath}`)

  fs.writeFileSync(validationReportPath, JSON.stringify(validationReport, null, 2))
  console.log(`  Validation report: ${validationReportPath}`)

  fs.writeFileSync(duplicatesReportPath, JSON.stringify(duplicatesReport, null, 2))
  console.log(`  Duplicates report: ${duplicatesReportPath}`)

  console.log()
  console.log('='.repeat(60))
  console.log('Pipeline Complete')
  console.log('='.repeat(60))
  console.log(`  Final skill count: ${semanticDedup.unique.length}`)
  console.log(`  Total duplicates removed: ${allDuplicates.length}`)
  console.log(`  Validation errors: ${invalidResults.length}`)

  return {
    validatedSkills: semanticDedup.unique,
    validationReport,
    duplicatesReport,
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Parse arguments
  let inputPath: string = CONFIG.DEFAULT_INPUT
  let outputDir: string = CONFIG.DEFAULT_OUTPUT_DIR

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      inputPath = args[++i]
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      outputDir = args[++i]
    } else if (args[i] === '--help') {
      console.log(`
Usage: npx tsx packages/core/src/scripts/validate-skills.ts [options]

Options:
  --input <path>       Path to input JSON file (default: ${CONFIG.DEFAULT_INPUT})
  --output-dir <path>  Output directory for results (default: ${CONFIG.DEFAULT_OUTPUT_DIR})
  --help               Show this help message

Output files:
  validated-skills.json   Clean, deduplicated skill data
  validation-report.json  Validation statistics and errors
  duplicates-report.json  Detected duplicate entries
`)
      process.exit(0)
    }
  }

  // Validate input file exists
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`)
    process.exit(1)
  }

  try {
    await runValidationPipeline(inputPath, outputDir)
  } catch (error) {
    console.error('Pipeline failed:', error)
    process.exit(1)
  }
}

// Run if executed directly
const isMainModule = process.argv[1]?.includes('validate-skills')
if (isMainModule) {
  main().catch(console.error)
}

// Export for testing
export {
  CONFIG,
  validateSkill,
  deduplicateByRepoUrl,
  detectSemanticDuplicates,
  compareSkillsForDedup,
  extractOwnerFromRepoUrl,
  generateSkillId,
  normalizeQualityScore,
  normalizeTrustTier,
  normalizeSource,
  hashRepoUrl,
  type RawSkillInput,
  type ValidatedSkill,
  type ValidationFieldError,
  type SkillValidationResult,
  type DuplicateEntry,
  type ValidationReport,
  type DuplicatesReport,
  type TrustTier,
}

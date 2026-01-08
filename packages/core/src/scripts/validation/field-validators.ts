/**
 * SMI-863: Field validation functions for individual skill fields
 */

import {
  CONFIG,
  TrustTier,
  RawSkillInput,
  ValidatedSkill,
  ValidationFieldError,
  SkillValidationResult,
} from './types.js'
import {
  extractOwnerFromRepoUrl,
  generateSkillId,
  normalizeQualityScore,
  normalizeTrustTier,
  normalizeSource,
} from './normalizers.js'

/**
 * Validate a single skill and apply auto-fixes where possible
 */
export function validateSkill(raw: RawSkillInput): SkillValidationResult {
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

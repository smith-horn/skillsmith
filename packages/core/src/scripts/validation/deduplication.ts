/**
 * SMI-863: Deduplication functions for skill validation
 */

import { EmbeddingService } from '../../embeddings/index.js'
import { CONFIG, ValidatedSkill, DuplicateEntry } from './types.js'
import { hashRepoUrl } from './normalizers.js'

/**
 * Compare two skills and determine which to keep based on source priority and quality
 */
export function compareSkillsForDedup(a: ValidatedSkill, b: ValidatedSkill): 'a' | 'b' {
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
export function deduplicateByRepoUrl(skills: ValidatedSkill[]): {
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
export async function detectSemanticDuplicates(
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

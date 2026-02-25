/**
 * @fileoverview Local skill search functionality for MCP Search Tool
 * @module @skillsmith/mcp-server/tools/LocalSkillSearch
 * @see SMI-1809: Local skill search integration
 * @see SMI-1830: Extracted from search.ts to comply with 500-line limit
 *
 * Provides local skill indexing and search:
 * - Singleton LocalIndexer management
 * - Local skill to search result conversion
 * - Filtered local skill search
 */

import {
  type SkillSearchResult,
  type SearchFilters,
  type MCPTrustTier as TrustTier,
} from '@skillsmith/core'
import { extractCategoryFromTags } from '../utils/validation.js'
import { LocalIndexer, type LocalSkill } from '../indexer/LocalIndexer.js'

// Singleton local indexer for performance
let localIndexer: LocalIndexer | null = null

/**
 * Get or create the local indexer instance
 */
export function getLocalIndexer(): LocalIndexer {
  if (!localIndexer) {
    localIndexer = new LocalIndexer()
  }
  return localIndexer
}

/**
 * Convert a LocalSkill to SkillSearchResult format.
 * SMI-1809: Marks local skills with source: "local" for identification.
 */
export function localSkillToSearchResult(skill: LocalSkill): SkillSearchResult {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description || '',
    author: skill.author,
    category: extractCategoryFromTags(skill.tags),
    trustTier: 'local' as TrustTier,
    score: skill.qualityScore,
    source: 'local',
    // SMI-2759: Surface repository link for source transparency
    repository: skill.repository || undefined,
    // SMI-2760: Compatibility tags from frontmatter
    compatibility: skill.compatibility && skill.compatibility.length > 0 ? skill.compatibility : undefined,
  }
}

/**
 * Search local skills and convert to SkillSearchResult format.
 * SMI-1809: Returns matching local skills for search integration.
 *
 * @param query - Search query string
 * @param filters - Search filters to apply
 * @returns Array of matching local skills as SkillSearchResult
 */
export async function searchLocalSkills(
  query: string,
  filters: SearchFilters
): Promise<SkillSearchResult[]> {
  const indexer = getLocalIndexer()

  // Index local skills (uses cache if valid)
  const localSkills = await indexer.index()

  // If no local skills, return empty
  if (localSkills.length === 0) {
    return []
  }

  // Filter by query if provided
  let matchingSkills: LocalSkill[] = query ? indexer.search(query, localSkills) : localSkills

  // Apply min_score filter
  if (filters.minScore !== undefined) {
    const minScorePercent = filters.minScore * 100 // Convert from 0-1 to 0-100
    matchingSkills = matchingSkills.filter((skill) => skill.qualityScore >= minScorePercent)
  }

  // Apply category filter
  if (filters.category) {
    matchingSkills = matchingSkills.filter((skill) => {
      const skillCategory = extractCategoryFromTags(skill.tags)
      return skillCategory === filters.category
    })
  }

  // Convert to SkillSearchResult format
  return matchingSkills.map(localSkillToSearchResult)
}

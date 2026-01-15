/**
 * @fileoverview Shared validation utilities for MCP tools
 * @module @skillsmith/mcp-server/utils/validation
 * @see SMI-810: Create shared validation utility
 *
 * Provides common validation functions used across MCP tools:
 * - Skill ID format validation
 * - Skill ID parsing
 * - Trust tier mapping between MCP and database types
 */

import type { TrustTier as DBTrustTier, MCPTrustTier, SkillCategory } from '@skillsmith/core'

/**
 * Valid skill categories for mapping
 */
const VALID_CATEGORIES: readonly SkillCategory[] = [
  'development',
  'testing',
  'documentation',
  'devops',
  'database',
  'security',
  'productivity',
  'integration',
  'ai-ml',
  'other',
] as const

/**
 * Validate skill ID format.
 *
 * Accepts three formats:
 * - Author/name format: `anthropic/commit`, `community/jest-helper`
 * - Source/author/name format: `github/cyanheads/git-mcp-server`, `claude-plugins/author/skill`
 * - UUID format: `550e8400-e29b-41d4-a716-446655440000`
 *
 * @param id - Skill ID to validate
 * @returns True if ID matches valid format
 *
 * @example
 * isValidSkillId('anthropic/commit') // true
 * isValidSkillId('github/cyanheads/git-mcp-server') // true
 * isValidSkillId('invalid-format') // false
 */
export function isValidSkillId(id: string): boolean {
  // Format: author/skill-name (2 parts)
  const authorSlashName = /^[a-z0-9_-]+\/[a-z0-9_-]+$/i
  // Format: source/author/skill-name (3 parts, e.g., github/author/repo)
  const sourceAuthorName = /^[a-z0-9_-]+\/[a-z0-9_-]+\/[a-z0-9_.-]+$/i
  // UUID format
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  return authorSlashName.test(id) || sourceAuthorName.test(id) || uuid.test(id)
}

/**
 * Parse a skill ID into source, author, and name components.
 *
 * Handles both 2-part (author/name) and 3-part (source/author/name) formats.
 *
 * @param id - Skill ID in author/name or source/author/name format
 * @returns Object with source (optional), author, and name, or null if invalid format
 *
 * @example
 * parseSkillId('anthropic/commit') // { author: 'anthropic', name: 'commit' }
 * parseSkillId('github/cyanheads/git-mcp-server') // { source: 'github', author: 'cyanheads', name: 'git-mcp-server' }
 * parseSkillId('invalid') // null
 */
export function parseSkillId(id: string): { source?: string; author: string; name: string } | null {
  const parts = id.split('/')
  if (parts.length === 2) {
    return { author: parts[0], name: parts[1] }
  }
  if (parts.length === 3) {
    return { source: parts[0], author: parts[1], name: parts[2] }
  }
  return null
}

/**
 * Map MCP trust tier to database trust tier.
 *
 * Types are now unified: verified, community, experimental, unknown
 *
 * @param mcpTier - MCP trust tier
 * @returns Database trust tier
 */
export function mapTrustTierToDb(mcpTier: MCPTrustTier): DBTrustTier {
  switch (mcpTier) {
    case 'verified':
      return 'verified'
    case 'community':
      return 'community'
    case 'experimental':
      return 'experimental'
    case 'unknown':
      return 'unknown'
  }
}

/**
 * Map database trust tier to MCP trust tier.
 *
 * Accepts string input and validates, returning 'unknown' for invalid values.
 * Types are unified: verified, community, experimental, unknown
 *
 * @param dbTier - Database trust tier (string or typed)
 * @returns MCP trust tier
 */
export function mapTrustTierFromDb(dbTier: DBTrustTier | string): MCPTrustTier {
  switch (dbTier) {
    case 'verified':
      return 'verified'
    case 'community':
      return 'community'
    case 'experimental':
      return 'experimental'
    case 'unknown':
    default:
      return 'unknown'
  }
}

/**
 * Extract skill category from tags array.
 *
 * Searches through tags to find the first valid category match.
 * Handles case-insensitive matching and common aliases.
 *
 * @param tags - Array of skill tags
 * @returns Valid SkillCategory, defaults to 'other' if no match
 *
 * @example
 * extractCategoryFromTags(['git', 'testing', 'jest']) // 'testing'
 * extractCategoryFromTags(['react', 'frontend']) // 'development'
 * extractCategoryFromTags(['random', 'tags']) // 'other'
 */
export function extractCategoryFromTags(tags: string[] | undefined | null): SkillCategory {
  if (!tags || tags.length === 0) {
    return 'other'
  }

  // Normalize tags to lowercase for matching
  const normalizedTags = tags.map((tag) => tag.toLowerCase())

  // First pass: direct category match
  for (const tag of normalizedTags) {
    if (VALID_CATEGORIES.includes(tag as SkillCategory)) {
      return tag as SkillCategory
    }
  }

  // Second pass: keyword-based category inference
  const categoryKeywords: Record<SkillCategory, string[]> = {
    development: ['dev', 'code', 'coding', 'programming', 'frontend', 'backend', 'fullstack'],
    testing: ['test', 'tests', 'jest', 'vitest', 'mocha', 'cypress', 'playwright', 'e2e', 'unit'],
    documentation: ['docs', 'doc', 'readme', 'markdown', 'jsdoc', 'typedoc'],
    devops: ['ci', 'cd', 'cicd', 'docker', 'kubernetes', 'k8s', 'deploy', 'deployment', 'infra'],
    database: ['db', 'sql', 'postgres', 'mysql', 'mongodb', 'redis', 'sqlite'],
    security: ['auth', 'authentication', 'authorization', 'oauth', 'jwt', 'encryption'],
    productivity: ['workflow', 'automation', 'tools', 'utility', 'helper'],
    integration: ['api', 'rest', 'graphql', 'webhook', 'sync'],
    'ai-ml': ['ai', 'ml', 'machine-learning', 'llm', 'gpt', 'claude', 'openai', 'neural'],
    other: [],
  }

  for (const tag of normalizedTags) {
    for (const [category, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.includes(tag)) {
        return category as SkillCategory
      }
    }
  }

  return 'other'
}

/**
 * Get trust badge string for display.
 *
 * Returns a formatted badge string for terminal/CLI display
 * based on the skill's trust tier.
 *
 * @param tier - Trust tier value
 * @returns Formatted badge string (e.g., '[VERIFIED]')
 *
 * @example
 * getTrustBadge('verified') // '[VERIFIED]'
 * getTrustBadge('community') // '[COMMUNITY]'
 */
export function getTrustBadge(tier: MCPTrustTier): string {
  const badges: Record<MCPTrustTier, string> = {
    verified: '[VERIFIED]',
    community: '[COMMUNITY]',
    experimental: '[EXPERIMENTAL]',
    unknown: '[UNKNOWN]',
  }
  return badges[tier] ?? '[UNKNOWN]'
}

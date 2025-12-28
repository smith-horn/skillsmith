/**
 * SMI-628: Indexer module exports
 *
 * Provides skill discovery and indexing capabilities:
 * - SkillParser: Parse SKILL.md files with YAML frontmatter
 * - GitHubIndexer: Discover and index skills from GitHub repositories
 */

export { SkillParser } from './SkillParser.js'
export type {
  SkillFrontmatter,
  ParsedSkillMetadata,
  ValidationResult,
  SkillParserOptions,
} from './SkillParser.js'

export { GitHubIndexer } from './GitHubIndexer.js'
export type { GitHubIndexerOptions, SkillMetadata, IndexResult } from './GitHubIndexer.js'

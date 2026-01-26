/**
 * Indexer module exports
 * @see SMI-1809: Local skill indexing for MCP server
 * @see SMI-1829: Split LocalIndexer.ts to comply with 500-line governance limit
 */

export {
  LocalIndexer,
  getLocalIndexer,
  resetLocalIndexer,
  type LocalSkill,
} from './LocalIndexer.js'

export { parseFrontmatter, type SkillFrontmatter } from './FrontmatterParser.js'

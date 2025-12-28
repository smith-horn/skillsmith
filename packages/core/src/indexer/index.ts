/**
 * Indexer module - GitHub and Swarm repository indexing
 *
 * SMI-628: GitHubIndexer - Single-threaded GitHub indexing
 * SMI-628: SkillParser - YAML frontmatter parsing
 * SMI-643: SwarmIndexer - Parallel swarm coordination
 */

// SkillParser (SMI-628)
export {
  SkillParser,
  type SkillFrontmatter,
  type ParsedSkillMetadata,
  type ValidationResult,
  type SkillParserOptions,
} from './SkillParser.js'

// GitHubIndexer (SMI-628)
export {
  GitHubIndexer,
  type GitHubRepository,
  type GitHubIndexerOptions,
  type IndexResult,
  type SkillMetadata,
} from './GitHubIndexer.js'

// PartitionStrategy (SMI-643)
export {
  PartitionStrategy,
  createDefaultStrategy,
  createCustomStrategy,
  DEFAULT_PARTITION_RANGES,
  type Partition,
  type PartitionOptions,
  type PartitionStats,
} from './PartitionStrategy.js'

// SwarmIndexer (SMI-643)
export {
  SwarmIndexer,
  createSwarmIndexer,
  createClaudeFlowSwarmIndexer,
  type SwarmIndexerOptions,
  type SwarmIndexResult,
  type SwarmProgress,
  type WorkerState,
  type WorkerStatus,
  type RateLimitInfo,
} from './SwarmIndexer.js'

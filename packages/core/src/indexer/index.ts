/**
 * Indexer module - GitHub and Swarm repository indexing
 *
 * SMI-628: GitHubIndexer - Single-threaded GitHub indexing
 * SMI-643: SwarmIndexer - Parallel swarm coordination
 */

// GitHubIndexer (SMI-628)
export {
  GitHubIndexer,
  type GitHubRepository,
  type GitHubIndexerOptions,
  type IndexResult,
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

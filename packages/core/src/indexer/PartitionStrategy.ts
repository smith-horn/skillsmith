/**
 * SMI-643: PartitionStrategy - Load balancing for parallel repository indexing
 *
 * Provides:
 * - Partition repositories by letter range (A-F, G-L, M-R, S-Z)
 * - Load balancing across workers
 * - Handle uneven distributions
 */

import type { GitHubRepository } from './GitHubIndexer.js'

/**
 * A partition of repositories for a worker
 */
export interface Partition {
  /** Unique partition identifier */
  id: string
  /** Start letter for this partition (inclusive) */
  startLetter: string
  /** End letter for this partition (inclusive) */
  endLetter: string
  /** Letter pattern description (e.g., "A-F") */
  range: string
  /** Repositories assigned to this partition */
  repositories: GitHubRepository[]
}

/**
 * Options for partitioning strategy
 */
export interface PartitionOptions {
  /** Number of partitions to create (default: 4) */
  partitionCount?: number
  /** Custom partition ranges (overrides partitionCount) */
  customRanges?: Array<{ start: string; end: string }>
}

/**
 * Default letter ranges for 4-way partitioning
 */
export const DEFAULT_PARTITION_RANGES: Array<{ start: string; end: string }> = [
  { start: 'A', end: 'F' },
  { start: 'G', end: 'L' },
  { start: 'M', end: 'R' },
  { start: 'S', end: 'Z' },
]

/**
 * Handles letter distribution with approximately equal splits
 */
const LETTER_GROUPS: Record<number, Array<{ start: string; end: string }>> = {
  2: [
    { start: 'A', end: 'L' },
    { start: 'M', end: 'Z' },
  ],
  3: [
    { start: 'A', end: 'H' },
    { start: 'I', end: 'Q' },
    { start: 'R', end: 'Z' },
  ],
  4: DEFAULT_PARTITION_RANGES,
  5: [
    { start: 'A', end: 'E' },
    { start: 'F', end: 'J' },
    { start: 'K', end: 'O' },
    { start: 'P', end: 'T' },
    { start: 'U', end: 'Z' },
  ],
  6: [
    { start: 'A', end: 'D' },
    { start: 'E', end: 'H' },
    { start: 'I', end: 'L' },
    { start: 'M', end: 'P' },
    { start: 'Q', end: 'T' },
    { start: 'U', end: 'Z' },
  ],
}

/**
 * Partition strategy for distributing repositories across workers
 */
export class PartitionStrategy {
  private ranges: Array<{ start: string; end: string }>

  constructor(options: PartitionOptions = {}) {
    if (options.customRanges && options.customRanges.length > 0) {
      this.ranges = options.customRanges
    } else {
      const count = options.partitionCount ?? 4
      this.ranges = LETTER_GROUPS[count] ?? this.generateRanges(count)
    }
  }

  /**
   * Generate balanced letter ranges for any partition count
   */
  private generateRanges(count: number): Array<{ start: string; end: string }> {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const lettersPerPartition = Math.ceil(26 / count)
    const ranges: Array<{ start: string; end: string }> = []

    for (let i = 0; i < count; i++) {
      const startIdx = i * lettersPerPartition
      const endIdx = Math.min((i + 1) * lettersPerPartition - 1, 25)

      if (startIdx <= 25) {
        ranges.push({
          start: ALPHABET[startIdx],
          end: ALPHABET[endIdx],
        })
      }
    }

    return ranges
  }

  /**
   * Get the partition ranges
   */
  getRanges(): Array<{ start: string; end: string }> {
    return [...this.ranges]
  }

  /**
   * Get empty partitions for workers to fill
   */
  createEmptyPartitions(): Partition[] {
    return this.ranges.map((range, index) => ({
      id: `partition-${index}`,
      startLetter: range.start,
      endLetter: range.end,
      range: `${range.start}-${range.end}`,
      repositories: [],
    }))
  }

  /**
   * Check if a repository name belongs to a specific partition
   */
  belongsToPartition(repoName: string, partition: Partition): boolean {
    if (!repoName || repoName.length === 0) {
      return false
    }

    const firstLetter = repoName.charAt(0).toUpperCase()

    // Handle non-alphabetic first characters
    if (!/[A-Z]/.test(firstLetter)) {
      // Assign numeric/special char repos to first partition
      return partition.id === 'partition-0'
    }

    return firstLetter >= partition.startLetter && firstLetter <= partition.endLetter
  }

  /**
   * Assign a single repository to the appropriate partition
   */
  assignToPartition(repo: GitHubRepository, partitions: Partition[]): Partition | null {
    for (const partition of partitions) {
      if (this.belongsToPartition(repo.name, partition)) {
        return partition
      }
    }

    // Fallback: assign to first partition
    return partitions.length > 0 ? partitions[0] : null
  }

  /**
   * Partition a list of repositories across all partitions
   */
  partitionRepositories(repositories: GitHubRepository[]): Partition[] {
    const partitions = this.createEmptyPartitions()

    for (const repo of repositories) {
      const partition = this.assignToPartition(repo, partitions)
      if (partition) {
        partition.repositories.push(repo)
      }
    }

    return partitions
  }

  /**
   * Get partition statistics for load balancing analysis
   */
  getPartitionStats(partitions: Partition[]): PartitionStats {
    const sizes = partitions.map((p) => p.repositories.length)
    const total = sizes.reduce((a, b) => a + b, 0)
    const average = total / partitions.length
    const min = Math.min(...sizes)
    const max = Math.max(...sizes)
    const imbalance = max > 0 ? (max - min) / max : 0

    return {
      partitionCount: partitions.length,
      totalRepositories: total,
      averagePerPartition: average,
      minSize: min,
      maxSize: max,
      imbalanceRatio: imbalance,
      isBalanced: imbalance < 0.3, // Less than 30% imbalance is considered balanced
      distribution: partitions.map((p) => ({
        id: p.id,
        range: p.range,
        count: p.repositories.length,
        percentage: total > 0 ? (p.repositories.length / total) * 100 : 0,
      })),
    }
  }

  /**
   * Rebalance partitions by redistributing excess repositories
   */
  rebalancePartitions(partitions: Partition[]): Partition[] {
    const stats = this.getPartitionStats(partitions)

    // Already balanced, no need to rebalance
    if (stats.isBalanced) {
      return partitions
    }

    // Collect all repositories
    const allRepos: GitHubRepository[] = []
    for (const partition of partitions) {
      allRepos.push(...partition.repositories)
    }

    // Sort by name for consistent redistribution
    allRepos.sort((a, b) => a.name.localeCompare(b.name))

    // Redistribute evenly
    const rebalanced = this.createEmptyPartitions()
    const targetSize = Math.ceil(allRepos.length / rebalanced.length)

    let currentPartitionIdx = 0
    for (const repo of allRepos) {
      if (
        rebalanced[currentPartitionIdx].repositories.length >= targetSize &&
        currentPartitionIdx < rebalanced.length - 1
      ) {
        currentPartitionIdx++
      }
      rebalanced[currentPartitionIdx].repositories.push(repo)
    }

    return rebalanced
  }
}

/**
 * Statistics about partition distribution
 */
export interface PartitionStats {
  partitionCount: number
  totalRepositories: number
  averagePerPartition: number
  minSize: number
  maxSize: number
  imbalanceRatio: number
  isBalanced: boolean
  distribution: Array<{
    id: string
    range: string
    count: number
    percentage: number
  }>
}

/**
 * Create a default partition strategy with 4 workers
 */
export function createDefaultStrategy(): PartitionStrategy {
  return new PartitionStrategy({ partitionCount: 4 })
}

/**
 * Create a custom partition strategy
 */
export function createCustomStrategy(
  ranges: Array<{ start: string; end: string }>
): PartitionStrategy {
  return new PartitionStrategy({ customRanges: ranges })
}

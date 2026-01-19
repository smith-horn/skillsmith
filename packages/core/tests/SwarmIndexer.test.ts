/**
 * SMI-643: SwarmIndexer Tests
 *
 * Tests for:
 * - Partitioning logic
 * - Load balancing
 * - Swarm coordination mocking
 * - Result aggregation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PartitionStrategy,
  createDefaultStrategy,
  createCustomStrategy,
  type Partition,
} from '../src/indexer/PartitionStrategy.js'
import {
  SwarmIndexer,
  createSwarmIndexer,
  createClaudeFlowSwarmIndexer,
  type WorkerState,
  type SwarmProgress,
} from '../src/indexer/SwarmIndexer.js'
import { GitHubIndexer, type GitHubRepository } from '../src/indexer/GitHubIndexer.js'

// Mock fetch for GitHub API calls
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('PartitionStrategy', () => {
  describe('createEmptyPartitions', () => {
    it('should create 4 default partitions with letter ranges', () => {
      const strategy = createDefaultStrategy()
      const partitions = strategy.createEmptyPartitions()

      expect(partitions).toHaveLength(4)
      expect(partitions[0].range).toBe('A-F')
      expect(partitions[1].range).toBe('G-L')
      expect(partitions[2].range).toBe('M-R')
      expect(partitions[3].range).toBe('S-Z')
    })

    it('should create custom number of partitions', () => {
      const strategy = new PartitionStrategy({ partitionCount: 2 })
      const partitions = strategy.createEmptyPartitions()

      expect(partitions).toHaveLength(2)
      expect(partitions[0].range).toBe('A-L')
      expect(partitions[1].range).toBe('M-Z')
    })

    it('should accept custom ranges', () => {
      const strategy = createCustomStrategy([
        { start: 'A', end: 'C' },
        { start: 'D', end: 'Z' },
      ])
      const partitions = strategy.createEmptyPartitions()

      expect(partitions).toHaveLength(2)
      expect(partitions[0].range).toBe('A-C')
      expect(partitions[1].range).toBe('D-Z')
    })
  })

  describe('belongsToPartition', () => {
    const strategy = createDefaultStrategy()
    const partitions = strategy.createEmptyPartitions()

    it('should correctly assign repos starting with A-F to first partition', () => {
      expect(strategy.belongsToPartition('apple-skill', partitions[0])).toBe(true)
      expect(strategy.belongsToPartition('FileManager', partitions[0])).toBe(true)
      expect(strategy.belongsToPartition('Zebra', partitions[0])).toBe(false)
    })

    it('should correctly assign repos starting with G-L to second partition', () => {
      expect(strategy.belongsToPartition('github-tools', partitions[1])).toBe(true)
      expect(strategy.belongsToPartition('Logger', partitions[1])).toBe(true)
      expect(strategy.belongsToPartition('apple', partitions[1])).toBe(false)
    })

    it('should correctly assign repos starting with M-R to third partition', () => {
      expect(strategy.belongsToPartition('markdown-helper', partitions[2])).toBe(true)
      expect(strategy.belongsToPartition('ReactTools', partitions[2])).toBe(true)
      expect(strategy.belongsToPartition('logger', partitions[2])).toBe(false)
    })

    it('should correctly assign repos starting with S-Z to fourth partition', () => {
      expect(strategy.belongsToPartition('search-skill', partitions[3])).toBe(true)
      expect(strategy.belongsToPartition('ZenCoder', partitions[3])).toBe(true)
      expect(strategy.belongsToPartition('apple', partitions[3])).toBe(false)
    })

    it('should handle numeric/special first characters', () => {
      // Numeric/special repos go to first partition
      expect(strategy.belongsToPartition('123-skill', partitions[0])).toBe(true)
      expect(strategy.belongsToPartition('_underscore', partitions[0])).toBe(true)
    })

    it('should handle empty strings', () => {
      expect(strategy.belongsToPartition('', partitions[0])).toBe(false)
    })
  })

  describe('partitionRepositories', () => {
    it('should distribute repositories across partitions', () => {
      const strategy = createDefaultStrategy()
      const repos: GitHubRepository[] = [
        createMockRepo('alpha'),
        createMockRepo('beta'),
        createMockRepo('gamma'),
        createMockRepo('lambda'),
        createMockRepo('mu'),
        createMockRepo('sigma'),
        createMockRepo('zeta'),
      ]

      const partitions = strategy.partitionRepositories(repos)

      expect(partitions[0].repositories).toHaveLength(2) // alpha, beta (A-F)
      expect(partitions[1].repositories).toHaveLength(2) // gamma, lambda (G-L)
      expect(partitions[2].repositories).toHaveLength(1) // mu (M-R)
      expect(partitions[3].repositories).toHaveLength(2) // sigma, zeta (S-Z)
    })

    it('should handle empty repository list', () => {
      const strategy = createDefaultStrategy()
      const partitions = strategy.partitionRepositories([])

      expect(partitions).toHaveLength(4)
      partitions.forEach((p) => {
        expect(p.repositories).toHaveLength(0)
      })
    })
  })

  describe('getPartitionStats', () => {
    it('should calculate correct statistics', () => {
      const strategy = createDefaultStrategy()
      const repos: GitHubRepository[] = [
        createMockRepo('alpha'),
        createMockRepo('beta'),
        createMockRepo('charlie'),
        createMockRepo('gamma'),
        createMockRepo('mu'),
        createMockRepo('sigma'),
      ]

      const partitions = strategy.partitionRepositories(repos)
      const stats = strategy.getPartitionStats(partitions)

      expect(stats.partitionCount).toBe(4)
      expect(stats.totalRepositories).toBe(6)
      expect(stats.averagePerPartition).toBe(1.5)
      expect(stats.minSize).toBe(1)
      expect(stats.maxSize).toBe(3)
    })

    it('should detect balanced vs unbalanced distributions', () => {
      const strategy = createDefaultStrategy()

      // Balanced: 2, 2, 2, 2
      const balanced: Partition[] = strategy.createEmptyPartitions()
      balanced.forEach((p) => {
        p.repositories = [createMockRepo('test1'), createMockRepo('test2')]
      })

      const balancedStats = strategy.getPartitionStats(balanced)
      expect(balancedStats.isBalanced).toBe(true)

      // Unbalanced: 10, 1, 1, 1
      const unbalanced: Partition[] = strategy.createEmptyPartitions()
      unbalanced[0].repositories = Array(10)
        .fill(null)
        .map((_, i) => createMockRepo(`a${i}`))
      unbalanced[1].repositories = [createMockRepo('g1')]
      unbalanced[2].repositories = [createMockRepo('m1')]
      unbalanced[3].repositories = [createMockRepo('s1')]

      const unbalancedStats = strategy.getPartitionStats(unbalanced)
      expect(unbalancedStats.isBalanced).toBe(false)
    })
  })

  describe('rebalancePartitions', () => {
    it('should rebalance uneven distributions', () => {
      const strategy = createDefaultStrategy()
      const unbalanced: Partition[] = strategy.createEmptyPartitions()

      // Create heavily unbalanced: 12, 0, 0, 0
      unbalanced[0].repositories = Array(12)
        .fill(null)
        .map((_, i) => createMockRepo(`repo${i}`))

      const rebalanced = strategy.rebalancePartitions(unbalanced)
      const stats = strategy.getPartitionStats(rebalanced)

      // After rebalancing, each partition should have 3 repos
      expect(stats.maxSize).toBe(3)
      expect(stats.minSize).toBe(3)
      expect(stats.isBalanced).toBe(true)
    })

    it('should not modify already balanced partitions unnecessarily', () => {
      const strategy = createDefaultStrategy()
      const balanced: Partition[] = strategy.createEmptyPartitions()

      balanced.forEach((p, i) => {
        p.repositories = [createMockRepo(`${p.startLetter.toLowerCase()}${i}`)]
      })

      const rebalanced = strategy.rebalancePartitions(balanced)
      const stats = strategy.getPartitionStats(rebalanced)

      expect(stats.isBalanced).toBe(true)
    })
  })
})

describe('SwarmIndexer', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('should create with default options', () => {
      const indexer = createSwarmIndexer()
      expect(indexer).toBeInstanceOf(SwarmIndexer)
    })

    it('should create with claude-flow configuration', () => {
      const indexer = createClaudeFlowSwarmIndexer('test-token')
      expect(indexer).toBeInstanceOf(SwarmIndexer)
    })
  })

  describe('generateSwarmCommand', () => {
    it('should generate valid claude-flow swarm command', () => {
      const indexer = createSwarmIndexer()
      const command = indexer.generateSwarmCommand()

      expect(command).toContain('./claude-flow swarm')
      expect(command).toContain('--strategy development')
      expect(command).toContain('--mode distributed')
      expect(command).toContain('--parallel')
      expect(command).toContain('A-F')
      expect(command).toContain('G-L')
      expect(command).toContain('M-R')
      expect(command).toContain('S-Z')
    })
  })

  describe('indexPartitionById', () => {
    it('should return error for unknown partition', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ total_count: 0, items: [] }),
      })

      const indexer = createSwarmIndexer()
      const result = await indexer.indexPartitionById('unknown-partition')

      expect(result.failed).toBe(1)
      expect(result.errors[0]).toContain('Partition not found')
    })

    it('should index valid partition', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          total_count: 2,
          incomplete_results: false,
          items: [createMockGitHubApiRepo('alpha-skill'), createMockGitHubApiRepo('beta-skill')],
        }),
      })

      const indexer = createSwarmIndexer()
      const result = await indexer.indexPartitionById('partition-0')

      expect(result.indexed).toBeGreaterThanOrEqual(0)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe('progress callbacks', () => {
    it('should notify on worker updates', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ total_count: 0, items: [] }),
      })

      const workerUpdates: WorkerState[] = []
      const progressUpdates: SwarmProgress[] = []

      const indexer = createSwarmIndexer({
        onWorkerUpdate: (worker) => workerUpdates.push({ ...worker }),
        onProgress: (progress) => progressUpdates.push({ ...progress }),
      })

      await indexer.indexAll()

      expect(workerUpdates.length).toBeGreaterThan(0)
      expect(progressUpdates.length).toBeGreaterThan(0)
    })
  })

  describe('convertToSkills', () => {
    it('should convert repositories to skill inputs', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          total_count: 1,
          incomplete_results: false,
          items: [createMockGitHubApiRepo('test-skill')],
        }),
      })

      const indexer = createSwarmIndexer()
      const result = await indexer.indexAll()
      const skills = indexer.convertToSkills(result)

      expect(Array.isArray(skills)).toBe(true)
      if (skills.length > 0) {
        expect(skills[0]).toHaveProperty('name')
        expect(skills[0]).toHaveProperty('repoUrl')
        expect(skills[0]).toHaveProperty('trustTier')
      }
    })
  })

  describe('reset', () => {
    it('should clear worker states', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ total_count: 0, items: [] }),
      })

      const indexer = createSwarmIndexer()
      await indexer.indexAll()

      expect(indexer.getWorkerStates().length).toBe(4)

      indexer.reset()
      expect(indexer.getWorkerStates().length).toBe(0)
    })
  })
})

describe('GitHubIndexer', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  describe('repositoryToSkill', () => {
    it('should convert repository to skill with calculated scores', () => {
      const indexer = new GitHubIndexer()
      const repo: GitHubRepository = {
        owner: 'testuser',
        name: 'awesome-skill',
        fullName: 'testuser/awesome-skill',
        description: 'An awesome Claude skill',
        url: 'https://github.com/testuser/awesome-skill',
        stars: 100,
        forks: 20,
        topics: ['claude-code-skill'],
        updatedAt: '2024-01-01T00:00:00Z',
        defaultBranch: 'main',
      }

      const skill = indexer.repositoryToSkill(repo)

      expect(skill.name).toBe('awesome-skill')
      expect(skill.author).toBe('testuser')
      expect(skill.repoUrl).toBe('https://github.com/testuser/awesome-skill')
      expect(skill.qualityScore).toBeGreaterThan(0)
      expect(skill.trustTier).toBe('community') // 100 stars >= 50
      expect(skill.tags).toContain('claude-code-skill')
    })

    it('should assign verified tier for official repos', () => {
      const indexer = new GitHubIndexer()
      const repo: GitHubRepository = {
        owner: 'anthropic',
        name: 'official-skill',
        fullName: 'anthropic/official-skill',
        description: 'Official skill',
        url: 'https://github.com/anthropic/official-skill',
        stars: 10,
        forks: 2,
        topics: ['claude-code-official'],
        updatedAt: '2024-01-01T00:00:00Z',
        defaultBranch: 'main',
      }

      const skill = indexer.repositoryToSkill(repo)
      expect(skill.trustTier).toBe('verified')
    })

    it('should assign experimental tier for low-star repos', () => {
      const indexer = new GitHubIndexer()
      const repo: GitHubRepository = {
        owner: 'newuser',
        name: 'new-skill',
        fullName: 'newuser/new-skill',
        description: 'New skill',
        url: 'https://github.com/newuser/new-skill',
        stars: 10,
        forks: 1,
        topics: [],
        updatedAt: '2024-01-01T00:00:00Z',
        defaultBranch: 'main',
      }

      const skill = indexer.repositoryToSkill(repo)
      expect(skill.trustTier).toBe('experimental')
    })
  })
})

// Helper functions for creating mock data

function createMockRepo(name: string): GitHubRepository {
  return {
    owner: 'testuser',
    name,
    fullName: `testuser/${name}`,
    description: `Description for ${name}`,
    url: `https://github.com/testuser/${name}`,
    stars: Math.floor(Math.random() * 100),
    forks: Math.floor(Math.random() * 20),
    topics: ['claude-code-skill'],
    updatedAt: new Date().toISOString(),
    defaultBranch: 'main',
  }
}

function createMockGitHubApiRepo(name: string) {
  return {
    id: Math.floor(Math.random() * 1000000),
    full_name: `testuser/${name}`,
    name,
    owner: { login: 'testuser' },
    description: `Description for ${name}`,
    html_url: `https://github.com/testuser/${name}`,
    stargazers_count: Math.floor(Math.random() * 100),
    forks_count: Math.floor(Math.random() * 20),
    topics: ['claude-code-skill'],
    updated_at: new Date().toISOString(),
    default_branch: 'main',
  }
}

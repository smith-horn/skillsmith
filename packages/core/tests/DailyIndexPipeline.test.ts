/**
 * Daily Index Pipeline Tests (SMI-593)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DailyIndexPipeline,
  createScheduledPipeline,
  runDailyIndex,
  type PipelineSourceConfig,
  type PipelineProgress,
} from '../src/pipeline/index.js'
import { BaseSourceAdapter } from '../src/sources/BaseSourceAdapter.js'
import type {
  SourceConfig,
  SourceLocation,
  SourceRepository,
  SourceSearchOptions,
  SourceSearchResult,
  SkillContent,
  SourceHealth,
} from '../src/sources/types.js'
import type {
  ISkillParser,
  ISkillRepository,
  ParsedSkillMetadata,
} from '../src/sources/SourceIndexer.js'

/**
 * Mock source adapter for testing
 */
class MockSourceAdapter extends BaseSourceAdapter {
  public searchDelay = 0
  public fetchDelay = 0
  public shouldFail = false
  public repositories: SourceRepository[] = []

  protected async doHealthCheck(): Promise<Partial<SourceHealth>> {
    return { healthy: true }
  }

  async search(_options: SourceSearchOptions): Promise<SourceSearchResult> {
    await this.waitForRateLimit()
    if (this.searchDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.searchDelay))
    }
    if (this.shouldFail) {
      throw new Error('Search failed')
    }
    return {
      repositories: this.repositories,
      totalCount: this.repositories.length,
      hasMore: false,
    }
  }

  async getRepository(location: SourceLocation): Promise<SourceRepository> {
    await this.waitForRateLimit()
    return {
      id: location.repo,
      name: location.repo,
      url: `https://github.com/${location.owner}/${location.repo}`,
      description: 'Test repository',
      owner: location.owner ?? 'unknown',
      defaultBranch: 'main',
      stars: 5,
      forks: 1,
      topics: [],
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      license: null,
      metadata: {},
    }
  }

  async fetchSkillContent(location: SourceLocation): Promise<SkillContent> {
    await this.waitForRateLimit()
    if (this.fetchDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.fetchDelay))
    }
    return {
      rawContent: `---\nname: "${location.repo}"\n---\n# ${location.repo}`,
      sha: 'abc123',
      location,
      filePath: 'SKILL.md',
      encoding: 'utf-8',
    }
  }
}

describe('DailyIndexPipeline (SMI-593)', () => {
  let pipeline: DailyIndexPipeline
  let mockParser: ISkillParser
  let mockRepository: ISkillRepository

  beforeEach(() => {
    pipeline = new DailyIndexPipeline()

    mockParser = {
      parse: vi.fn().mockReturnValue({
        name: 'Test Skill',
        description: 'A test skill',
        author: 'test',
        version: '1.0.0',
        tags: ['test'],
        dependencies: [],
        category: null,
        license: 'MIT',
        rawContent: '# Test',
        repoUrl: '',
        filePath: '',
        sha: '',
        owner: '',
        repo: '',
      } satisfies ParsedSkillMetadata),
    }

    mockRepository = {
      upsertFromMetadata: vi.fn().mockResolvedValue({
        id: 'skill-1',
        action: 'created' as const,
      }),
      getSkillBySha: vi.fn().mockResolvedValue(null),
    }
  })

  describe('Basic operations', () => {
    it('should not be running initially', () => {
      expect(pipeline.isRunning).toBe(false)
      expect(pipeline.currentRunId).toBeNull()
    })

    it('should run with no sources', async () => {
      const result = await pipeline.run({
        sources: [],
        parser: mockParser,
        repository: mockRepository,
      })

      expect(result.status).toBe('completed')
      expect(result.summary.totalSources).toBe(0)
    })

    it('should run with a single source', async () => {
      const adapter = new MockSourceAdapter({
        id: 'test-source',
        name: 'Test Source',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      adapter.repositories = [
        {
          id: '1',
          name: 'test-skill',
          url: 'https://github.com/test/test-skill',
          description: 'A test skill',
          owner: 'test',
          defaultBranch: 'main',
          stars: 10,
          forks: 2,
          topics: ['claude-skill'],
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          license: 'MIT',
          metadata: {},
        },
      ]

      const result = await pipeline.run({
        sources: [{ adapter }],
        parser: mockParser,
        repository: mockRepository,
      })

      expect(result.status).toBe('completed')
      expect(result.summary.totalSources).toBe(1)
      expect(result.summary.successfulSources).toBe(1)
      expect(result.summary.totalSkills).toBe(1)
    })

    it('should process multiple sources', async () => {
      const adapter1 = new MockSourceAdapter({
        id: 'source-1',
        name: 'Source 1',
        type: 'custom',
        baseUrl: 'https://example1.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      const adapter2 = new MockSourceAdapter({
        id: 'source-2',
        name: 'Source 2',
        type: 'custom',
        baseUrl: 'https://example2.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      adapter1.repositories = [
        {
          id: '1',
          name: 'skill-1',
          url: 'https://github.com/test/skill-1',
          description: 'Skill 1',
          owner: 'test',
          defaultBranch: 'main',
          stars: 10,
          forks: 2,
          topics: [],
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          license: 'MIT',
          metadata: {},
        },
      ]

      adapter2.repositories = [
        {
          id: '2',
          name: 'skill-2',
          url: 'https://github.com/test/skill-2',
          description: 'Skill 2',
          owner: 'test',
          defaultBranch: 'main',
          stars: 20,
          forks: 5,
          topics: [],
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          license: 'MIT',
          metadata: {},
        },
      ]

      const result = await pipeline.run({
        sources: [{ adapter: adapter1 }, { adapter: adapter2 }],
        parser: mockParser,
        repository: mockRepository,
      })

      expect(result.status).toBe('completed')
      expect(result.summary.totalSources).toBe(2)
      expect(result.summary.successfulSources).toBe(2)
      expect(result.summary.totalSkills).toBe(2)
    })
  })

  describe('Error handling', () => {
    it('should handle source failures with continueOnError', async () => {
      const failingAdapter = new MockSourceAdapter({
        id: 'failing-source',
        name: 'Failing Source',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })
      failingAdapter.shouldFail = true

      const successAdapter = new MockSourceAdapter({
        id: 'success-source',
        name: 'Success Source',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })
      successAdapter.repositories = [
        {
          id: '1',
          name: 'skill-1',
          url: 'https://github.com/test/skill-1',
          description: 'Skill 1',
          owner: 'test',
          defaultBranch: 'main',
          stars: 10,
          forks: 2,
          topics: [],
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          license: 'MIT',
          metadata: {},
        },
      ]

      const result = await pipeline.run({
        sources: [{ adapter: failingAdapter }, { adapter: successAdapter }],
        parser: mockParser,
        repository: mockRepository,
        continueOnError: true,
      })

      expect(result.status).toBe('completed')
      expect(result.summary.failedSources).toBe(1)
      expect(result.summary.successfulSources).toBe(1)
    })

    it('should return failed status on source error without continueOnError', async () => {
      const failingAdapter = new MockSourceAdapter({
        id: 'failing-source',
        name: 'Failing Source',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })
      failingAdapter.shouldFail = true

      const result = await pipeline.run({
        sources: [{ adapter: failingAdapter }],
        parser: mockParser,
        repository: mockRepository,
        continueOnError: false,
      })

      // With continueOnError: false, errors are recorded and status is 'failed'
      expect(result.status).toBe('failed')
      expect(result.summary.failedSources).toBe(1)
      expect(result.sourceResults[0].error).toBe('Search failed')
    })

    it('should call onError callback', async () => {
      const failingAdapter = new MockSourceAdapter({
        id: 'failing-source',
        name: 'Failing Source',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })
      failingAdapter.shouldFail = true

      const onError = vi.fn()

      await pipeline.run({
        sources: [{ adapter: failingAdapter }],
        parser: mockParser,
        repository: mockRepository,
        continueOnError: true,
        onError,
      })

      expect(onError).toHaveBeenCalledWith('failing-source', expect.any(Error))
    })
  })

  describe('Progress tracking', () => {
    it('should call onProgress callback', async () => {
      const adapter = new MockSourceAdapter({
        id: 'test-source',
        name: 'Test Source',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      const onProgress = vi.fn()

      await pipeline.run({
        sources: [{ adapter }],
        parser: mockParser,
        repository: mockRepository,
        onProgress,
      })

      expect(onProgress).toHaveBeenCalled()
      const lastCall = onProgress.mock.calls[
        onProgress.mock.calls.length - 1
      ][0] as PipelineProgress
      expect(lastCall.status).toBe('running')
      expect(lastCall.sourcesCompleted).toBe(1)
    })

    it('should call onSourceComplete callback', async () => {
      const adapter = new MockSourceAdapter({
        id: 'test-source',
        name: 'Test Source',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      const onSourceComplete = vi.fn()

      await pipeline.run({
        sources: [{ adapter }],
        parser: mockParser,
        repository: mockRepository,
        onSourceComplete,
      })

      expect(onSourceComplete).toHaveBeenCalledWith('test-source', expect.any(Object))
    })

    it('should return null progress when not running', () => {
      expect(pipeline.getProgress()).toBeNull()
    })
  })

  describe('Source priority', () => {
    it('should process sources in priority order', async () => {
      const order: string[] = []

      const adapter1 = new MockSourceAdapter({
        id: 'low-priority',
        name: 'Low Priority',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      const adapter2 = new MockSourceAdapter({
        id: 'high-priority',
        name: 'High Priority',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await pipeline.run({
        sources: [
          { adapter: adapter1, priority: 100 },
          { adapter: adapter2, priority: 1 },
        ],
        parser: mockParser,
        repository: mockRepository,
        onSourceComplete: (sourceId) => order.push(sourceId),
      })

      expect(order).toEqual(['high-priority', 'low-priority'])
    })
  })

  describe('Cancellation', () => {
    it('should cancel when not running', () => {
      expect(pipeline.cancel()).toBe(false)
    })
  })

  describe('Run ID', () => {
    it('should use provided run ID', async () => {
      const adapter = new MockSourceAdapter({
        id: 'test-source',
        name: 'Test Source',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      const result = await pipeline.run({
        sources: [{ adapter }],
        parser: mockParser,
        repository: mockRepository,
        runId: 'custom-run-id',
      })

      expect(result.runId).toBe('custom-run-id')
    })

    it('should generate run ID if not provided', async () => {
      const adapter = new MockSourceAdapter({
        id: 'test-source',
        name: 'Test Source',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      const result = await pipeline.run({
        sources: [{ adapter }],
        parser: mockParser,
        repository: mockRepository,
      })

      expect(result.runId).toMatch(/^run-\d{8}-\d{6}-[a-z0-9]+$/)
    })
  })

  describe('Result structure', () => {
    it('should include all required fields in result', async () => {
      const adapter = new MockSourceAdapter({
        id: 'test-source',
        name: 'Test Source',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      const result = await pipeline.run({
        sources: [{ adapter }],
        parser: mockParser,
        repository: mockRepository,
      })

      expect(result).toHaveProperty('runId')
      expect(result).toHaveProperty('status')
      expect(result).toHaveProperty('startedAt')
      expect(result).toHaveProperty('completedAt')
      expect(result).toHaveProperty('durationMs')
      expect(result).toHaveProperty('sourceResults')
      expect(result).toHaveProperty('summary')

      expect(result.summary).toHaveProperty('totalSources')
      expect(result.summary).toHaveProperty('successfulSources')
      expect(result.summary).toHaveProperty('failedSources')
      expect(result.summary).toHaveProperty('totalSkills')
      expect(result.summary).toHaveProperty('skillsCreated')
      expect(result.summary).toHaveProperty('skillsUpdated')
      expect(result.summary).toHaveProperty('skillsUnchanged')
      expect(result.summary).toHaveProperty('skillsFailed')
    })
  })
})

describe('runDailyIndex helper', () => {
  it('should run pipeline with simplified API', async () => {
    const adapter = new MockSourceAdapter({
      id: 'test-source',
      name: 'Test Source',
      type: 'custom',
      baseUrl: 'https://example.com',
      enabled: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })

    const mockParser: ISkillParser = {
      parse: vi.fn().mockReturnValue({
        name: 'Test Skill',
        description: 'A test skill',
        author: 'test',
        version: '1.0.0',
        tags: ['test'],
        dependencies: [],
        category: null,
        license: 'MIT',
        rawContent: '# Test',
        repoUrl: '',
        filePath: '',
        sha: '',
        owner: '',
        repo: '',
      }),
    }

    const mockRepository: ISkillRepository = {
      upsertFromMetadata: vi.fn().mockResolvedValue({
        id: 'skill-1',
        action: 'created' as const,
      }),
      getSkillBySha: vi.fn().mockResolvedValue(null),
    }

    const result = await runDailyIndex([{ adapter }], mockParser, mockRepository)

    expect(result.status).toBe('completed')
  })
})

describe('createScheduledPipeline', () => {
  it('should create a scheduled pipeline', () => {
    const adapter = new MockSourceAdapter({
      id: 'test-source',
      name: 'Test Source',
      type: 'custom',
      baseUrl: 'https://example.com',
      enabled: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })

    const mockParser: ISkillParser = {
      parse: vi.fn().mockReturnValue({
        name: 'Test Skill',
        description: 'A test skill',
        author: 'test',
        version: '1.0.0',
        tags: ['test'],
        dependencies: [],
        category: null,
        license: 'MIT',
        rawContent: '# Test',
        repoUrl: '',
        filePath: '',
        sha: '',
        owner: '',
        repo: '',
      }),
    }

    const mockRepository: ISkillRepository = {
      upsertFromMetadata: vi.fn().mockResolvedValue({
        id: 'skill-1',
        action: 'created' as const,
      }),
      getSkillBySha: vi.fn().mockResolvedValue(null),
    }

    const scheduled = createScheduledPipeline(
      {
        sources: [{ adapter }],
        parser: mockParser,
        repository: mockRepository,
      },
      { intervalMs: 60000 }
    )

    expect(scheduled).toHaveProperty('start')
    expect(scheduled).toHaveProperty('stop')
    expect(scheduled).toHaveProperty('isRunning')
    expect(scheduled).toHaveProperty('getLastResult')

    expect(scheduled.isRunning()).toBe(false)
    expect(scheduled.getLastResult()).toBeNull()
  })
})

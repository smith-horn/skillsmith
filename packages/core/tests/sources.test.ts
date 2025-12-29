/**
 * Source Adapter Architecture Tests (SMI-589)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  BaseSourceAdapter,
  SourceAdapterRegistry,
  SourceIndexer,
  isSourceAdapter,
  type ISourceAdapter,
  type SourceConfig,
  type SourceLocation,
  type SourceRepository,
  type SourceSearchOptions,
  type SourceSearchResult,
  type SkillContent,
  type SourceHealth,
  type ISkillParser,
  type ISkillRepository,
  type ParsedSkillMetadata,
} from '../src/sources/index.js'

/**
 * Mock source adapter for testing
 */
class MockSourceAdapter extends BaseSourceAdapter {
  public searchCalls: SourceSearchOptions[] = []
  public fetchCalls: SourceLocation[] = []

  protected async doHealthCheck(): Promise<Partial<SourceHealth>> {
    return { healthy: true }
  }

  async search(options: SourceSearchOptions): Promise<SourceSearchResult> {
    await this.waitForRateLimit()
    this.searchCalls.push(options)
    return {
      repositories: [
        {
          id: 'test-repo',
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
      ],
      totalCount: 1,
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
    this.fetchCalls.push(location)
    return {
      rawContent: `---
name: "Test Skill"
description: "A test skill for testing"
---
# Test Skill`,
      sha: 'abc123',
      location,
      filePath: 'SKILL.md',
      encoding: 'utf-8',
    }
  }
}

describe('Source Adapter Architecture (SMI-589)', () => {
  describe('BaseSourceAdapter', () => {
    let adapter: MockSourceAdapter
    const config: SourceConfig = {
      id: 'test-adapter',
      name: 'Test Adapter',
      type: 'custom',
      baseUrl: 'https://example.com',
      enabled: true,
      rateLimit: {
        maxRequests: 10,
        windowMs: 1000,
        minDelayMs: 10,
      },
    }

    beforeEach(() => {
      adapter = new MockSourceAdapter(config)
    })

    it('should store configuration', () => {
      expect(adapter.id).toBe('test-adapter')
      expect(adapter.name).toBe('Test Adapter')
      expect(adapter.type).toBe('custom')
      expect(adapter.config.baseUrl).toBe('https://example.com')
    })

    it('should initialize successfully', async () => {
      await expect(adapter.initialize()).resolves.not.toThrow()
    })

    it('should check health', async () => {
      const health = await adapter.checkHealth()
      expect(health.healthy).toBe(true)
      expect(health.lastCheck).toBeDefined()
      expect(health.responseTimeMs).toBeGreaterThanOrEqual(0)
    })

    it('should search for repositories', async () => {
      const result = await adapter.search({ topics: ['claude-skill'] })
      expect(result.repositories).toHaveLength(1)
      expect(result.repositories[0].name).toBe('test-skill')
      expect(adapter.searchCalls).toHaveLength(1)
    })

    it('should fetch skill content', async () => {
      const content = await adapter.fetchSkillContent({
        owner: 'test',
        repo: 'test-skill',
      })
      expect(content.rawContent).toContain('Test Skill')
      expect(content.sha).toBe('abc123')
    })

    it('should check if skill exists', async () => {
      const exists = await adapter.skillExists({
        owner: 'test',
        repo: 'test-skill',
      })
      expect(exists).toBe(true)
    })

    it('should get skill SHA', async () => {
      const sha = await adapter.getSkillSha({
        owner: 'test',
        repo: 'test-skill',
      })
      expect(sha).toBe('abc123')
    })

    it('should dispose without error', async () => {
      await expect(adapter.dispose()).resolves.not.toThrow()
    })
  })

  describe('SourceAdapterRegistry', () => {
    let registry: SourceAdapterRegistry
    const mockFactory = (config: SourceConfig) => new MockSourceAdapter(config)

    beforeEach(() => {
      registry = new SourceAdapterRegistry()
    })

    it('should register adapter factory', () => {
      registry.registerFactory('custom', mockFactory)
      expect(registry.hasFactory('custom')).toBe(true)
      expect(registry.getRegisteredTypes()).toContain('custom')
    })

    it('should throw on duplicate factory registration', () => {
      registry.registerFactory('custom', mockFactory)
      expect(() => registry.registerFactory('custom', mockFactory)).toThrow(
        'Factory already registered'
      )
    })

    it('should unregister factory', () => {
      registry.registerFactory('custom', mockFactory)
      registry.unregisterFactory('custom')
      expect(registry.hasFactory('custom')).toBe(false)
    })

    it('should create adapter from factory', async () => {
      registry.registerFactory('custom', mockFactory)
      const adapter = await registry.create({
        id: 'test-1',
        name: 'Test',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
      })

      expect(adapter.id).toBe('test-1')
      expect(registry.has('test-1')).toBe(true)
    })

    it('should throw on duplicate adapter ID', async () => {
      registry.registerFactory('custom', mockFactory)
      await registry.create({
        id: 'test-1',
        name: 'Test',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
      })

      await expect(
        registry.create({
          id: 'test-1',
          name: 'Test 2',
          type: 'custom',
          baseUrl: 'https://example.com',
          enabled: true,
        })
      ).rejects.toThrow('Adapter already exists')
    })

    it('should get adapter by ID', async () => {
      registry.registerFactory('custom', mockFactory)
      await registry.create({
        id: 'test-1',
        name: 'Test',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
      })

      const adapter = registry.get('test-1')
      expect(adapter).toBeDefined()
      expect(adapter?.id).toBe('test-1')
    })

    it('should get adapters by type', async () => {
      registry.registerFactory('custom', mockFactory)
      await registry.create({
        id: 'test-1',
        name: 'Test 1',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
      })
      await registry.create({
        id: 'test-2',
        name: 'Test 2',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
      })

      const adapters = registry.getByType('custom')
      expect(adapters).toHaveLength(2)
    })

    it('should get enabled adapters', async () => {
      registry.registerFactory('custom', mockFactory)
      await registry.create({
        id: 'enabled',
        name: 'Enabled',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
      })
      await registry.create({
        id: 'disabled',
        name: 'Disabled',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: false,
      })

      const enabled = registry.getEnabled()
      expect(enabled).toHaveLength(1)
      expect(enabled[0].id).toBe('enabled')
    })

    it('should remove adapter', async () => {
      registry.registerFactory('custom', mockFactory)
      await registry.create({
        id: 'test-1',
        name: 'Test',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
      })

      await registry.remove('test-1')
      expect(registry.has('test-1')).toBe(false)
    })

    it('should get registry stats', async () => {
      registry.registerFactory('custom', mockFactory)
      await registry.create({
        id: 'test-1',
        name: 'Test',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
      })

      const stats = registry.getStats()
      expect(stats.totalFactories).toBe(1)
      expect(stats.totalAdapters).toBe(1)
      expect(stats.enabledAdapters).toBe(1)
      expect(stats.adaptersByType.custom).toBe(1)
    })
  })

  describe('SourceIndexer', () => {
    let adapter: MockSourceAdapter
    let parser: ISkillParser
    let repository: ISkillRepository
    let indexer: SourceIndexer

    beforeEach(() => {
      adapter = new MockSourceAdapter({
        id: 'test',
        name: 'Test',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
      })

      parser = {
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

      repository = {
        upsertFromMetadata: vi.fn().mockResolvedValue({
          id: 'skill-1',
          action: 'created' as const,
        }),
        getSkillBySha: vi.fn().mockResolvedValue(null),
      }

      indexer = new SourceIndexer(adapter, parser, repository)
    })

    it('should index all skills from source', async () => {
      const result = await indexer.indexAll({ topics: ['claude-skill'] })

      expect(result.sourceId).toBe('test')
      expect(result.total).toBe(1)
      expect(result.created).toBe(1)
      expect(result.failed).toBe(0)
      expect(parser.parse).toHaveBeenCalled()
      expect(repository.upsertFromMetadata).toHaveBeenCalled()
    })

    it('should skip unchanged skills', async () => {
      vi.mocked(repository.getSkillBySha).mockResolvedValue({ id: 'existing' })

      const result = await indexer.indexAll({})

      expect(result.unchanged).toBe(1)
      expect(result.created).toBe(0)
      expect(repository.upsertFromMetadata).not.toHaveBeenCalled()
    })

    it('should handle parse failures', async () => {
      vi.mocked(parser.parse).mockReturnValue(null)

      const result = await indexer.indexAll({})

      expect(result.failed).toBe(1)
      expect(result.errors).toHaveLength(1)
    })

    it('should index specific URLs', async () => {
      const result = await indexer.indexUrls(['https://github.com/test/test-skill'])

      expect(result.total).toBe(1)
      expect(result.created).toBe(1)
    })

    it('should handle invalid URLs', async () => {
      const result = await indexer.indexUrls(['not-a-url'])

      expect(result.failed).toBe(1)
      expect(result.errors[0]).toContain('Invalid repository URL')
    })

    it('should call progress callback', async () => {
      const onProgress = vi.fn()
      const indexerWithProgress = new SourceIndexer(adapter, parser, repository, {
        onProgress,
      })

      await indexerWithProgress.indexAll({})

      expect(onProgress).toHaveBeenCalledWith(1, 1, 'test-skill')
    })
  })

  describe('isSourceAdapter', () => {
    it('should return true for valid adapter', () => {
      const adapter = new MockSourceAdapter({
        id: 'test',
        name: 'Test',
        type: 'custom',
        baseUrl: 'https://example.com',
        enabled: true,
      })
      expect(isSourceAdapter(adapter)).toBe(true)
    })

    it('should return false for non-adapter objects', () => {
      expect(isSourceAdapter(null)).toBe(false)
      expect(isSourceAdapter(undefined)).toBe(false)
      expect(isSourceAdapter({})).toBe(false)
      expect(isSourceAdapter({ id: 'test' })).toBe(false)
    })
  })
})

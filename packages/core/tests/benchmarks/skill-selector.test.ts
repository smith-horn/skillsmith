import { describe, it, expect } from 'vitest'
import {
  createBaselineSelector,
  createCuratedSelector,
  createIterativeSelector,
  createSearchSelector,
  createRecommendSelector,
  createOptimizedSelector,
  createHybridSelector,
  createEvoSkillEvolvedSelector,
  NotImplementedError,
  CONDITIONS,
} from '../../src/benchmarks/evoskill/skill-selector.js'
import type { BenchmarkTask } from '../../src/benchmarks/evoskill/types.js'

const tasks: BenchmarkTask[] = [
  { id: 't1', question: 'What is 2+2?', groundTruth: '4', split: 'test', benchmark: 'officeqa' },
  { id: 't2', question: 'Capital of France?', groundTruth: 'Paris', split: 'test', benchmark: 'officeqa' },
]

describe('createBaselineSelector (condition 1)', () => {
  it('returns empty array', async () => {
    const selector = createBaselineSelector()
    const skills = await selector(tasks)
    expect(skills).toEqual([])
  })
})

describe('createCuratedSelector (condition 9)', () => {
  it('returns provided skill contents', async () => {
    const skills = ['skill content 1', 'skill content 2']
    const selector = createCuratedSelector(skills)
    const result = await selector(tasks)
    expect(result).toEqual(skills)
  })

  it('returns empty for empty input', async () => {
    const selector = createCuratedSelector([])
    const result = await selector(tasks)
    expect(result).toEqual([])
  })
})

describe('createSearchSelector (condition 3)', () => {
  it('calls search client and returns top result', async () => {
    const mockClient = {
      search: async () => [
        { content: 'best skill', score: 0.95 },
        { content: 'second skill', score: 0.8 },
      ],
    }
    const selector = createSearchSelector(mockClient)
    const result = await selector(tasks)
    expect(result).toEqual(['best skill'])
  })

  it('returns empty when search finds nothing', async () => {
    const mockClient = { search: async () => [] }
    const selector = createSearchSelector(mockClient)
    const result = await selector(tasks)
    expect(result).toEqual([])
  })
})

describe('createRecommendSelector (condition 4)', () => {
  it('calls recommend client and returns top result', async () => {
    const mockClient = {
      recommend: async () => [{ content: 'recommended skill', score: 0.9 }],
    }
    const selector = createRecommendSelector(mockClient)
    const result = await selector(tasks)
    expect(result).toEqual(['recommended skill'])
  })
})

describe('createIterativeSelector (condition 7)', () => {
  it('throws NotImplementedError', async () => {
    const selector = createIterativeSelector()
    await expect(selector(tasks)).rejects.toThrow(NotImplementedError)
    await expect(selector(tasks)).rejects.toThrow('Study B')
  })
})

describe('createOptimizedSelector (condition 5)', () => {
  it('searches then optimizes the top result', async () => {
    const mockSearch = { search: async () => [{ content: 'base skill', score: 0.9 }] }
    const mockTransform = { optimize: async (s: string) => `optimized: ${s}` }
    const selector = createOptimizedSelector(mockSearch, mockTransform)
    const result = await selector(tasks)
    expect(result).toEqual(['optimized: base skill'])
  })

  it('returns empty when search finds nothing', async () => {
    const mockSearch = { search: async () => [] }
    const mockTransform = { optimize: async (s: string) => s }
    const selector = createOptimizedSelector(mockSearch, mockTransform)
    const result = await selector(tasks)
    expect(result).toEqual([])
  })
})

describe('createHybridSelector (condition 8)', () => {
  it('searches then evolves the top result', async () => {
    const mockSearch = { search: async () => [{ content: 'base', score: 0.8 }] }
    const evolve = async (s: string) => `evolved: ${s}`
    const selector = createHybridSelector(mockSearch, evolve)
    const result = await selector(tasks)
    expect(result).toEqual(['evolved: base'])
  })
})

describe('createEvoSkillEvolvedSelector (condition 2)', () => {
  it('rejects path traversal', () => {
    expect(() => createEvoSkillEvolvedSelector('/foo/../bar')).toThrow("must not contain '..'")
  })
})

describe('CONDITIONS registry', () => {
  it('has 9 conditions', () => {
    expect(Object.keys(CONDITIONS)).toHaveLength(9)
  })

  it('maps numbers to names', () => {
    expect(CONDITIONS[1]).toBe('baseline')
    expect(CONDITIONS[7]).toBe('skillsmith-iterative')
    expect(CONDITIONS[8]).toBe('hybrid')
    expect(CONDITIONS[9]).toBe('skillsmith-curated')
  })
})

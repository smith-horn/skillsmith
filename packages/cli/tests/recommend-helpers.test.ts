/**
 * Unit tests for recommend.helpers.ts pure logic functions
 *
 * Tests validateTrustTier, isNetworkError, buildStackFromAnalysis,
 * formatAsJson, formatOfflineResults, formatRecommendations.
 * No mocking required — all functions are pure.
 */

import { describe, it, expect } from 'vitest'
import {
  validateTrustTier,
  isNetworkError,
  buildStackFromAnalysis,
  formatAsJson,
  formatOfflineResults,
  formatRecommendations,
} from '../src/commands/recommend.helpers.js'
import type { CodebaseContext, FrameworkInfo, DependencyInfo } from '@skillsmith/core'
import type { RecommendResponse } from '../src/commands/recommend.types.js'

// ============================================================================
// Helpers
// ============================================================================

/** Minimal CodebaseContext with only the fields the helpers actually read */
function makeContext(overrides?: Partial<CodebaseContext>): CodebaseContext {
  return {
    frameworks: [
      { name: 'React', confidence: 0.95, evidence: [] },
      { name: 'Vitest', confidence: 0.8, evidence: [] },
    ],
    dependencies: [
      { name: 'react', isDev: false, version: '18.0.0' },
      { name: 'vitest', isDev: true, version: '1.0.0' },
      { name: 'express', isDev: false, version: '4.0.0' },
    ],
    stats: { totalFiles: 42, totalLines: 5000 },
    ...overrides,
  } as unknown as CodebaseContext
}

function makeResponse(overrides?: Partial<RecommendResponse>): RecommendResponse {
  return {
    recommendations: [
      {
        skill_id: 'acme/linter',
        name: 'linter',
        reason: 'Improves code quality',
        similarity_score: 0.85,
        trust_tier: 'verified',
        quality_score: 92,
        roles: ['code-quality'],
      },
    ],
    candidates_considered: 50,
    overlap_filtered: 2,
    role_filtered: 1,
    context: {
      installed_count: 3,
      has_project_context: true,
      using_semantic_matching: true,
      auto_detected: true,
    },
    timing: { totalMs: 123 },
    ...overrides,
  }
}

// ============================================================================
// validateTrustTier
// ============================================================================

describe('validateTrustTier', () => {
  it('accepts "verified"', () => {
    expect(validateTrustTier('verified')).toBe('verified')
  })

  it('accepts "community"', () => {
    expect(validateTrustTier('community')).toBe('community')
  })

  it('accepts "experimental"', () => {
    expect(validateTrustTier('experimental')).toBe('experimental')
  })

  it('accepts "unknown"', () => {
    expect(validateTrustTier('unknown')).toBe('unknown')
  })

  it('returns "unknown" for invalid string', () => {
    expect(validateTrustTier('invalid')).toBe('unknown')
  })

  it('returns "unknown" for non-string input', () => {
    expect(validateTrustTier(42)).toBe('unknown')
    expect(validateTrustTier(null)).toBe('unknown')
    expect(validateTrustTier(undefined)).toBe('unknown')
  })
})

// ============================================================================
// isNetworkError
// ============================================================================

describe('isNetworkError', () => {
  it('detects "fetch failed"', () => {
    expect(isNetworkError(new Error('fetch failed'))).toBe(true)
  })

  it('detects "network" errors', () => {
    expect(isNetworkError(new Error('Network error occurred'))).toBe(true)
  })

  it('detects ENOTFOUND', () => {
    expect(isNetworkError(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe(true)
  })

  it('detects ECONNREFUSED', () => {
    expect(isNetworkError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))).toBe(true)
  })

  it('detects timeout', () => {
    expect(isNetworkError(new Error('request timeout'))).toBe(true)
  })

  it('detects socket errors', () => {
    expect(isNetworkError(new Error('socket hang up'))).toBe(true)
  })

  it('detects AbortError by name', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    expect(isNetworkError(err)).toBe(true)
  })

  it('returns false for non-network errors', () => {
    expect(isNetworkError(new Error('syntax error'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isNetworkError('string')).toBe(false)
    expect(isNetworkError(42)).toBe(false)
    expect(isNetworkError(null)).toBe(false)
  })
})

// ============================================================================
// buildStackFromAnalysis
// ============================================================================

describe('buildStackFromAnalysis', () => {
  it('builds stack from frameworks and prod dependencies', () => {
    const ctx = makeContext()
    const stack = buildStackFromAnalysis(ctx)
    expect(stack).toContain('react')
    expect(stack).toContain('vitest')
    expect(stack).toContain('express')
  })

  it('excludes dev dependencies', () => {
    const ctx = makeContext({
      dependencies: [{ name: 'vitest', isDev: true, version: '1.0.0' }] as DependencyInfo[],
      frameworks: [],
    })
    const stack = buildStackFromAnalysis(ctx)
    expect(stack).not.toContain('vitest')
  })

  it('deduplicates entries', () => {
    const ctx = makeContext({
      frameworks: [{ name: 'React', confidence: 0.9, evidence: [] }] as FrameworkInfo[],
      dependencies: [{ name: 'react', isDev: false, version: '18.0.0' }] as DependencyInfo[],
    })
    const stack = buildStackFromAnalysis(ctx)
    const reactCount = stack.filter((s) => s === 'react').length
    expect(reactCount).toBe(1)
  })

  it('caps output at 10 items', () => {
    const deps = Array.from({ length: 20 }, (_, i) => ({
      name: `dep-${i}`,
      isDev: false,
      version: '1.0.0',
    })) as DependencyInfo[]
    const ctx = makeContext({ dependencies: deps, frameworks: [] })
    const stack = buildStackFromAnalysis(ctx)
    expect(stack.length).toBeLessThanOrEqual(10)
  })

  it('returns empty array for empty context', () => {
    const ctx = makeContext({ frameworks: [], dependencies: [] })
    expect(buildStackFromAnalysis(ctx)).toEqual([])
  })
})

// ============================================================================
// formatAsJson
// ============================================================================

describe('formatAsJson', () => {
  it('returns valid JSON', () => {
    const output = formatAsJson(makeResponse(), makeContext())
    expect(() => JSON.parse(output)).not.toThrow()
  })

  it('includes recommendations in output', () => {
    const parsed = JSON.parse(formatAsJson(makeResponse(), makeContext()))
    expect(parsed.recommendations).toHaveLength(1)
    expect(parsed.recommendations[0].name).toBe('linter')
  })

  it('includes analysis when context provided', () => {
    const parsed = JSON.parse(formatAsJson(makeResponse(), makeContext()))
    expect(parsed.analysis).not.toBeNull()
    expect(parsed.analysis.frameworks).toHaveLength(2)
    expect(parsed.analysis.frameworks[0].confidence).toBe(95)
  })

  it('sets analysis to null when no context', () => {
    const parsed = JSON.parse(formatAsJson(makeResponse(), null))
    expect(parsed.analysis).toBeNull()
  })

  it('includes meta fields', () => {
    const parsed = JSON.parse(formatAsJson(makeResponse(), null))
    expect(parsed.meta.candidates_considered).toBe(50)
    expect(parsed.meta.overlap_filtered).toBe(2)
    expect(parsed.meta.role_filtered).toBe(1)
    expect(parsed.meta.timing_ms).toBe(123)
  })

  it('separates prod and dev dependencies', () => {
    const parsed = JSON.parse(formatAsJson(makeResponse(), makeContext()))
    const vitest = parsed.analysis.dependencies.find((d: { name: string }) => d.name === 'vitest')
    expect(vitest.is_dev).toBe(true)
  })
})

// ============================================================================
// formatRecommendations
// ============================================================================

describe('formatRecommendations', () => {
  it('includes recommendation count', () => {
    const output = formatRecommendations(makeResponse(), makeContext())
    expect(output).toContain('1')
    expect(output).toContain('recommendation')
  })

  it('includes skill name', () => {
    const output = formatRecommendations(makeResponse(), null)
    expect(output).toContain('linter')
  })

  it('includes candidates considered', () => {
    const output = formatRecommendations(makeResponse(), null)
    expect(output).toContain('50')
  })

  it('shows detected frameworks from context', () => {
    const output = formatRecommendations(makeResponse(), makeContext())
    expect(output).toContain('React')
  })

  it('shows suggestions when no recommendations', () => {
    const response = makeResponse({ recommendations: [] })
    const output = formatRecommendations(response, null)
    expect(output).toContain('No recommendations found')
    expect(output).toContain('package.json')
  })

  it('shows role filter hint when active and no results', () => {
    const response = makeResponse({
      recommendations: [],
      context: {
        installed_count: 0,
        has_project_context: true,
        using_semantic_matching: true,
        auto_detected: false,
        role_filter: 'testing',
      },
    })
    const output = formatRecommendations(response, null)
    expect(output).toContain('--role')
    expect(output).toContain('testing')
  })

  it('shows overlap filtered count', () => {
    const output = formatRecommendations(makeResponse(), null)
    expect(output).toContain('2')
  })

  it('shows timing', () => {
    const output = formatRecommendations(makeResponse(), null)
    expect(output).toContain('123ms')
  })

  it('displays N/A for negative similarity scores', () => {
    const response = makeResponse({
      recommendations: [
        {
          skill_id: 'a/b',
          name: 'test',
          reason: 'r',
          similarity_score: -1,
          trust_tier: 'community',
          quality_score: 50,
        },
      ],
    })
    const output = formatRecommendations(response, null)
    expect(output).toContain('N/A')
  })
})

// ============================================================================
// formatOfflineResults
// ============================================================================

describe('formatOfflineResults', () => {
  it('returns JSON when json flag is true', () => {
    const output = formatOfflineResults(makeContext(), true)
    const parsed = JSON.parse(output)
    expect(parsed.offline).toBe(true)
    expect(parsed.analysis.frameworks).toHaveLength(2)
    expect(parsed.message).toContain('Unable to reach')
  })

  it('includes stats in JSON output', () => {
    const parsed = JSON.parse(formatOfflineResults(makeContext(), true))
    expect(parsed.analysis.stats.total_files).toBe(42)
    expect(parsed.analysis.stats.total_lines).toBe(5000)
  })

  it('shows offline warning in text mode', () => {
    const output = formatOfflineResults(makeContext(), false)
    expect(output).toContain('Unable to reach Skillsmith API')
  })

  it('shows frameworks in text mode', () => {
    const output = formatOfflineResults(makeContext(), false)
    expect(output).toContain('React')
    expect(output).toContain('95%')
  })

  it('shows prod dependencies in text mode', () => {
    const output = formatOfflineResults(makeContext(), false)
    expect(output).toContain('react')
    expect(output).toContain('express')
  })

  it('shows file stats in text mode', () => {
    const output = formatOfflineResults(makeContext(), false)
    expect(output).toContain('42')
    expect(output).toContain('5,000')
  })

  it('handles empty frameworks', () => {
    const ctx = makeContext({ frameworks: [] })
    const output = formatOfflineResults(ctx, false)
    expect(output).not.toContain('Detected Frameworks')
  })

  it('handles empty dependencies', () => {
    const ctx = makeContext({ dependencies: [] })
    const output = formatOfflineResults(ctx, false)
    expect(output).not.toContain('Key Dependencies')
  })
})

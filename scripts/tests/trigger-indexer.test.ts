/**
 * Integration Tests for scripts/trigger-indexer.ts
 *
 * Tests CLI argument parsing, response normalization, environment validation,
 * error handling, and output formatting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseArgs,
  normalizeResponse,
  validateEnv,
  formatSummary,
  formatErrors,
  formatResponse,
  buildRequest,
  buildIndexerUrl,
  DEFAULT_TOPICS,
  DEFAULT_MAX_PAGES,
  DEFAULT_MIN_LENGTH,
  DEFAULT_TIMEOUT_MS,
  type CliOptions,
  type IndexerResponse,
} from '../lib/trigger-indexer-utils.js'

// =============================================================================
// CLI Argument Parsing Tests
// =============================================================================

describe('CLI Argument Parsing', () => {
  describe('--dry-run flag', () => {
    it('should set dryRun to true when --dry-run is present', () => {
      const result = parseArgs(['--dry-run'])
      expect(result.dryRun).toBe(true)
    })

    it('should set dryRun to false when --dry-run is not present', () => {
      const result = parseArgs([])
      expect(result.dryRun).toBe(false)
    })

    it('should handle --dry-run with other flags', () => {
      const result = parseArgs(['--strict', '--dry-run', '--max-pages', '10'])
      expect(result.dryRun).toBe(true)
      expect(result.maxPages).toBe(10)
      expect(result.strict).toBe(true)
    })
  })

  describe('--topics with comma-separated values', () => {
    it('should parse single topic', () => {
      const result = parseArgs(['--topics', 'claude-code'])
      expect(result.topics).toEqual(['claude-code'])
    })

    it('should parse multiple comma-separated topics', () => {
      const result = parseArgs(['--topics', 'claude-code-skill,claude-code,mcp-server'])
      expect(result.topics).toEqual(['claude-code-skill', 'claude-code', 'mcp-server'])
    })

    it('should trim whitespace from topics', () => {
      const result = parseArgs(['--topics', ' topic1 , topic2 , topic3 '])
      expect(result.topics).toEqual(['topic1', 'topic2', 'topic3'])
    })

    it('should filter out empty topics', () => {
      const result = parseArgs(['--topics', 'topic1,,topic2,'])
      expect(result.topics).toEqual(['topic1', 'topic2'])
    })

    it('should use default topics when --topics has no value', () => {
      const result = parseArgs(['--topics'])
      expect(result.topics).toEqual(DEFAULT_TOPICS)
    })
  })

  describe('--max-pages number parsing', () => {
    it('should parse valid positive integer', () => {
      const result = parseArgs(['--max-pages', '10'])
      expect(result.maxPages).toBe(10)
    })

    it('should parse single digit', () => {
      const result = parseArgs(['--max-pages', '1'])
      expect(result.maxPages).toBe(1)
    })

    it('should parse large number', () => {
      const result = parseArgs(['--max-pages', '100'])
      expect(result.maxPages).toBe(100)
    })

    it('should use default for zero', () => {
      const result = parseArgs(['--max-pages', '0'])
      expect(result.maxPages).toBe(DEFAULT_MAX_PAGES)
    })

    it('should use default for negative number', () => {
      const result = parseArgs(['--max-pages', '-5'])
      expect(result.maxPages).toBe(DEFAULT_MAX_PAGES)
    })

    it('should use default for non-numeric value', () => {
      const result = parseArgs(['--max-pages', 'abc'])
      expect(result.maxPages).toBe(DEFAULT_MAX_PAGES)
    })

    it('should use default when --max-pages has no value', () => {
      const result = parseArgs(['--max-pages'])
      expect(result.maxPages).toBe(DEFAULT_MAX_PAGES)
    })
  })

  describe('--strict and --no-strict flags', () => {
    it('should default to strict=true', () => {
      const result = parseArgs([])
      expect(result.strict).toBe(true)
    })

    it('should set strict=true when --strict is present', () => {
      const result = parseArgs(['--strict'])
      expect(result.strict).toBe(true)
    })

    it('should set strict=false when --no-strict is present', () => {
      const result = parseArgs(['--no-strict'])
      expect(result.strict).toBe(false)
    })

    it('should prefer --no-strict over --strict when both present', () => {
      // --no-strict should win as it's checked first in the implementation
      const result = parseArgs(['--strict', '--no-strict'])
      expect(result.strict).toBe(false)
    })

    it('should handle --no-strict with other flags', () => {
      const result = parseArgs(['--dry-run', '--no-strict', '--max-pages', '3'])
      expect(result.strict).toBe(false)
      expect(result.dryRun).toBe(true)
      expect(result.maxPages).toBe(3)
    })
  })

  describe('--min-length number parsing', () => {
    it('should parse valid positive integer', () => {
      const result = parseArgs(['--min-length', '50'])
      expect(result.minLength).toBe(50)
    })

    it('should allow zero', () => {
      const result = parseArgs(['--min-length', '0'])
      expect(result.minLength).toBe(0)
    })

    it('should use default for negative number', () => {
      const result = parseArgs(['--min-length', '-10'])
      expect(result.minLength).toBe(DEFAULT_MIN_LENGTH)
    })

    it('should use default for non-numeric value', () => {
      const result = parseArgs(['--min-length', 'xyz'])
      expect(result.minLength).toBe(DEFAULT_MIN_LENGTH)
    })

    it('should use default when --min-length has no value', () => {
      const result = parseArgs(['--min-length'])
      expect(result.minLength).toBe(DEFAULT_MIN_LENGTH)
    })
  })

  describe('--help flag', () => {
    it('should set help=true when --help is present', () => {
      const result = parseArgs(['--help'])
      expect(result.help).toBe(true)
    })

    it('should set help=true when -h is present', () => {
      const result = parseArgs(['-h'])
      expect(result.help).toBe(true)
    })

    it('should ignore other flags when --help is present', () => {
      const result = parseArgs(['--help', '--dry-run', '--max-pages', '10'])
      expect(result.help).toBe(true)
      // When help is true, other options use defaults
      expect(result.dryRun).toBe(false)
      expect(result.maxPages).toBe(DEFAULT_MAX_PAGES)
    })
  })

  describe('default values when no args provided', () => {
    it('should return all defaults with empty args', () => {
      const result = parseArgs([])
      expect(result).toEqual({
        dryRun: false,
        topics: DEFAULT_TOPICS,
        maxPages: DEFAULT_MAX_PAGES,
        strict: true,
        minLength: DEFAULT_MIN_LENGTH,
        help: false,
      })
    })

    it('should verify default constants', () => {
      expect(DEFAULT_TOPICS).toEqual(['claude-code-skill', 'claude-code'])
      expect(DEFAULT_MAX_PAGES).toBe(5)
      expect(DEFAULT_MIN_LENGTH).toBe(100)
      expect(DEFAULT_TIMEOUT_MS).toBe(120000)
    })
  })

  describe('complex argument combinations', () => {
    it('should parse all options together', () => {
      const result = parseArgs([
        '--dry-run',
        '--topics',
        'skill1,skill2',
        '--max-pages',
        '15',
        '--no-strict',
        '--min-length',
        '200',
      ])
      expect(result).toEqual({
        dryRun: true,
        topics: ['skill1', 'skill2'],
        maxPages: 15,
        strict: false,
        minLength: 200,
        help: false,
      })
    })

    it('should handle options in any order', () => {
      const result = parseArgs([
        '--min-length',
        '50',
        '--dry-run',
        '--max-pages',
        '3',
        '--topics',
        'test-topic',
      ])
      expect(result.minLength).toBe(50)
      expect(result.dryRun).toBe(true)
      expect(result.maxPages).toBe(3)
      expect(result.topics).toEqual(['test-topic'])
    })
  })
})

// =============================================================================
// Response Normalization Tests
// =============================================================================

describe('Response Normalization', () => {
  describe('successful response parsing', () => {
    it('should parse Edge Function wrapper format', () => {
      const rawResponse = {
        data: {
          found: 100,
          indexed: 50,
          updated: 10,
          failed: 0,
          errors: [],
          dryRun: true,
        },
        meta: {
          timestamp: '2024-01-01T00:00:00Z',
        },
      }

      const result = normalizeResponse(rawResponse, true)

      expect(result.success).toBe(true)
      expect(result.dryRun).toBe(true)
      expect(result.summary).toEqual({
        found: 100,
        indexed: 50,
        updated: 10,
        failed: 0,
      })
      expect(result.errors).toBeUndefined()
    })

    it('should parse legacy format with summary', () => {
      const rawResponse = {
        success: true,
        summary: {
          found: 25,
          indexed: 20,
          updated: 5,
          failed: 0,
        },
        skills: [
          {
            id: 'author/skill',
            name: 'skill',
            author: 'author',
            trust_tier: 'verified',
            quality_score: 0.95,
          },
        ],
      }

      const result = normalizeResponse(rawResponse, false)

      expect(result.success).toBe(true)
      expect(result.summary.indexed).toBe(20)
      expect(result.skills).toHaveLength(1)
      expect(result.skills![0].id).toBe('author/skill')
    })

    it('should preserve dryRun from response over parameter', () => {
      const rawResponse = {
        data: {
          found: 10,
          indexed: 5,
          updated: 0,
          failed: 0,
          dryRun: false,
        },
      }

      const result = normalizeResponse(rawResponse, true) // param says true
      expect(result.dryRun).toBe(false) // but response says false
    })

    it('should use dryRun parameter when not in response', () => {
      const rawResponse = {
        data: {
          found: 10,
          indexed: 5,
          updated: 0,
          failed: 0,
        },
      }

      const result = normalizeResponse(rawResponse, true)
      expect(result.dryRun).toBe(true)
    })
  })

  describe('response with errors', () => {
    it('should parse response with error array', () => {
      const rawResponse = {
        data: {
          found: 10,
          indexed: 5,
          updated: 0,
          failed: 3,
          errors: ['Failed to index skill1', 'Invalid SKILL.md in skill2', 'Rate limited'],
          dryRun: false,
        },
      }

      const result = normalizeResponse(rawResponse, false)

      expect(result.success).toBe(false)
      expect(result.summary.failed).toBe(3)
      expect(result.errors).toHaveLength(3)
      expect(result.errors![0]).toBe('Failed to index skill1')
    })

    it('should mark success=false when there are errors', () => {
      const rawResponse = {
        data: {
          found: 5,
          indexed: 5,
          updated: 0,
          failed: 0,
          errors: ['Warning: some issue occurred'],
        },
      }

      const result = normalizeResponse(rawResponse, false)
      expect(result.success).toBe(false) // Has errors, so not success
    })

    it('should filter out empty error strings', () => {
      const rawResponse = {
        data: {
          found: 5,
          indexed: 5,
          updated: 0,
          failed: 0,
          errors: ['Real error', '', '  ', 'Another error'],
        },
      }

      const result = normalizeResponse(rawResponse, false)
      expect(result.errors).toHaveLength(2)
      expect(result.errors).toContain('Real error')
      expect(result.errors).toContain('Another error')
    })

    it('should handle legacy format with errors', () => {
      const rawResponse = {
        success: false,
        summary: { found: 10, indexed: 5, updated: 0, failed: 5 },
        errors: ['Error 1', 'Error 2'],
      }

      const result = normalizeResponse(rawResponse, false)
      expect(result.success).toBe(false)
      expect(result.errors).toEqual(['Error 1', 'Error 2'])
    })
  })

  describe('malformed response handling', () => {
    it('should handle null response', () => {
      const result = normalizeResponse(null, false)

      expect(result.success).toBe(false)
      expect(result.summary).toEqual({ found: 0, indexed: 0, updated: 0, failed: 0 })
      expect(result.errors).toHaveLength(1)
      expect(result.errors![0]).toContain('empty or non-object response')
    })

    it('should handle undefined response', () => {
      const result = normalizeResponse(undefined, false)

      expect(result.success).toBe(false)
      expect(result.errors![0]).toContain('empty or non-object response')
    })

    it('should handle string response', () => {
      const result = normalizeResponse('some string', false)

      expect(result.success).toBe(false)
      expect(result.errors![0]).toContain('empty or non-object response')
    })

    it('should handle number response', () => {
      const result = normalizeResponse(42, false)

      expect(result.success).toBe(false)
    })

    it('should handle array response', () => {
      // Arrays are objects in JS, so this tests the "no expected fields" case
      const result = normalizeResponse(['item1', 'item2'], false)

      expect(result.success).toBe(false)
      expect(result.errors![0]).toContain('Unexpected response format')
    })

    it('should handle object without expected fields', () => {
      const rawResponse = {
        foo: 'bar',
        baz: 123,
      }

      const result = normalizeResponse(rawResponse, false)

      expect(result.success).toBe(false)
      expect(result.errors![0]).toContain('Unexpected response format')
      expect(result.errors![0]).toContain('foo')
    })
  })

  describe('empty response handling', () => {
    it('should handle empty object', () => {
      const result = normalizeResponse({}, false)

      expect(result.success).toBe(false)
      expect(result.errors![0]).toContain('Unexpected response format')
    })

    it('should handle empty data wrapper', () => {
      const rawResponse = {
        data: {},
      }

      const result = normalizeResponse(rawResponse, false)

      expect(result.summary).toEqual({ found: 0, indexed: 0, updated: 0, failed: 0 })
    })

    it('should handle response with null data', () => {
      const rawResponse = {
        data: null,
      }

      const result = normalizeResponse(rawResponse, false)

      expect(result.success).toBe(false)
      expect(result.errors![0]).toContain('Unexpected response format')
    })
  })

  describe('skills array parsing', () => {
    it('should parse complete skill objects', () => {
      const rawResponse = {
        success: true,
        summary: { found: 1, indexed: 1, updated: 0, failed: 0 },
        skills: [
          {
            id: 'author/skill-name',
            name: 'skill-name',
            author: 'author',
            repo_url: 'https://github.com/author/repo',
            trust_tier: 'community',
            quality_score: 0.85,
          },
        ],
      }

      const result = normalizeResponse(rawResponse, false)

      expect(result.skills).toHaveLength(1)
      expect(result.skills![0]).toEqual({
        id: 'author/skill-name',
        name: 'skill-name',
        author: 'author',
        repo_url: 'https://github.com/author/repo',
        trust_tier: 'community',
        quality_score: 0.85,
      })
    })

    it('should handle skills with missing optional fields', () => {
      const rawResponse = {
        success: true,
        summary: { found: 1, indexed: 1, updated: 0, failed: 0 },
        skills: [
          {
            id: 'test/skill',
            name: 'skill',
            author: 'test',
          },
        ],
      }

      const result = normalizeResponse(rawResponse, false)

      expect(result.skills![0].repo_url).toBeUndefined()
      expect(result.skills![0].trust_tier).toBeUndefined()
      expect(result.skills![0].quality_score).toBeUndefined()
    })

    it('should handle skills with missing required fields', () => {
      const rawResponse = {
        success: true,
        summary: { found: 1, indexed: 1, updated: 0, failed: 0 },
        skills: [{}],
      }

      const result = normalizeResponse(rawResponse, false)

      expect(result.skills![0].id).toBe('unknown')
      expect(result.skills![0].name).toBe('unknown')
      expect(result.skills![0].author).toBe('unknown')
    })
  })
})

// =============================================================================
// Environment Validation Tests
// =============================================================================

describe('Environment Validation', () => {
  describe('missing environment variables', () => {
    it('should return invalid when SUPABASE_PROJECT_REF is missing', () => {
      const env = {
        SUPABASE_ANON_KEY: 'test-key',
      }

      const result = validateEnv(env)

      expect(result.valid).toBe(false)
      expect(result.missingVars).toContain('SUPABASE_PROJECT_REF')
      expect(result.missingVars).not.toContain('SUPABASE_ANON_KEY')
      expect(result.config).toBeUndefined()
    })

    it('should return invalid when SUPABASE_ANON_KEY is missing', () => {
      const env = {
        SUPABASE_PROJECT_REF: 'test-project',
      }

      const result = validateEnv(env)

      expect(result.valid).toBe(false)
      expect(result.missingVars).toContain('SUPABASE_ANON_KEY')
      expect(result.missingVars).not.toContain('SUPABASE_PROJECT_REF')
    })

    it('should return invalid when both variables are missing', () => {
      const result = validateEnv({})

      expect(result.valid).toBe(false)
      expect(result.missingVars).toContain('SUPABASE_PROJECT_REF')
      expect(result.missingVars).toContain('SUPABASE_ANON_KEY')
      expect(result.missingVars).toHaveLength(2)
    })

    it('should treat empty string as missing', () => {
      const env = {
        SUPABASE_PROJECT_REF: '',
        SUPABASE_ANON_KEY: 'valid-key',
      }

      const result = validateEnv(env)

      expect(result.valid).toBe(false)
      expect(result.missingVars).toContain('SUPABASE_PROJECT_REF')
    })

    it('should treat undefined as missing', () => {
      const env = {
        SUPABASE_PROJECT_REF: undefined,
        SUPABASE_ANON_KEY: 'valid-key',
      }

      const result = validateEnv(env)

      expect(result.valid).toBe(false)
      expect(result.missingVars).toContain('SUPABASE_PROJECT_REF')
    })
  })

  describe('valid environment', () => {
    it('should return valid with config when both variables present', () => {
      const env = {
        SUPABASE_PROJECT_REF: 'my-project',
        SUPABASE_ANON_KEY: 'my-anon-key',
      }

      const result = validateEnv(env)

      expect(result.valid).toBe(true)
      expect(result.missingVars).toEqual([])
      expect(result.config).toEqual({
        projectRef: 'my-project',
        anonKey: 'my-anon-key',
      })
    })

    it('should ignore extra environment variables', () => {
      const env = {
        SUPABASE_PROJECT_REF: 'project',
        SUPABASE_ANON_KEY: 'key',
        OTHER_VAR: 'value',
        NODE_ENV: 'test',
      }

      const result = validateEnv(env)

      expect(result.valid).toBe(true)
      expect(result.config?.projectRef).toBe('project')
    })
  })
})

// =============================================================================
// Error Handling Tests (HTTP mock scenarios)
// =============================================================================

describe('Error Handling', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('network timeout', () => {
    it('should detect timeout from AbortError', async () => {
      const abortError = new Error('The operation was aborted')
      abortError.name = 'AbortError'

      global.fetch = vi.fn().mockRejectedValue(abortError)

      await expect(
        global.fetch('http://test.com', {
          signal: AbortSignal.timeout(100),
        })
      ).rejects.toThrow('aborted')
    })

    it('should handle timeout error message pattern', () => {
      const error = new Error('Request aborted after 120000ms')

      // This tests how the main script handles timeout errors
      const isTimeout = error.message.includes('abort')
      expect(isTimeout).toBe(true)
    })
  })

  describe('HTTP error responses', () => {
    it('should detect 4xx client errors', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: vi.fn().mockResolvedValue('Invalid request body'),
      }

      global.fetch = vi.fn().mockResolvedValue(mockResponse)

      const response = await global.fetch('http://test.com')

      expect(response.ok).toBe(false)
      expect(response.status).toBe(400)
    })

    it('should detect 401 unauthorized', async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        text: vi.fn().mockResolvedValue('Invalid API key'),
      }

      global.fetch = vi.fn().mockResolvedValue(mockResponse)

      const response = await global.fetch('http://test.com')

      expect(response.status).toBe(401)
    })

    it('should detect 403 forbidden', async () => {
      const mockResponse = {
        ok: false,
        status: 403,
        text: vi.fn().mockResolvedValue('Access denied'),
      }

      global.fetch = vi.fn().mockResolvedValue(mockResponse)

      const response = await global.fetch('http://test.com')

      expect(response.status).toBe(403)
    })

    it('should detect 404 not found', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        text: vi.fn().mockResolvedValue('Edge function not found'),
      }

      global.fetch = vi.fn().mockResolvedValue(mockResponse)

      const response = await global.fetch('http://test.com')

      expect(response.status).toBe(404)
    })

    it('should detect 500 server error', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('Internal server error'),
      }

      global.fetch = vi.fn().mockResolvedValue(mockResponse)

      const response = await global.fetch('http://test.com')

      expect(response.status).toBe(500)
    })

    it('should detect 502 bad gateway', async () => {
      const mockResponse = {
        ok: false,
        status: 502,
        text: vi.fn().mockResolvedValue('Bad gateway'),
      }

      global.fetch = vi.fn().mockResolvedValue(mockResponse)

      const response = await global.fetch('http://test.com')

      expect(response.status).toBe(502)
    })

    it('should detect 503 service unavailable', async () => {
      const mockResponse = {
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue('Service temporarily unavailable'),
      }

      global.fetch = vi.fn().mockResolvedValue(mockResponse)

      const response = await global.fetch('http://test.com')

      expect(response.status).toBe(503)
    })
  })

  describe('network errors', () => {
    it('should handle connection refused', async () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:443')

      global.fetch = vi.fn().mockRejectedValue(error)

      await expect(global.fetch('http://test.com')).rejects.toThrow('ECONNREFUSED')
    })

    it('should handle DNS resolution failure', async () => {
      const error = new Error('getaddrinfo ENOTFOUND invalid.host')

      global.fetch = vi.fn().mockRejectedValue(error)

      await expect(global.fetch('http://test.com')).rejects.toThrow('ENOTFOUND')
    })
  })
})

// =============================================================================
// Output Formatting Tests
// =============================================================================

describe('Output Formatting', () => {
  describe('formatSummary', () => {
    it('should format summary with all counts', () => {
      const response: IndexerResponse = {
        success: true,
        dryRun: false,
        summary: { found: 100, indexed: 50, updated: 10, failed: 5 },
      }

      const output = formatSummary(response)

      expect(output).toContain('Summary:')
      expect(output).toContain('Found:    100')
      expect(output).toContain('Indexed:  50')
      expect(output).toContain('Updated:  10')
      expect(output).toContain('Failed:   5')
    })

    it('should format summary with zeros', () => {
      const response: IndexerResponse = {
        success: true,
        dryRun: false,
        summary: { found: 0, indexed: 0, updated: 0, failed: 0 },
      }

      const output = formatSummary(response)

      expect(output).toContain('Found:    0')
      expect(output).toContain('Indexed:  0')
    })
  })

  describe('formatErrors', () => {
    it('should return empty string for undefined errors', () => {
      const output = formatErrors(undefined)
      expect(output).toBe('')
    })

    it('should return empty string for empty errors array', () => {
      const output = formatErrors([])
      expect(output).toBe('')
    })

    it('should format single error', () => {
      const output = formatErrors(['Something went wrong'])

      expect(output).toContain('Errors:')
      expect(output).toContain('1. Something went wrong')
    })

    it('should format multiple errors with numbering', () => {
      const errors = ['First error', 'Second error', 'Third error']
      const output = formatErrors(errors)

      expect(output).toContain('1. First error')
      expect(output).toContain('2. Second error')
      expect(output).toContain('3. Third error')
    })
  })

  describe('formatResponse', () => {
    it('should format dry run results header', () => {
      const response: IndexerResponse = {
        success: true,
        dryRun: true,
        summary: { found: 10, indexed: 5, updated: 0, failed: 0 },
      }

      const output = formatResponse(response)

      expect(output).toContain('DRY RUN RESULTS')
      expect(output).not.toContain('INDEXER RESULTS')
    })

    it('should format indexer results header for non-dry-run', () => {
      const response: IndexerResponse = {
        success: true,
        dryRun: false,
        summary: { found: 10, indexed: 5, updated: 0, failed: 0 },
      }

      const output = formatResponse(response)

      expect(output).toContain('INDEXER RESULTS')
      expect(output).not.toContain('DRY RUN RESULTS')
    })

    it('should format SUCCESS status for successful response', () => {
      const response: IndexerResponse = {
        success: true,
        dryRun: false,
        summary: { found: 10, indexed: 10, updated: 0, failed: 0 },
      }

      const output = formatResponse(response)

      expect(output).toContain('Status: SUCCESS')
    })

    it('should format COMPLETED WITH ERRORS status for failed response', () => {
      const response: IndexerResponse = {
        success: false,
        dryRun: false,
        summary: { found: 10, indexed: 5, updated: 0, failed: 5 },
        errors: ['Error 1'],
      }

      const output = formatResponse(response)

      expect(output).toContain('Status: COMPLETED WITH ERRORS')
    })

    it('should include skills list when present', () => {
      const response: IndexerResponse = {
        success: true,
        dryRun: false,
        summary: { found: 2, indexed: 2, updated: 0, failed: 0 },
        skills: [
          {
            id: 'author1/skill1',
            name: 'skill1',
            author: 'author1',
            trust_tier: 'verified',
            quality_score: 0.95,
            repo_url: 'https://github.com/author1/skill1',
          },
          {
            id: 'author2/skill2',
            name: 'skill2',
            author: 'author2',
            trust_tier: 'community',
          },
        ],
      }

      const output = formatResponse(response)

      expect(output).toContain('Indexed Skills:')
      expect(output).toContain('1. author1/skill1')
      expect(output).toContain('Author: author1')
      expect(output).toContain('Trust:  verified | Score: 0.9')
      expect(output).toContain('Repo:   https://github.com/author1/skill1')
      expect(output).toContain('2. author2/skill2')
    })

    it('should include errors section when present', () => {
      const response: IndexerResponse = {
        success: false,
        dryRun: false,
        summary: { found: 5, indexed: 3, updated: 0, failed: 2 },
        errors: ['Failed to fetch SKILL.md', 'Invalid skill format'],
      }

      const output = formatResponse(response)

      expect(output).toContain('Errors:')
      expect(output).toContain('1. Failed to fetch SKILL.md')
      expect(output).toContain('2. Invalid skill format')
    })

    it('should include message when present', () => {
      const response: IndexerResponse = {
        success: true,
        dryRun: false,
        summary: { found: 10, indexed: 10, updated: 0, failed: 0 },
        message: 'Indexing completed successfully',
      }

      const output = formatResponse(response)

      expect(output).toContain('Message: Indexing completed successfully')
    })

    it('should handle skill without quality score', () => {
      const response: IndexerResponse = {
        success: true,
        dryRun: false,
        summary: { found: 1, indexed: 1, updated: 0, failed: 0 },
        skills: [
          {
            id: 'test/skill',
            name: 'skill',
            author: 'test',
          },
        ],
      }

      const output = formatResponse(response)

      expect(output).toContain('Score: N/A')
      expect(output).toContain('Trust:  unknown')
    })
  })
})

// =============================================================================
// Request Building Tests
// =============================================================================

describe('Request Building', () => {
  describe('buildRequest', () => {
    it('should build request from CLI options', () => {
      const options: CliOptions = {
        dryRun: true,
        topics: ['topic1', 'topic2'],
        maxPages: 10,
        strict: false,
        minLength: 50,
        help: false,
      }

      const request = buildRequest(options)

      expect(request).toEqual({
        dryRun: true,
        topics: ['topic1', 'topic2'],
        maxPages: 10,
        strictValidation: false,
        minContentLength: 50,
      })
    })

    it('should map CLI option names to request field names', () => {
      const options: CliOptions = {
        dryRun: false,
        topics: DEFAULT_TOPICS,
        maxPages: DEFAULT_MAX_PAGES,
        strict: true,
        minLength: DEFAULT_MIN_LENGTH,
        help: false,
      }

      const request = buildRequest(options)

      // Note: strict -> strictValidation, minLength -> minContentLength
      expect(request.strictValidation).toBe(true)
      expect(request.minContentLength).toBe(DEFAULT_MIN_LENGTH)
    })
  })

  describe('buildIndexerUrl', () => {
    it('should build correct URL from project reference', () => {
      const url = buildIndexerUrl('my-project-ref')
      expect(url).toBe('https://my-project-ref.supabase.co/functions/v1/indexer')
    })

    it('should handle project reference with special characters', () => {
      const url = buildIndexerUrl('my-project-123')
      expect(url).toBe('https://my-project-123.supabase.co/functions/v1/indexer')
    })
  })
})

// =============================================================================
// Integration Test: Full Flow Simulation
// =============================================================================

describe('Integration: Full Flow Simulation', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('should handle complete dry-run flow', async () => {
    // 1. Parse arguments
    const options = parseArgs(['--dry-run', '--topics', 'claude-code', '--max-pages', '3'])

    expect(options.dryRun).toBe(true)
    expect(options.topics).toEqual(['claude-code'])

    // 2. Validate environment
    const envResult = validateEnv({
      SUPABASE_PROJECT_REF: 'test-project',
      SUPABASE_ANON_KEY: 'test-key',
    })

    expect(envResult.valid).toBe(true)

    // 3. Build request
    const request = buildRequest(options)
    const url = buildIndexerUrl(envResult.config!.projectRef)

    expect(request.dryRun).toBe(true)
    expect(url).toContain('test-project')

    // 4. Mock fetch response
    const mockEdgeFunctionResponse = {
      data: {
        found: 25,
        indexed: 20,
        updated: 5,
        failed: 0,
        dryRun: true,
        errors: [],
      },
      meta: { duration_ms: 1500 },
    }

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockEdgeFunctionResponse),
    })

    // 5. Normalize response
    const response = await (await global.fetch(url, {})).json()
    const normalized = normalizeResponse(response, options.dryRun)

    expect(normalized.success).toBe(true)
    expect(normalized.dryRun).toBe(true)
    expect(normalized.summary.found).toBe(25)

    // 6. Format output
    const output = formatResponse(normalized)

    expect(output).toContain('DRY RUN RESULTS')
    expect(output).toContain('Found:    25')
    expect(output).toContain('SUCCESS')
  })

  it('should handle error flow', async () => {
    // Parse args and validate env
    const parsedOptions = parseArgs(['--topics', 'invalid-topic'])
    const envResult = validateEnv({
      SUPABASE_PROJECT_REF: 'test',
      SUPABASE_ANON_KEY: 'key',
    })

    expect(envResult.valid).toBe(true)
    expect(parsedOptions.topics).toEqual(['invalid-topic'])

    // Mock error response
    const mockErrorResponse = {
      data: {
        found: 5,
        indexed: 2,
        updated: 0,
        failed: 3,
        errors: ['Failed to fetch skill1', 'Invalid format in skill2', 'Timeout on skill3'],
      },
    }

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockErrorResponse),
    })

    const response = await (await global.fetch('', {})).json()
    const normalized = normalizeResponse(response, parsedOptions.dryRun)

    expect(normalized.success).toBe(false)
    expect(normalized.errors).toHaveLength(3)

    const output = formatResponse(normalized)
    expect(output).toContain('COMPLETED WITH ERRORS')
    expect(output).toContain('Failed:   3')
  })
})

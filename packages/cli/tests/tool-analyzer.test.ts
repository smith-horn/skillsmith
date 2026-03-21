/**
 * Unit tests for tool-analyzer.ts pure logic functions
 *
 * Tests analyzeToolRequirements, formatToolList, parseToolsString, validateTools.
 * No mocking required — all functions are pure.
 */

import { describe, it, expect } from 'vitest'
import {
  analyzeToolRequirements,
  formatToolList,
  parseToolsString,
  validateTools,
  TOOL_PATTERNS,
} from '../src/utils/tool-analyzer.js'

// ============================================================================
// analyzeToolRequirements
// ============================================================================

describe('analyzeToolRequirements', () => {
  it('always includes Read tool', () => {
    const result = analyzeToolRequirements('')
    expect(result.requiredTools).toContain('Read')
  })

  it('detects Write from content', () => {
    const result = analyzeToolRequirements('This skill will write files to disk')
    expect(result.requiredTools).toContain('Write')
  })

  it('detects Edit from content', () => {
    const result = analyzeToolRequirements('Modify existing configuration files')
    expect(result.requiredTools).toContain('Edit')
  })

  it('detects Bash from npm keyword', () => {
    const result = analyzeToolRequirements('Run npm install to set up dependencies')
    expect(result.requiredTools).toContain('Bash')
  })

  it('detects Bash from docker keyword', () => {
    const result = analyzeToolRequirements('Execute docker compose up')
    expect(result.requiredTools).toContain('Bash')
  })

  it('detects Bash from git keyword', () => {
    const result = analyzeToolRequirements('Use git commit to save changes')
    expect(result.requiredTools).toContain('Bash')
  })

  it('detects Grep from search keywords', () => {
    const result = analyzeToolRequirements('Search for all TODO comments')
    expect(result.requiredTools).toContain('Grep')
  })

  it('detects Glob from file pattern keywords', () => {
    const result = analyzeToolRequirements('Find files matching the pattern')
    expect(result.requiredTools).toContain('Glob')
  })

  it('detects WebFetch from http keywords', () => {
    const result = analyzeToolRequirements('Fetch data from http endpoints')
    expect(result.requiredTools).toContain('WebFetch')
  })

  it('detects WebSearch from search online keywords', () => {
    const result = analyzeToolRequirements('Search online for best practices')
    expect(result.requiredTools).toContain('WebSearch')
  })

  it('returns high confidence for 3+ pattern matches', () => {
    const result = analyzeToolRequirements(
      'Write files, run npm commands, and search for patterns in the codebase'
    )
    expect(result.confidence).toBe('high')
  })

  it('returns medium confidence for 1-2 pattern matches', () => {
    const result = analyzeToolRequirements('Edit a single configuration file')
    expect(result.confidence).toBe('medium')
  })

  it('returns low confidence for no pattern matches', () => {
    const result = analyzeToolRequirements('A purely informational skill')
    expect(result.confidence).toBe('low')
  })

  it('records detected patterns', () => {
    const result = analyzeToolRequirements('Write output to file and run npm build')
    expect(result.detectedPatterns.length).toBeGreaterThan(0)
    expect(result.detectedPatterns.some((p) => p.startsWith('Write:'))).toBe(true)
    expect(result.detectedPatterns.some((p) => p.startsWith('Bash:'))).toBe(true)
  })

  it('only matches one pattern per tool', () => {
    const result = analyzeToolRequirements('Write to file, save data, create file, generate file')
    const writePatterns = result.detectedPatterns.filter((p) => p.startsWith('Write:'))
    expect(writePatterns).toHaveLength(1)
  })

  it('is case-insensitive', () => {
    const result = analyzeToolRequirements('NPM INSTALL and DOCKER BUILD')
    expect(result.requiredTools).toContain('Bash')
  })

  it('requiredTools and recommendedTools are identical', () => {
    const result = analyzeToolRequirements('Write, edit, search, and run commands')
    expect(result.requiredTools).toEqual(result.recommendedTools)
  })
})

// ============================================================================
// formatToolList
// ============================================================================

describe('formatToolList', () => {
  it('returns "Read" for empty array', () => {
    expect(formatToolList([])).toBe('Read')
  })

  it('joins tools with comma and space', () => {
    expect(formatToolList(['Read', 'Write', 'Bash'])).toBe('Read, Write, Bash')
  })

  it('returns single tool as-is', () => {
    expect(formatToolList(['Edit'])).toBe('Edit')
  })
})

// ============================================================================
// parseToolsString
// ============================================================================

describe('parseToolsString', () => {
  it('parses comma-separated tools', () => {
    expect(parseToolsString('Read, Write, Bash')).toEqual(['Read', 'Write', 'Bash'])
  })

  it('trims whitespace', () => {
    expect(parseToolsString('  Read ,  Write  ')).toEqual(['Read', 'Write'])
  })

  it('filters empty strings', () => {
    expect(parseToolsString('Read,,Write,')).toEqual(['Read', 'Write'])
  })

  it('handles single tool', () => {
    expect(parseToolsString('Read')).toEqual(['Read'])
  })

  it('returns empty array for empty string', () => {
    expect(parseToolsString('')).toEqual([])
  })
})

// ============================================================================
// validateTools
// ============================================================================

describe('validateTools', () => {
  it('validates known tools', () => {
    const result = validateTools(['Read', 'Write', 'Bash'])
    expect(result.valid).toBe(true)
    expect(result.unrecognized).toEqual([])
  })

  it('reports unrecognized tools', () => {
    const result = validateTools(['Read', 'FlyToMoon'])
    expect(result.valid).toBe(false)
    expect(result.unrecognized).toEqual(['FlyToMoon'])
  })

  it('validates all TOOL_PATTERNS keys', () => {
    const allTools = Object.keys(TOOL_PATTERNS)
    const result = validateTools(allTools)
    expect(result.valid).toBe(true)
  })

  it('handles empty array', () => {
    const result = validateTools([])
    expect(result.valid).toBe(true)
    expect(result.unrecognized).toEqual([])
  })

  it('reports multiple unrecognized tools', () => {
    const result = validateTools(['FlyToMoon', 'TimeTravel'])
    expect(result.valid).toBe(false)
    expect(result.unrecognized).toHaveLength(2)
  })
})

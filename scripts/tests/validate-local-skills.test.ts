/**
 * SMI-1778: Unit tests for validate-local-skills.mjs
 *
 * Tests the YAML frontmatter parser and validation functions.
 */

import { describe, it, expect } from 'vitest'

// =============================================================================
// YAML Frontmatter Parser (copied from validate-local-skills.mjs for testing)
// =============================================================================

function parseYamlFrontmatter(content) {
  const trimmed = content.trim()

  if (!trimmed.startsWith('---')) {
    return null
  }

  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return null
  }

  const yamlContent = trimmed.slice(3, endIndex).trim()
  const result = {}
  const lines = yamlContent.split('\n')
  let currentKey = null
  let arrayBuffer = []
  let inArray = false

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue
    }

    if (trimmedLine.startsWith('- ')) {
      if (currentKey && inArray) {
        const value = trimmedLine
          .slice(2)
          .trim()
          .replace(/^["']|["']$/g, '')
        arrayBuffer.push(value)
      }
      continue
    }

    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex > 0) {
      if (currentKey && inArray && arrayBuffer.length > 0) {
        result[currentKey] = arrayBuffer
        arrayBuffer = []
      }

      const key = trimmedLine.slice(0, colonIndex).trim()
      const value = trimmedLine.slice(colonIndex + 1).trim()

      if (value === '' || value === '|' || value === '>') {
        currentKey = key
        inArray = true
        arrayBuffer = []
      } else {
        currentKey = null
        inArray = false

        let parsedValue = value
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          parsedValue = value.slice(1, -1)
        } else if (value === 'true') {
          parsedValue = true
        } else if (value === 'false') {
          parsedValue = false
        } else if (/^-?\d+(\.\d+)?$/.test(value)) {
          parsedValue = parseFloat(value)
        } else if (value.startsWith('[') && value.endsWith(']')) {
          parsedValue = value
            .slice(1, -1)
            .split(',')
            .map((item) => item.trim().replace(/^["']|["']$/g, ''))
            .filter((item) => item.length > 0)
        }

        result[key] = parsedValue
      }
    }
  }

  if (currentKey && inArray && arrayBuffer.length > 0) {
    result[currentKey] = arrayBuffer
  }

  return result
}

// =============================================================================
// Tests
// =============================================================================

describe('parseYamlFrontmatter', () => {
  describe('basic parsing', () => {
    it('should return null for content without frontmatter', () => {
      const content = '# No frontmatter here\n\nJust markdown content.'
      expect(parseYamlFrontmatter(content)).toBeNull()
    })

    it('should return null for malformed frontmatter (missing closing ---)', () => {
      const content = `---
name: "Test Skill"
description: "Test description"

# Missing closing delimiter`
      expect(parseYamlFrontmatter(content)).toBeNull()
    })

    it('should parse simple frontmatter with name and description', () => {
      const content = `---
name: "Test Skill"
description: "A test skill for validation"
---

# Test Skill Content`
      const result = parseYamlFrontmatter(content)
      expect(result).toEqual({
        name: 'Test Skill',
        description: 'A test skill for validation',
      })
    })

    it('should handle frontmatter with extra whitespace', () => {
      const content = `---
  name: "Spaced Skill"
  description: "Has leading spaces"
---`
      const result = parseYamlFrontmatter(content)
      expect(result).toEqual({
        name: 'Spaced Skill',
        description: 'Has leading spaces',
      })
    })
  })

  describe('value types', () => {
    it('should parse string values with double quotes', () => {
      const content = `---
name: "Double Quoted"
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.name).toBe('Double Quoted')
    })

    it('should parse string values with single quotes', () => {
      const content = `---
name: 'Single Quoted'
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.name).toBe('Single Quoted')
    })

    it('should parse boolean true', () => {
      const content = `---
enabled: true
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.enabled).toBe(true)
    })

    it('should parse boolean false', () => {
      const content = `---
disabled: false
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.disabled).toBe(false)
    })

    it('should parse integer numbers', () => {
      const content = `---
version: 42
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.version).toBe(42)
    })

    it('should parse floating point numbers', () => {
      const content = `---
score: 3.14
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.score).toBe(3.14)
    })

    it('should parse negative numbers', () => {
      const content = `---
offset: -10
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.offset).toBe(-10)
    })

    it('should parse inline arrays', () => {
      const content = `---
tags: [testing, validation, skills]
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.tags).toEqual(['testing', 'validation', 'skills'])
    })

    it('should parse inline arrays with quoted values', () => {
      const content = `---
tags: ["one", 'two', three]
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.tags).toEqual(['one', 'two', 'three'])
    })
  })

  describe('multiline arrays', () => {
    it('should parse YAML list format arrays', () => {
      const content = `---
tags:
  - development
  - testing
  - skills
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.tags).toEqual(['development', 'testing', 'skills'])
    })

    it('should handle quoted items in list format', () => {
      const content = `---
categories:
  - "Category One"
  - 'Category Two'
  - Category Three
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.categories).toEqual(['Category One', 'Category Two', 'Category Three'])
    })
  })

  describe('comments', () => {
    it('should ignore comment lines', () => {
      const content = `---
# This is a comment
name: "Test"
# Another comment
description: "Description"
---`
      const result = parseYamlFrontmatter(content)
      expect(result).toEqual({
        name: 'Test',
        description: 'Description',
      })
    })
  })

  describe('edge cases', () => {
    it('should handle empty frontmatter', () => {
      const content = `---
---

# Content here`
      const result = parseYamlFrontmatter(content)
      expect(result).toEqual({})
    })

    it('should handle colons in values', () => {
      const content = `---
url: "https://example.com"
time: "12:30:00"
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.url).toBe('https://example.com')
      expect(result?.time).toBe('12:30:00')
    })

    it('should handle empty string values', () => {
      const content = `---
name: ""
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.name).toBe('')
    })

    it('should handle content after frontmatter', () => {
      const content = `---
name: "Test"
---

# Heading

Some paragraph content.

## Another heading

More content.`
      const result = parseYamlFrontmatter(content)
      expect(result).toEqual({ name: 'Test' })
    })

    it('should handle version strings that look like numbers', () => {
      const content = `---
version: "1.0.0"
---`
      const result = parseYamlFrontmatter(content)
      expect(result?.version).toBe('1.0.0')
    })
  })

  describe('real-world skill examples', () => {
    it('should parse a typical skill frontmatter', () => {
      const content = `---
name: "Skill Builder"
description: "Create new Claude Code Skills with proper YAML frontmatter, progressive disclosure structure, and complete directory organization."
version: "1.0.0"
author: "agentic-flow team"
tags:
  - skills
  - development
  - templates
---

# Skill Builder

## What This Skill Does
...`
      const result = parseYamlFrontmatter(content)
      expect(result).toEqual({
        name: 'Skill Builder',
        description:
          'Create new Claude Code Skills with proper YAML frontmatter, progressive disclosure structure, and complete directory organization.',
        version: '1.0.0',
        author: 'agentic-flow team',
        tags: ['skills', 'development', 'templates'],
      })
    })

    it('should parse minimal valid skill frontmatter', () => {
      const content = `---
name: "Minimal Skill"
description: "Does one thing."
---`
      const result = parseYamlFrontmatter(content)
      expect(result).toEqual({
        name: 'Minimal Skill',
        description: 'Does one thing.',
      })
    })
  })
})

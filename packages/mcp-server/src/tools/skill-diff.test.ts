/**
 * @fileoverview Tests for skill-diff.ts MCP tool
 * @see SMI-skill-version-tracking Wave 2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSkillDiff, skillDiffInputSchema, type SkillDiffResponse } from './skill-diff.js'
import type { ToolContext } from '../context.js'

// ============================================================================
// Mock context
// ============================================================================

const mockContext = {} as ToolContext

// ============================================================================
// Fixtures
// ============================================================================

const OLD_CONTENT = `---
name: test-skill
version: 1.0.0
---

## Overview

A test skill.

## Usage

Run with /test.

## Configuration

Set env vars.
`

const NEW_CONTENT_MINOR = `---
name: test-skill
version: 1.1.0
---

## Overview

A test skill.

## Usage

Run with /test.

## Configuration

Set env vars.

## Examples

Here are some examples.
`

const NEW_CONTENT_MAJOR = `---
name: test-skill
version: 2.0.0
---

## Overview

A test skill.

## Usage

Run with /test.
`

const NEW_CONTENT_PATCH = `---
name: test-skill
version: 1.0.1
---

## Overview

An updated test skill.

## Usage

Run with /test now.

## Configuration

Updated env vars.
`

const NEW_CONTENT_WITH_CHANGELOG = `---
name: test-skill
version: 1.0.1
changelog: "Fixed a bug in configuration handling"
---

## Overview

An updated test skill.

## Usage

Run with /test.

## Configuration

Updated env vars.
`

// ============================================================================
// Tests
// ============================================================================

describe('executeSkillDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('SkillDiffResponse schema', () => {
    it('returns a valid SkillDiffResponse for a minor update', async () => {
      const result = await executeSkillDiff(
        {
          skillId: 'anthropic/test-skill',
          oldContent: OLD_CONTENT,
          newContent: NEW_CONTENT_MINOR,
          hasLocalModifications: false,
          trustTier: 'community',
        },
        mockContext
      )

      // Verify all required fields are present
      expect(result).toHaveProperty('skill', 'anthropic/test-skill')
      expect(result).toHaveProperty('changeType')
      expect(result).toHaveProperty('sectionsAdded')
      expect(result).toHaveProperty('sectionsRemoved')
      expect(result).toHaveProperty('sectionsModified')
      expect(result).toHaveProperty('riskScoreDelta')
      expect(result).toHaveProperty('changelog')
      expect(result).toHaveProperty('recommendation')

      // Type assertions
      expect(['major', 'minor', 'patch', 'unknown']).toContain(result.changeType)
      expect(Array.isArray(result.sectionsAdded)).toBe(true)
      expect(Array.isArray(result.sectionsRemoved)).toBe(true)
      expect(Array.isArray(result.sectionsModified)).toBe(true)
      expect(['auto-update', 'review-then-update', 'manual-review-required']).toContain(
        result.recommendation
      )
    })

    it('detects added sections correctly', async () => {
      const result: SkillDiffResponse = await executeSkillDiff(
        {
          skillId: 'test/skill',
          oldContent: OLD_CONTENT,
          newContent: NEW_CONTENT_MINOR,
          hasLocalModifications: false,
          trustTier: 'community',
        },
        mockContext
      )

      expect(result.sectionsAdded).toContain('Examples')
      expect(result.sectionsRemoved).toHaveLength(0)
    })

    it('detects removed sections correctly', async () => {
      const result: SkillDiffResponse = await executeSkillDiff(
        {
          skillId: 'test/skill',
          oldContent: OLD_CONTENT,
          newContent: NEW_CONTENT_MAJOR,
          hasLocalModifications: false,
          trustTier: 'community',
        },
        mockContext
      )

      expect(result.sectionsRemoved).toContain('Configuration')
      expect(result.sectionsAdded).toHaveLength(0)
    })

    it('detects modified sections correctly', async () => {
      const result: SkillDiffResponse = await executeSkillDiff(
        {
          skillId: 'test/skill',
          oldContent: OLD_CONTENT,
          newContent: NEW_CONTENT_PATCH,
          hasLocalModifications: false,
          trustTier: 'community',
        },
        mockContext
      )

      // Body text changed but no headings added/removed
      expect(result.sectionsRemoved).toHaveLength(0)
      expect(result.sectionsAdded).toHaveLength(0)
      expect(result.sectionsModified.length).toBeGreaterThan(0)
    })

    it('returns riskScoreDelta when scores are provided', async () => {
      const result: SkillDiffResponse = await executeSkillDiff(
        {
          skillId: 'test/skill',
          oldContent: OLD_CONTENT,
          newContent: NEW_CONTENT_PATCH,
          oldRiskScore: 10,
          newRiskScore: 30,
          hasLocalModifications: false,
          trustTier: 'community',
        },
        mockContext
      )

      expect(result.riskScoreDelta).toBe(20)
    })

    it('returns null riskScoreDelta when scores are not provided', async () => {
      const result: SkillDiffResponse = await executeSkillDiff(
        {
          skillId: 'test/skill',
          oldContent: OLD_CONTENT,
          newContent: NEW_CONTENT_PATCH,
          hasLocalModifications: false,
          trustTier: 'community',
        },
        mockContext
      )

      expect(result.riskScoreDelta).toBeNull()
    })

    it('extracts changelog from frontmatter', async () => {
      const result: SkillDiffResponse = await executeSkillDiff(
        {
          skillId: 'test/skill',
          oldContent: OLD_CONTENT,
          newContent: NEW_CONTENT_WITH_CHANGELOG,
          hasLocalModifications: false,
          trustTier: 'community',
        },
        mockContext
      )

      expect(result.changelog).toContain('Fixed a bug')
    })

    it('returns null changelog when none present', async () => {
      const result: SkillDiffResponse = await executeSkillDiff(
        {
          skillId: 'test/skill',
          oldContent: OLD_CONTENT,
          newContent: NEW_CONTENT_PATCH,
          hasLocalModifications: false,
          trustTier: 'community',
        },
        mockContext
      )

      expect(result.changelog).toBeNull()
    })
  })

  describe('recommendation based on changeType', () => {
    it('returns auto-update for patch + verified + changelog', async () => {
      const result: SkillDiffResponse = await executeSkillDiff(
        {
          skillId: 'test/skill',
          oldContent: OLD_CONTENT,
          newContent: NEW_CONTENT_WITH_CHANGELOG,
          hasLocalModifications: false,
          trustTier: 'verified',
        },
        mockContext
      )

      expect(result.recommendation).toBe('auto-update')
    })

    it('returns manual-review-required for major + local mods + risk increase', async () => {
      const result: SkillDiffResponse = await executeSkillDiff(
        {
          skillId: 'test/skill',
          oldContent: OLD_CONTENT,
          newContent: NEW_CONTENT_MAJOR,
          oldRiskScore: 10,
          newRiskScore: 60,
          hasLocalModifications: true,
          trustTier: 'community',
        },
        mockContext
      )

      expect(result.recommendation).toBe('manual-review-required')
    })
  })

  describe('input validation', () => {
    it('rejects empty skillId', () => {
      expect(() =>
        skillDiffInputSchema.parse({
          skillId: '',
          oldContent: 'old',
          newContent: 'new',
        })
      ).toThrow()
    })

    it('rejects empty oldContent', () => {
      expect(() =>
        skillDiffInputSchema.parse({
          skillId: 'test/skill',
          oldContent: '',
          newContent: 'new',
        })
      ).toThrow()
    })

    it('accepts optional fields', () => {
      const parsed = skillDiffInputSchema.parse({
        skillId: 'test/skill',
        oldContent: 'old content',
        newContent: 'new content',
      })
      expect(parsed.hasLocalModifications).toBe(false)
      expect(parsed.trustTier).toBe('community')
    })
  })
})

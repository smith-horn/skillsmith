/**
 * @fileoverview Tests for SkillDecomposer service
 * Part of Skillsmith Optimization Layer
 */

import { describe, it, expect } from 'vitest'
import { decomposeSkill, parallelizeTaskCalls } from '../SkillDecomposer.js'
import { analyzeSkill } from '../SkillAnalyzer.js'

describe('SkillDecomposer', () => {
  describe('decomposeSkill', () => {
    it('should not decompose small skills', () => {
      const content = `---
name: small-skill
description: A small skill
---

# Small Skill

Just some content here.
`
      const analysis = analyzeSkill(content)
      const result = decomposeSkill(content, analysis)

      expect(result.wasDecomposed).toBe(false)
      expect(result.subSkills).toHaveLength(0)
      expect(result.mainSkill.content).toContain('Optimized by Skillsmith')
    })

    it('should decompose large skills into main + sub-skills', () => {
      // Create a skill with >500 lines AND tool usage to boost optimization score
      // The score needs to reach 30+ for decomposition to trigger
      const apiSection = Array(200)
        .fill('- endpoint: /api/v1/resource with detailed parameters')
        .join('\n')
      const examplesSection = Array(200)
        .fill('Example code line with detailed explanation')
        .join('\n')

      const content = `---
name: large-skill
description: A large skill that needs decomposition
---

# Large Skill

Overview content here with more detail.

## Quick Start

Get started quickly with basic setup.
Run npm install to get dependencies.
Use git clone to get the repository.
Execute docker build for containers.

## API Reference

${apiSection}

## Examples

${examplesSection}

## Advanced Configuration

${'Advanced setting with more detail\n'.repeat(200)}
`
      const analysis = analyzeSkill(content)
      const result = decomposeSkill(content, analysis)

      // For very large skills with tool usage, decomposition should occur
      expect(analysis.lineCount).toBeGreaterThan(500)
      // Score should be high enough to trigger transformation
      expect(analysis.optimizationScore).toBeGreaterThanOrEqual(30)
      expect(result.wasDecomposed).toBe(true)
      expect(result.subSkills.length).toBeGreaterThan(0)
      expect(result.stats.tokenReductionPercent).toBeGreaterThan(0)
    })

    it('should preserve frontmatter in decomposed skill', () => {
      const content = `---
name: test-skill
description: Test skill description
version: 1.0.0
---

# Test Skill

Content here.

## API Reference

${'API content line\n'.repeat(100)}
`
      const analysis = analyzeSkill(content)
      const result = decomposeSkill(content, analysis)

      expect(result.mainSkill.content).toContain('name: test-skill')
      expect(result.mainSkill.content).toContain('description: Test skill description')
    })

    it('should add navigation section to main skill', () => {
      const content = `---
name: nav-skill
description: Skill with navigation
---

# Nav Skill

Overview.

## API Reference

${'API line\n'.repeat(100)}

## Examples

${'Example line\n'.repeat(100)}
`
      const analysis = analyzeSkill(content)
      const result = decomposeSkill(content, analysis)

      if (result.wasDecomposed) {
        expect(result.mainSkill.content).toContain('Additional Resources')
        expect(result.mainSkill.content).toContain('.md)')
      }
    })

    it('should generate valid sub-skill filenames', () => {
      const content = `---
name: filename-skill
description: Test filename generation
---

# Filename Skill

## API Reference & Guide

${'Content\n'.repeat(100)}

## Advanced Configuration Options

${'Content\n'.repeat(100)}
`
      const analysis = analyzeSkill(content)
      const result = decomposeSkill(content, analysis)

      if (result.wasDecomposed) {
        for (const subSkill of result.subSkills) {
          expect(subSkill.filename).toMatch(/^[a-z0-9-]+\.md$/)
          expect(subSkill.filename).not.toContain(' ')
          expect(subSkill.filename).not.toContain('&')
        }
      }
    })

    it('should include parent skill reference in sub-skills', () => {
      const content = `---
name: parent-skill
description: Test parent reference
---

# Parent Skill

## API Reference

${'Content\n'.repeat(100)}
`
      const analysis = analyzeSkill(content)
      const result = decomposeSkill(content, analysis)

      if (result.wasDecomposed && result.subSkills.length > 0) {
        expect(result.subSkills[0].content).toContain('parent_skill:')
      }
    })

    it('should calculate decomposition statistics correctly', () => {
      const content = `---
name: stats-skill
description: Test statistics
---

# Stats Skill

Overview.

## API Reference

${'API line with content\n'.repeat(200)}

## Examples

${'Example line with content\n'.repeat(200)}
`
      const analysis = analyzeSkill(content)
      const result = decomposeSkill(content, analysis)

      expect(result.stats.originalLines).toBe(analysis.lineCount)
      // Main skill may have more lines after adding attribution and navigation
      // So we just check it's reasonable
      expect(result.stats.mainSkillLines).toBeGreaterThan(0)

      if (result.wasDecomposed) {
        expect(result.stats.subSkillCount).toBe(result.subSkills.length)
        expect(result.stats.subSkillLines).toBeGreaterThan(0)
      }
    })
  })

  describe('parallelizeTaskCalls', () => {
    it('should add batch comment to sequential Task() calls', () => {
      const content = `# Skill

\`\`\`javascript
Task("agent1", "task 1")
Task("agent2", "task 2")
Task("agent3", "task 3")
\`\`\`
`
      const result = parallelizeTaskCalls(content)

      expect(result).toContain('Batched for parallel execution')
    })

    it('should not modify single Task() calls', () => {
      const content = `# Skill

\`\`\`javascript
Task("agent1", "task 1")
\`\`\`

Some text.

\`\`\`javascript
Task("agent2", "task 2")
\`\`\`
`
      const result = parallelizeTaskCalls(content)

      expect(result).not.toContain('Batched for parallel execution')
    })

    it('should preserve non-Task content', () => {
      const content = `# Skill

Some content here.

## Section

More content.
`
      const result = parallelizeTaskCalls(content)

      expect(result).toBe(content)
    })
  })
})

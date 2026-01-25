/**
 * @fileoverview Tests for TransformationService
 * Part of Skillsmith Optimization Layer
 */

import { describe, it, expect } from 'vitest'
import { TransformationService, transformSkill } from '../TransformationService.js'

describe('TransformationService', () => {
  describe('constructor', () => {
    it('should create service without database (no caching)', () => {
      const service = new TransformationService()
      const stats = service.getCacheStats()

      expect(stats.enabled).toBe(false)
    })

    it('should accept custom options', () => {
      const service = new TransformationService(undefined, {
        cacheTtl: 7200,
        version: '2.0.0',
      })
      const stats = service.getCacheStats()

      expect(stats.ttl).toBe(7200)
      expect(stats.version).toBe('2.0.0')
    })
  })

  describe('transformWithoutCache', () => {
    it('should not transform simple skills', () => {
      const service = new TransformationService()
      const content = `---
name: simple-skill
description: A simple skill
---

# Simple Skill

Just basic content.
`
      const result = service.transformWithoutCache('simple-skill', 'A simple skill', content)

      expect(result.transformed).toBe(false)
      expect(result.mainSkillContent).toContain('Optimized by Skillsmith')
      expect(result.subSkills).toHaveLength(0)
    })

    it('should transform complex skills', () => {
      const service = new TransformationService()

      // Create a complex skill with multiple optimization opportunities
      const apiSection = Array(100).fill('- endpoint: /api/v1/resource').join('\n')

      const content = `---
name: complex-skill
description: A complex skill with multiple optimization opportunities
---

# Complex Skill

This skill has multiple areas for optimization.

## Heavy Commands

Run npm install
Run npx something
Run git commands
Run docker build
Run yarn add
Use bash terminal

## API Reference

${apiSection}

## Examples

\`\`\`javascript
Task("agent1", "task 1")
Task("agent2", "task 2")
Task("agent3", "task 3")
\`\`\`
`
      const result = service.transformWithoutCache(
        'complex-skill',
        'A complex skill with multiple optimization opportunities',
        content
      )

      expect(result.transformed).toBe(true)
      expect(result.stats.tokenReductionPercent).toBeGreaterThan(0)
      expect(result.analysis).toBeDefined()
    })

    it('should generate subagent for heavy tool usage', () => {
      const service = new TransformationService()

      const content = `---
name: tool-skill
description: A skill with heavy tool usage
---

# Tool Skill

This skill runs many commands:
- npm install packages
- git status and commit
- docker build images
- npx execute scripts
- yarn add dependencies
- pnpm install modules

Use bash to execute commands.
Terminal operations are common.
Shell scripting is required.
`
      const result = service.transformWithoutCache(
        'tool-skill',
        'A skill with heavy tool usage',
        content
      )

      expect(result.subagent).toBeDefined()
      expect(result.subagent?.name).toBe('tool-skill-specialist')
      expect(result.claudeMdSnippet).toBeDefined()
    })

    it('should include attribution in transformed content', () => {
      const service = new TransformationService()
      const content = `# Skill\n\nContent.`
      const result = service.transformWithoutCache('skill', 'Test skill', content)

      expect(result.mainSkillContent).toContain('Optimized by Skillsmith')
      expect(result.attribution).toContain('Optimized by Skillsmith')
    })

    it('should populate transformation stats', () => {
      const service = new TransformationService()
      const content = `# Skill\n\n${'Content line.\n'.repeat(100)}`
      const result = service.transformWithoutCache('skill', 'Test skill', content)

      expect(result.stats.originalLines).toBeGreaterThan(0)
      expect(result.stats.optimizedLines).toBeGreaterThan(0)
      expect(result.stats.transformDurationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('analyze', () => {
    it('should return analysis without transforming', () => {
      const service = new TransformationService()
      const content = `# Skill\n\nContent.`
      const analysis = service.analyze(content)

      expect(analysis.lineCount).toBeGreaterThan(0)
      expect(analysis.toolUsage).toBeDefined()
      expect(analysis.recommendations).toBeDefined()
    })
  })

  describe('transformSkill standalone function', () => {
    it('should transform without service instance', () => {
      const content = `---
name: standalone-skill
description: Test standalone transformation
---

# Standalone Skill

Content here.
`
      const result = transformSkill('standalone-skill', 'Test standalone transformation', content)

      expect(result).toBeDefined()
      expect(result.mainSkillContent).toContain('standalone-skill')
    })
  })

  describe('transformation with decomposition', () => {
    it('should decompose large skills into sub-skills', () => {
      const service = new TransformationService()

      // Create skill with large sections AND tool usage to boost optimization score
      // Score needs to reach 30+ for transformation to trigger
      const apiSection = Array(200)
        .fill('- endpoint: /api/resource with detailed documentation')
        .join('\n')
      const examplesSection = Array(200)
        .fill('Example code line with detailed explanation')
        .join('\n')

      const content = `---
name: decompose-skill
description: A skill that needs decomposition
---

# Decompose Skill

Overview content with more detail.

## Installation

Run npm install to get started.
Use git to clone the repository.
Execute docker build for containers.

## API Reference

${apiSection}

## Examples

${examplesSection}

## Advanced Configuration

${'Config line with detailed settings\n'.repeat(200)}
`
      const result = service.transformWithoutCache(
        'decompose-skill',
        'A skill that needs decomposition',
        content
      )

      expect(result.stats.originalLines).toBeGreaterThan(500)
      expect(result.analysis.optimizationScore).toBeGreaterThanOrEqual(30)
      expect(result.subSkills.length).toBeGreaterThan(0)
      expect(result.stats.subSkillCount).toBe(result.subSkills.length)
    })

    it('should create properly named sub-skill files', () => {
      const service = new TransformationService()

      const content = `---
name: naming-skill
description: Test sub-skill naming
---

# Naming Skill

## API Reference & Guide

${'Content\n'.repeat(100)}

## Advanced Examples

${'Content\n'.repeat(100)}
`
      const result = service.transformWithoutCache('naming-skill', 'Test sub-skill naming', content)

      for (const subSkill of result.subSkills) {
        expect(subSkill.filename).toMatch(/\.md$/)
        expect(subSkill.content.length).toBeGreaterThan(0)
      }
    })
  })

  describe('token reduction calculations', () => {
    it('should cap token reduction at 80%', () => {
      const service = new TransformationService()

      // Create an extremely large skill
      const content = `---
name: huge-skill
description: An extremely large skill
---

# Huge Skill

${'Content line with lots of text.\n'.repeat(1000)}

## API Reference

${'- endpoint\n'.repeat(500)}

## Examples

${'Example\n'.repeat(500)}
`
      const result = service.transformWithoutCache(
        'huge-skill',
        'An extremely large skill',
        content
      )

      expect(result.stats.tokenReductionPercent).toBeLessThanOrEqual(80)
    })
  })
})

/**
 * @fileoverview Tests for SkillAnalyzer service
 * Part of Skillsmith Optimization Layer
 */

import { describe, it, expect } from 'vitest'
import { analyzeSkill, quickTransformCheck } from '../SkillAnalyzer.js'

describe('SkillAnalyzer', () => {
  describe('analyzeSkill', () => {
    it('should analyze a simple skill with low complexity', () => {
      const content = `---
name: simple-skill
description: A simple skill for testing
---

# Simple Skill

This is a simple skill with minimal content.

## Usage

Just use it normally.
`
      const analysis = analyzeSkill(content)

      expect(analysis.lineCount).toBeLessThan(500)
      expect(analysis.shouldTransform).toBe(false)
      expect(analysis.optimizationScore).toBeLessThan(30)
    })

    it('should detect large skills that need decomposition', () => {
      // Create a skill with >500 lines
      const sections = Array(100)
        .fill(null)
        .map((_, i) => `## Section ${i}\n\nContent for section ${i}.\n\n`.repeat(5))
        .join('\n')

      const content = `---
name: large-skill
description: A large skill that needs decomposition
---

# Large Skill

${sections}
`
      const analysis = analyzeSkill(content)

      expect(analysis.lineCount).toBeGreaterThan(500)
      expect(analysis.shouldTransform).toBe(true)
      expect(analysis.recommendations.some((r) => r.type === 'decompose')).toBe(true)
    })

    it('should detect heavy tool usage suggesting subagent', () => {
      const content = `---
name: tool-heavy-skill
description: A skill with heavy tool usage
---

# Tool Heavy Skill

This skill uses many tools:
- Run npm install
- Execute git commands
- Run docker build
- Use npx to execute
- Run yarn commands
- Use pnpm for package management

## Commands

bash: npm run build
bash: git status
bash: docker compose up
`
      const analysis = analyzeSkill(content)

      expect(analysis.toolUsage.detectedTools).toContain('Bash')
      expect(analysis.toolUsage.suggestsSubagent).toBe(true)
      expect(analysis.recommendations.some((r) => r.type === 'subagent')).toBe(true)
    })

    it('should detect sequential Task() calls that can be parallelized', () => {
      const content = `---
name: task-skill
description: A skill with sequential Task() calls
---

# Task Skill

## Execution

\`\`\`javascript
Task("agent1", "do task 1")
Task("agent2", "do task 2")
Task("agent3", "do task 3")
\`\`\`

These tasks are independent and can run in parallel.
`
      const analysis = analyzeSkill(content)

      expect(analysis.taskPatterns.taskCallCount).toBeGreaterThanOrEqual(3)
      expect(analysis.taskPatterns.canBatch).toBe(true)
      expect(analysis.recommendations.some((r) => r.type === 'parallelize')).toBe(true)
    })

    it('should identify extractable sections', () => {
      // Create content with large API reference section
      const apiSection = Array(60).fill('- endpoint: /api/v1/resource').join('\n')

      const content = `---
name: api-skill
description: A skill with large API reference
---

# API Skill

## Overview

Quick overview here.

## API Reference

${apiSection}

## Examples

Some examples here.
`
      const analysis = analyzeSkill(content)

      expect(analysis.extractableSections.length).toBeGreaterThan(0)
      expect(
        analysis.extractableSections.some(
          (s) => s.name.toLowerCase().includes('api') || s.name.toLowerCase().includes('reference')
        )
      ).toBe(true)
    })

    it('should calculate optimization score based on multiple factors', () => {
      // Skill with multiple optimization opportunities
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

## Large Examples Section

${'Example code here.\n'.repeat(250)}

## API Reference

${Array(60).fill('- endpoint').join('\n')}
`
      const analysis = analyzeSkill(content)

      // Score should reflect multiple optimization opportunities
      expect(analysis.optimizationScore).toBeGreaterThan(20)
      expect(analysis.recommendations.length).toBeGreaterThan(0)
    })
  })

  describe('quickTransformCheck', () => {
    it('should return false for small, simple skills', () => {
      const content = `# Simple Skill\n\nJust a simple skill.`
      expect(quickTransformCheck(content)).toBe(false)
    })

    it('should return true for skills with >500 lines', () => {
      const content = Array(600).fill('line content').join('\n')
      expect(quickTransformCheck(content)).toBe(true)
    })

    it('should return true for skills with heavy tool patterns', () => {
      const content = `# Skill\n\nnpm install\ngit status\ndocker build`
      expect(quickTransformCheck(content)).toBe(true)
    })

    it('should return true for skills with multiple Task() calls', () => {
      const content = `# Skill\n\nTask("a", "b")\nTask("c", "d")`
      expect(quickTransformCheck(content)).toBe(true)
    })
  })
})

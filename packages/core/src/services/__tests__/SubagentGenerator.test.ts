/**
 * @fileoverview Tests for SubagentGenerator service
 * Part of Skillsmith Optimization Layer
 */

import { describe, it, expect } from 'vitest'
import { generateSubagent, generateMinimalSubagent } from '../SubagentGenerator.js'
import { analyzeSkill } from '../SkillAnalyzer.js'

describe('SubagentGenerator', () => {
  describe('generateSubagent', () => {
    it('should not generate subagent for simple skills', () => {
      const content = `---
name: simple-skill
description: A simple skill
---

# Simple Skill

Just basic content.
`
      const analysis = analyzeSkill(content)
      const result = generateSubagent('simple-skill', 'A simple skill', content, analysis)

      expect(result.generated).toBe(false)
      expect(result.subagent).toBeUndefined()
      expect(result.reason).toBeDefined()
    })

    it('should generate subagent for skills with heavy tool usage', () => {
      const content = `---
name: tool-skill
description: A skill with heavy tool usage
---

# Tool Skill

This skill runs many commands:
- npm install
- git status
- docker build
- npx something
- yarn add
- pnpm install

Use bash to execute commands.
Terminal operations are common.
`
      const analysis = analyzeSkill(content)
      const result = generateSubagent(
        'tool-skill',
        'A skill with heavy tool usage',
        content,
        analysis
      )

      expect(result.generated).toBe(true)
      expect(result.subagent).toBeDefined()
      expect(result.subagent?.name).toBe('tool-skill-specialist')
      expect(result.subagent?.tools).toContain('Bash')
    })

    it('should include correct frontmatter in subagent content', () => {
      const content = `---
name: bash-skill
description: A skill that uses Bash extensively
---

# Bash Skill

Run npm commands.
Execute git operations.
Use docker for containers.
Terminal heavy operations.
Shell scripting required.
`
      const analysis = analyzeSkill(content)
      const result = generateSubagent(
        'bash-skill',
        'A skill that uses Bash extensively',
        content,
        analysis
      )

      if (result.generated && result.subagent) {
        expect(result.subagent.content).toContain('name: bash-skill-specialist')
        expect(result.subagent.content).toContain('tools:')
        expect(result.subagent.content).toContain('model:')
      }
    })

    it('should generate CLAUDE.md snippet', () => {
      const content = `---
name: snippet-skill
description: A skill for testing snippet generation
---

# Snippet Skill

Use npm for package management.
Run git commands.
Execute docker operations.
Use bash shell.
Terminal operations.
`
      const analysis = analyzeSkill(content)
      const result = generateSubagent(
        'snippet-skill',
        'A skill for testing snippet generation',
        content,
        analysis
      )

      if (result.generated) {
        expect(result.claudeMdSnippet).toBeDefined()
        expect(result.claudeMdSnippet).toContain('snippet-skill')
        expect(result.claudeMdSnippet).toContain('Delegation Example')
      }
    })

    it('should detect appropriate tools from content', () => {
      const content = `---
name: multi-tool-skill
description: A skill using multiple tools
---

# Multi Tool Skill

## File Operations
Read files to understand content.
Write new files when needed.
Edit existing files for modifications.

## Command Execution
Run bash commands for automation.
Execute npm scripts.
Use git for version control.

## Web Operations
Fetch data from URLs.
Search the web for information.
`
      const analysis = analyzeSkill(content)
      const result = generateSubagent(
        'multi-tool-skill',
        'A skill using multiple tools',
        content,
        analysis
      )

      if (result.generated && result.subagent) {
        expect(result.subagent.tools).toContain('Read')
        expect(result.subagent.tools).toContain('Write')
        expect(result.subagent.tools).toContain('Edit')
        expect(result.subagent.tools).toContain('Bash')
      }
    })

    it('should include tool usage guidelines', () => {
      const content = `---
name: guideline-skill
description: A skill to test guidelines
---

# Guideline Skill

Run npm commands.
Execute bash scripts.
Read file contents.
Write output files.
`
      const analysis = analyzeSkill(content)
      const result = generateSubagent(
        'guideline-skill',
        'A skill to test guidelines',
        content,
        analysis
      )

      if (result.generated && result.subagent) {
        expect(result.subagent.content).toContain('Tool Usage Guidelines')
        expect(result.subagent.content).toContain('**Read**')
      }
    })
  })

  describe('generateMinimalSubagent', () => {
    it('should always generate a subagent', () => {
      const content = `# Minimal Skill\n\nJust content.`
      const result = generateMinimalSubagent('minimal-skill', 'A minimal skill', content)

      expect(result.generated).toBe(true)
      expect(result.subagent).toBeDefined()
    })

    it('should use sonnet model by default', () => {
      const content = `# Minimal Skill\n\nJust content.`
      const result = generateMinimalSubagent('minimal-skill', 'A minimal skill', content)

      expect(result.subagent?.model).toBe('sonnet')
    })

    it('should detect tools from content', () => {
      // Use patterns that match the tool detection logic
      const content = `# Skill\n\nRun npm install.\nModify file contents.\nUpdate file settings.`
      const result = generateMinimalSubagent('npm-skill', 'NPM management skill', content)

      expect(result.subagent?.tools).toContain('Edit')
      expect(result.subagent?.tools).toContain('Bash')
    })

    it('should always include Read tool', () => {
      const content = `# Skill\n\nJust write files.`
      const result = generateMinimalSubagent('write-skill', 'Write skill', content)

      expect(result.subagent?.tools).toContain('Read')
    })
  })
})

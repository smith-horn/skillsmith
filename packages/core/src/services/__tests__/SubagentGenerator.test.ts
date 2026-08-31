/**
 * @fileoverview Tests for SubagentGenerator service
 * Part of Skillsmith Optimization Layer
 */

import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { generateSubagent, generateMinimalSubagent } from '../SubagentGenerator.js'
import { analyzeSkill } from '../SkillAnalyzer.js'

/** Extract just the frontmatter block (between the two `---` markers) as raw text. */
function extractFrontmatter(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error('No frontmatter block found in generated content')
  return match[1]
}

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

    it('threads the client parameter through to a client-specific frontmatter shape', () => {
      const content = `# Skill\n\nRun bash commands. Search for patterns using grep.`
      const result = generateMinimalSubagent('client-skill', 'Client skill', content, 'antigravity')

      expect(result.generated).toBe(true)
      expect(result.subagent?.content).not.toMatch(/^tools: /m)
      expect(result.subagent?.content).not.toMatch(/^model: (haiku|sonnet|opus)$/m)
    })
  })

  describe('per-client generation profiles (SMI-6276)', () => {
    // Mirrors the existing heavy-tool-usage fixture above so `suggestsSubagent`
    // reliably trips — plus lines that hit Read/Bash/Grep detection so the
    // AntiGravity mapped-array assertions below have something to map.
    const heavyToolContent = `---
name: multi-client-skill
description: Exercises heavy tool usage across bash, grep, and file reads
---

# Multi Client Skill

This skill runs many commands:
- npm install
- git status
- docker build
- npx something
- yarn add
- pnpm install

Use bash to execute commands.
Terminal operations are common.
Read files to examine content before changes.
Search for patterns using grep.
`
    const description = 'Exercises heavy tool usage across bash, grep, and file reads'
    const analysis = analyzeSkill(heavyToolContent)

    it('generates distinct frontmatter for Claude Code, Cursor, AntiGravity, and an omit-fallback client in the same run', () => {
      const claudeResult = generateSubagent(
        'multi-client-skill',
        description,
        heavyToolContent,
        analysis,
        'claude-code'
      )
      const cursorResult = generateSubagent(
        'multi-client-skill',
        description,
        heavyToolContent,
        analysis,
        'cursor'
      )
      const antigravityResult = generateSubagent(
        'multi-client-skill',
        description,
        heavyToolContent,
        analysis,
        'antigravity'
      )
      const copilotResult = generateSubagent(
        'multi-client-skill',
        description,
        heavyToolContent,
        analysis,
        'copilot'
      )

      expect(claudeResult.generated).toBe(true)
      expect(cursorResult.generated).toBe(true)
      expect(antigravityResult.generated).toBe(true)
      expect(copilotResult.generated).toBe(true)

      const claudeContent = claudeResult.subagent!.content
      const cursorContent = cursorResult.subagent!.content
      const antigravityContent = antigravityResult.subagent!.content
      const copilotContent = copilotResult.subagent!.content

      // Claude Code: Claude-native comma-list tools + a Claude model enum value.
      expect(claudeContent).toMatch(/^tools: .*Read/m)
      expect(claudeContent).toMatch(/^model: (haiku|sonnet|opus)$/m)

      // Cursor deliberately mirrors Claude Code — COMPANION_AGENT_TARGETS.cursor
      // resolves to the SAME `.claude/agents/` file, which Cursor reads as a
      // documented compatibility surface (see client-profiles.ts header) — so
      // identical output here is the intended, evidence-backed behavior, not
      // an accidental fallback to a shared default.
      expect(cursorContent).toEqual(claudeContent)

      // AntiGravity: genuinely different shape — proves this isn't just
      // Cursor's case reused everywhere. No Claude-shaped scalar `tools:`
      // line, no Claude model enum value, and its OWN mapped vocabulary
      // rendered as a real YAML array (not a comma-joined string).
      expect(antigravityContent).not.toMatch(/^tools: /m)
      expect(antigravityContent).not.toContain('Read,')
      expect(antigravityContent).not.toMatch(/^model: (haiku|sonnet|opus)$/m)
      expect(antigravityContent).toMatch(/^tools:$/m)
      expect(antigravityContent).toContain('  - run_command')
      expect(antigravityContent).toContain('  - grep_search')
      expect(antigravityContent).toContain('  - view_file')
      // Step 2 is a separate, independent question (not this wave's scope) —
      // regression-pin that this wave's fix does not touch it either way.
      expect(antigravityContent).not.toMatch(/^subagent:/m)

      // Copilot: the unverified-vocabulary fallback path — omits both fields
      // entirely rather than guessing a partial/wrong mapping.
      expect(copilotContent).not.toMatch(/^tools:/m)
      expect(copilotContent).not.toMatch(/^model:/m)

      // Every client still gets the universal minimum (name + description).
      for (const content of [claudeContent, cursorContent, antigravityContent, copilotContent]) {
        expect(content).toMatch(/^name: multi-client-skill-specialist$/m)
        expect(content).toMatch(/^description: /m)
      }
    })

    it('emits an AntiGravity tools array using only confirmed identifiers, not Claude names', () => {
      const result = generateSubagent(
        'multi-client-skill',
        description,
        heavyToolContent,
        analysis,
        'antigravity'
      )

      const content = result.subagent!.content
      // Never leak Skillsmith's internal Claude-style names into the value.
      expect(content).not.toMatch(/- (Read|Write|Edit|Bash|Grep|Glob|WebFetch|WebSearch)$/m)
    })

    it('gives OpenCode a mode: subagent line but no tools/model fields', () => {
      const result = generateSubagent(
        'multi-client-skill',
        description,
        heavyToolContent,
        analysis,
        'opencode'
      )

      const content = result.subagent!.content
      expect(content).toMatch(/^mode: subagent$/m)
      expect(content).not.toMatch(/^tools:/m)
      expect(content).not.toMatch(/^model:/m)
    })
  })

  // GPT-5.6-Sol round-2 pr-reviewer confirmation (SMI-6276): round 1's fix
  // (JSON.stringify()-quoting the description) was CONFIRMED-FIXED, but the
  // round-1 regression tests only asserted a description LINE existed, never
  // actually exercised a hazardous `: ` or ` #` sequence. This closes that
  // coverage gap by parsing the generated frontmatter with a real YAML
  // parser, proving both that it's syntactically valid AND that the
  // hazardous substrings survive intact rather than corrupting the block.
  describe('YAML-safe description quoting (SMI-6276 round 2)', () => {
    // Heavy tool-usage body (same pattern already proven above in this file)
    // to reliably clear generateSubagent()'s own "worth generating" gate —
    // the hazardous text under test lives only in the `description` argument
    // passed to generateSubagent(), not the source SKILL.md's own frontmatter.
    const heavyToolBody = `---
name: hazard-skill
description: A skill with heavy tool usage for YAML-hazard testing
---

# Hazard Skill

- npm install
- git status
- docker build
- npx something
- yarn add
- pnpm install

Use bash to execute commands.
Terminal operations are common.
`

    it('a description containing ": " does not get reinterpreted as a nested YAML key', () => {
      const description = 'Handles config: values and other: colon-separated pairs'
      const analysis = analyzeSkill(heavyToolBody)
      const result = generateSubagent('colon-skill', description, heavyToolBody, analysis)

      const frontmatter = extractFrontmatter(result.subagent!.content)
      const parsed = parseYaml(frontmatter) as Record<string, unknown>
      // The full description text must survive as ONE string value under the
      // `description` key — not silently truncated, and not exploded into
      // extra top-level keys by an unescaped `: `.
      expect(typeof parsed.description).toBe('string')
      expect(parsed.description as string).toContain(description)
      expect(Object.keys(parsed)).not.toContain('values and other')
    })

    it('a description containing " #" does not get truncated as a YAML comment', () => {
      const description = 'Fixes issue #123 and #456 before release'
      const analysis = analyzeSkill(heavyToolBody)
      const result = generateSubagent('hash-skill', description, heavyToolBody, analysis)

      const frontmatter = extractFrontmatter(result.subagent!.content)
      const parsed = parseYaml(frontmatter) as Record<string, unknown>
      expect(typeof parsed.description).toBe('string')
      // Everything after the first ` #` must still be present -- an
      // unquoted scalar would have silently dropped "123 and #456...".
      expect(parsed.description as string).toContain('#123 and #456 before release')
    })
  })
})

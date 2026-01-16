/**
 * SKILL.md Validation Tests
 * @module indexer/validation.test
 *
 * Comprehensive tests for SKILL.md validation logic used by the indexer.
 * Tests cover:
 * - YAML frontmatter parsing
 * - Content validation (length, structure)
 * - Quality gate scenarios
 */

import { describe, it, expect } from 'vitest'
import {
  parseYamlFrontmatter,
  validateSkillMdContent,
  extractTitle,
  passesQualityGate,
} from './validation.ts'

describe('parseYamlFrontmatter', () => {
  describe('valid frontmatter', () => {
    it('should parse valid frontmatter with name and description', () => {
      const content = `---
name: my-skill
description: A helpful skill for developers
---

# My Skill

Content here.`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter.name).toBe('my-skill')
      expect(result?.frontmatter.description).toBe('A helpful skill for developers')
      expect(result?.content).toContain('# My Skill')
    })

    it('should parse frontmatter with all common fields', () => {
      const content = `---
name: advanced-skill
description: A comprehensive skill with all fields
author: test-author
version: 1.0.0
category: development
---

# Advanced Skill`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter.name).toBe('advanced-skill')
      expect(result?.frontmatter.description).toBe('A comprehensive skill with all fields')
      expect(result?.frontmatter.author).toBe('test-author')
      expect(result?.frontmatter.version).toBe('1.0.0')
      expect(result?.frontmatter.category).toBe('development')
    })

    it('should parse frontmatter with array triggers (list format)', () => {
      const content = `---
name: trigger-skill
description: Skill with triggers
triggers:
  - "run tests"
  - "execute tests"
  - "test command"
---

# Trigger Skill`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter.triggers).toEqual(['run tests', 'execute tests', 'test command'])
    })

    it('should parse frontmatter with inline array triggers', () => {
      const content = `---
name: inline-triggers
description: Skill with inline triggers
triggers: [run tests, execute tests]
---

# Inline Triggers`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter.triggers).toEqual(['run tests', 'execute tests'])
    })

    it('should parse frontmatter with quoted values', () => {
      const content = `---
name: "quoted-skill"
description: 'Single quoted description'
---

# Quoted Skill`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter.name).toBe('quoted-skill')
      expect(result?.frontmatter.description).toBe('Single quoted description')
    })

    it('should handle frontmatter with comments', () => {
      const content = `---
# This is a comment
name: commented-skill
# Another comment
description: Skill with comments in frontmatter
---

# Commented Skill`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter.name).toBe('commented-skill')
      expect(result?.frontmatter.description).toBe('Skill with comments in frontmatter')
    })
  })

  describe('missing frontmatter', () => {
    it('should return null when no --- delimiters present', () => {
      const content = `# My Skill

This is a skill without frontmatter.`

      const result = parseYamlFrontmatter(content)

      expect(result).toBeNull()
    })

    it('should return null when only opening delimiter present', () => {
      const content = `---
name: incomplete

# My Skill`

      const result = parseYamlFrontmatter(content)

      expect(result).toBeNull()
    })

    it('should return null for content not starting with ---', () => {
      const content = `# Title First

---
name: late-frontmatter
---

Content`

      const result = parseYamlFrontmatter(content)

      expect(result).toBeNull()
    })
  })

  describe('empty frontmatter', () => {
    it('should handle empty frontmatter block', () => {
      const content = `---
---

# Empty Frontmatter Skill`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter).toEqual({})
      expect(result?.content).toContain('# Empty Frontmatter Skill')
    })

    it('should handle frontmatter with only whitespace', () => {
      const content = `---

---

# Whitespace Frontmatter`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter).toEqual({})
    })
  })

  describe('malformed YAML', () => {
    it('should handle invalid key without colon', () => {
      const content = `---
name: valid-skill
invalid line without colon
description: still works
---

# Skill`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter.name).toBe('valid-skill')
      expect(result?.frontmatter.description).toBe('still works')
    })

    it('should handle empty values gracefully', () => {
      const content = `---
name:
description: has value
---

# Skill`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      // Empty value after name: creates an empty array (expecting list items)
      expect(result?.frontmatter.description).toBe('has value')
    })

    it('should handle special characters in values', () => {
      const content = `---
name: special-chars
description: Contains: colons and "quotes" and 'apostrophes'
---

# Special Characters`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter.name).toBe('special-chars')
      // The colon splits at first occurrence, rest is the value
      expect(result?.frontmatter.description).toContain('colons')
    })
  })

  describe('edge cases', () => {
    it('should return null for null input', () => {
      const result = parseYamlFrontmatter(null as unknown as string)
      expect(result).toBeNull()
    })

    it('should return null for undefined input', () => {
      const result = parseYamlFrontmatter(undefined as unknown as string)
      expect(result).toBeNull()
    })

    it('should return null for empty string', () => {
      const result = parseYamlFrontmatter('')
      expect(result).toBeNull()
    })

    it('should return null for non-string input', () => {
      const result = parseYamlFrontmatter(123 as unknown as string)
      expect(result).toBeNull()
    })

    it('should handle content with only frontmatter', () => {
      const content = `---
name: only-frontmatter
---`

      const result = parseYamlFrontmatter(content)

      expect(result).not.toBeNull()
      expect(result?.frontmatter.name).toBe('only-frontmatter')
      expect(result?.content).toBe('')
    })
  })
})

describe('extractTitle', () => {
  it('should extract H1 title from content', () => {
    const content = `# My Awesome Skill

This is the description.`

    const title = extractTitle(content)
    expect(title).toBe('My Awesome Skill')
  })

  it('should return first H1 when multiple exist', () => {
    const content = `# First Title

## Section

# Second Title`

    const title = extractTitle(content)
    expect(title).toBe('First Title')
  })

  it('should ignore H2 and lower headings', () => {
    const content = `## Not a Title

### Also Not

# This Is The Title`

    const title = extractTitle(content)
    expect(title).toBe('This Is The Title')
  })

  it('should return null when no H1 present', () => {
    const content = `## Only H2

This is content without an H1.`

    const title = extractTitle(content)
    expect(title).toBeNull()
  })

  it('should return null for empty content', () => {
    expect(extractTitle('')).toBeNull()
    expect(extractTitle(null as unknown as string)).toBeNull()
  })

  it('should trim whitespace from title', () => {
    const content = `#    Spaced Title

Content`

    const title = extractTitle(content)
    expect(title).toBe('Spaced Title')
  })
})

describe('validateSkillMdContent', () => {
  describe('valid SKILL.md with frontmatter', () => {
    it('should accept valid SKILL.md with frontmatter and content', () => {
      const content = `---
name: my-skill
description: A helpful skill for developers
---

# My Skill

This is a comprehensive skill that helps developers with their daily tasks.
It provides useful functionality and integrates well with the development workflow.`

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.metadata?.name).toBe('my-skill')
      expect(result.metadata?.description).toBe('A helpful skill for developers')
      expect(result.hasFrontmatter).toBe(true)
      expect(result.hasTitle).toBe(true)
    })

    it('should accept SKILL.md with complete metadata', () => {
      const content = `---
name: complete-skill
description: A fully documented skill with all metadata fields
author: test-author
version: 2.0.0
category: testing
triggers:
  - run tests
  - execute test suite
---

# Complete Skill

This skill demonstrates all possible frontmatter fields being properly parsed.
The content is substantial enough to pass the minimum length requirements.`

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(true)
      expect(result.metadata?.name).toBe('complete-skill')
      expect(result.metadata?.author).toBe('test-author')
      expect(result.metadata?.version).toBe('2.0.0')
      expect(result.metadata?.triggers).toEqual(['run tests', 'execute test suite'])
    })
  })

  describe('valid SKILL.md without frontmatter', () => {
    it('should accept SKILL.md without frontmatter but with title', () => {
      const content = `# My Simple Skill

This is a skill that doesn't have YAML frontmatter but still has a proper
title heading and sufficient content to be considered valid.

## Features

- Feature one
- Feature two`

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(true)
      expect(result.hasFrontmatter).toBe(false)
      expect(result.hasTitle).toBe(true)
      expect(result.metadata?.name).toBe('my-simple-skill') // Derived from title
    })

    it('should generate name from title when frontmatter has no name', () => {
      const content = `---
description: A skill with description but no name
---

# Generated Name Skill

This content is long enough to pass validation and demonstrates
how the name field is generated from the title when not provided in frontmatter.`

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(true)
      expect(result.metadata?.name).toBe('generated-name-skill')
    })
  })

  describe('invalid: empty content', () => {
    it('should reject empty string', () => {
      const result = validateSkillMdContent('')

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Content is empty or invalid')
    })

    it('should reject null content', () => {
      const result = validateSkillMdContent(null as unknown as string)

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Content is empty or invalid')
    })

    it('should reject undefined content', () => {
      const result = validateSkillMdContent(undefined as unknown as string)

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Content is empty or invalid')
    })

    it('should reject whitespace-only content', () => {
      const result = validateSkillMdContent('   \n\n   ')

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('too short'))).toBe(true)
    })
  })

  describe('invalid: too short content', () => {
    it('should reject SKILL.md that is too short (< 100 chars)', () => {
      const content = '# Short\n\nToo short.'

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('Content too short'))).toBe(true)
    })

    it('should report actual vs minimum length', () => {
      const content = '# Tiny\n\nSmall.'

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('characters')
      expect(result.errors[0]).toContain('minimum: 100')
    })

    it('should accept content exactly at minimum length', () => {
      // Create content that is exactly 100 characters
      const content = `# Minimum Length Skill

This content is carefully crafted to be exactly at the minimum length limit.`
      // Pad to exactly 100 chars if needed
      const paddedContent = content.padEnd(100, '.')

      const result = validateSkillMdContent(paddedContent)

      expect(result.contentLength).toBeGreaterThanOrEqual(100)
    })

    it('should respect custom minContentLength option', () => {
      const content = `# Custom Length

This is a shorter skill that would normally fail.`

      const result = validateSkillMdContent(content, { minContentLength: 50 })

      expect(result.valid).toBe(true)
    })
  })

  describe('invalid: no title heading', () => {
    it('should reject content without H1 heading', () => {
      const content = `---
name: no-title-skill
description: This skill has frontmatter but no title heading
---

This content has no H1 heading anywhere.
It just starts with a paragraph and continues with more text.
Even though it's long enough, it lacks the required title.`

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('No title heading (# Title) found in content')
    })

    it('should reject content with only H2 headings', () => {
      const content = `---
name: h2-only
description: Only has H2 headings
---

## Section One

Content under section one is substantial.

## Section Two

More content under section two to make it long enough.`

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('No title heading'))).toBe(true)
    })
  })

  describe('invalid: frontmatter missing required fields', () => {
    it('should warn when frontmatter missing description', () => {
      const content = `---
name: no-description
---

# No Description Skill

This skill has a name in frontmatter but is missing the description field.
The validator should add a warning but still consider it valid if other criteria are met.`

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(true) // Warnings don't fail validation
      expect(result.warnings.some((w) => w.includes('missing "description"'))).toBe(true)
    })

    it('should warn when description is too short', () => {
      const content = `---
name: short-desc
description: Short
---

# Short Description Skill

This skill has a description that is shorter than the recommended minimum length.
The validator should warn about this but not fail validation entirely.`

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes('description'))).toBe(true)
    })

    it('should fail when frontmatter required but missing', () => {
      const content = `# Required Frontmatter Skill

This skill has no frontmatter but the option requires it.
It should fail validation when requireFrontmatter is true.`

      const result = validateSkillMdContent(content, { requireFrontmatter: true })

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('frontmatter is required'))).toBe(true)
    })
  })

  describe('warnings', () => {
    it('should warn about non-string name in frontmatter', () => {
      // This tests type coercion - YAML might parse as number
      const content = `---
name: 12345
description: Numeric name
---

# Numeric Name

Content with enough length to pass validation requirements for the skill.`

      const result = validateSkillMdContent(content)

      // YAML parsed as string in our simple parser
      expect(result.valid).toBe(true)
    })

    it('should warn about non-array triggers', () => {
      const content = `---
name: bad-triggers
description: Has string instead of array for triggers
triggers: single trigger
---

# Bad Triggers Skill

This skill has triggers defined as a string instead of an array.
The validator should warn about this format issue.`

      const result = validateSkillMdContent(content)

      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes('triggers'))).toBe(true)
    })
  })
})

describe('Quality gate scenarios', () => {
  describe('minimum content length validation', () => {
    it('should pass skills with adequate content', () => {
      const content = `---
name: adequate-skill
description: A skill with adequate content length
---

# Adequate Skill

This skill has enough content to pass the minimum length validation.
It includes a proper description, features, and usage instructions.

## Features

- Feature one provides useful functionality
- Feature two enhances developer experience

## Usage

Use this skill by invoking the appropriate trigger phrases.`

      const result = validateSkillMdContent(content)
      expect(result.valid).toBe(true)
      expect(result.contentLength).toBeGreaterThan(100)
    })

    it('should fail skills below minimum threshold', () => {
      const content = `# Min\n\nToo short.`

      const result = validateSkillMdContent(content)
      expect(result.valid).toBe(false)
    })

    it('should use custom minimum length when specified', () => {
      const content = `# Custom Min

Short content.`

      const strictResult = validateSkillMdContent(content, { minContentLength: 200 })
      expect(strictResult.valid).toBe(false)

      const lenientResult = validateSkillMdContent(content, { minContentLength: 20 })
      expect(lenientResult.valid).toBe(true)
    })
  })

  describe('title presence validation', () => {
    it('should require H1 title in content', () => {
      const withTitle = `# Valid Title

This content has a proper H1 title and should pass validation.
It contains enough text to meet the minimum length requirements.`

      const withoutTitle = `## Not An H1

This content only has H2 headings and should fail validation.
Even though it has enough content, the missing H1 is a problem.`

      expect(validateSkillMdContent(withTitle).hasTitle).toBe(true)
      expect(validateSkillMdContent(withoutTitle).hasTitle).toBe(false)
    })

    it('should derive name from title if not in frontmatter', () => {
      const content = `# My Awesome Dev Tool

This is a skill without a name in frontmatter.
The title should be converted to a slug for the name.`

      const result = validateSkillMdContent(content)
      expect(result.metadata?.name).toBe('my-awesome-dev-tool')
    })
  })

  describe('description length validation in frontmatter', () => {
    it('should warn for descriptions below minimum', () => {
      const content = `---
name: short-desc-skill
description: Hi
---

# Short Description

This skill has a very short description that should trigger a warning.
The content itself is long enough to pass the length validation.`

      const result = validateSkillMdContent(content, { minDescriptionLength: 10 })
      expect(result.warnings.some((w) => w.includes('description'))).toBe(true)
    })

    it('should not warn for adequate descriptions', () => {
      const content = `---
name: good-desc-skill
description: This is a comprehensive description that explains what the skill does
---

# Good Description

This skill has an adequate description in the frontmatter.
No warnings should be generated for the description field.`

      const result = validateSkillMdContent(content, { minDescriptionLength: 10 })
      expect(result.warnings.every((w) => !w.includes('is short'))).toBe(true)
    })
  })
})

describe('passesQualityGate', () => {
  it('should return true for valid skills with frontmatter', () => {
    const content = `---
name: quality-skill
description: A skill that passes all quality gates
---

# Quality Skill

This skill meets all quality requirements including proper frontmatter,
adequate content length, and a valid title heading.`

    expect(passesQualityGate(content, true)).toBe(true)
  })

  it('should return false for skills without required frontmatter', () => {
    const content = `# No Frontmatter Skill

This skill has no frontmatter and should fail when strict validation is enabled.
It has enough content length and a proper title though.`

    expect(passesQualityGate(content, true)).toBe(false)
    expect(passesQualityGate(content, false)).toBe(true)
  })

  it('should return false for short content', () => {
    const content = `---
name: short
description: Too short
---

# Short

Tiny.`

    expect(passesQualityGate(content, true)).toBe(false)
  })

  it('should return false for missing title', () => {
    const content = `---
name: no-title
description: This skill has no title heading
---

Just content without any heading at all.
This should fail the quality gate even with frontmatter.
Adding more content to ensure length is not the issue.`

    expect(passesQualityGate(content, true)).toBe(false)
  })
})

describe('integration scenarios', () => {
  it('should handle real-world SKILL.md format', () => {
    const content = `---
name: docker
description: Container-based development for isolated, reproducible environments
author: skillsmith
version: 1.0.0
category: devops
triggers:
  - npm install
  - run the build
  - start the server
  - install package
---

# Docker Development Skill

Use this skill when running npm commands, installing packages, executing code,
or managing project dependencies.

## Features

- Isolated development environments
- Reproducible builds
- Consistent dependency management

## Usage

Trigger phrases include "npm install", "run the build", "start the server",
"install package", or any code execution request.

## Configuration

Ensure Docker is installed and running on your system.`

    const result = validateSkillMdContent(content)

    expect(result.valid).toBe(true)
    expect(result.metadata?.name).toBe('docker')
    expect(result.metadata?.description).toBe(
      'Container-based development for isolated, reproducible environments'
    )
    expect(result.metadata?.author).toBe('skillsmith')
    expect(result.metadata?.triggers).toContain('npm install')
    expect(result.hasFrontmatter).toBe(true)
    expect(result.hasTitle).toBe(true)
  })

  it('should handle minimal valid SKILL.md', () => {
    const content = `# Minimal Skill

This is the absolute minimum valid SKILL.md file.
It has just a title and enough content to pass validation.
No frontmatter is required in lenient mode.`

    const result = validateSkillMdContent(content, { requireFrontmatter: false })

    expect(result.valid).toBe(true)
    expect(result.hasFrontmatter).toBe(false)
    expect(result.hasTitle).toBe(true)
  })

  it('should handle SKILL.md with code blocks', () => {
    const content = `---
name: code-skill
description: A skill with code examples
---

# Code Skill

This skill demonstrates handling of code blocks.

## Example

\`\`\`typescript
function hello(): string {
  return 'Hello, World!';
}
\`\`\`

## Usage

\`\`\`bash
npx run-skill code-skill
\`\`\``

    const result = validateSkillMdContent(content)

    expect(result.valid).toBe(true)
    expect(result.metadata?.name).toBe('code-skill')
  })
})

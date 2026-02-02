import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import { transformSkillBatch } from '../batch-transform-skills'

const TEST_SKILLS_DIR = path.join(__dirname, '__fixtures__', 'test-skills')

describe('transformSkillBatch', () => {
  beforeEach(async () => {
    // Create test fixtures directory
    await fs.mkdir(TEST_SKILLS_DIR, { recursive: true })
  })

  afterEach(async () => {
    // Clean up test fixtures
    await fs.rm(TEST_SKILLS_DIR, { recursive: true, force: true })
  })

  it('should transform skills with subagent patterns', async () => {
    // Create a test skill
    const skillDir = path.join(TEST_SKILLS_DIR, 'test-skill')
    await fs.mkdir(skillDir, { recursive: true })

    const skillMd = `---
name: test-skill
description: A test skill
---

# Test Skill

This is a test skill that needs transformation.
`

    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd)

    // Run transformation
    const result = await transformSkillBatch(TEST_SKILLS_DIR, {
      dryRun: false,
      verbose: true,
    })

    expect(result.success).toBe(true)
    expect(result.processed).toBe(1)
  })

  it('should handle dry run mode', async () => {
    const skillDir = path.join(TEST_SKILLS_DIR, 'test-skill')
    await fs.mkdir(skillDir, { recursive: true })

    const skillMd = `---
name: test-skill
---
# Test
`

    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd)

    const result = await transformSkillBatch(TEST_SKILLS_DIR, {
      dryRun: true,
      verbose: false,
    })

    expect(result.success).toBe(true)
    expect(result.processed).toBe(1)

    // Verify file wasn't actually modified
    const content = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
    expect(content).toContain('# Test')
  })

  it('should skip non-skill directories', async () => {
    // Create a non-skill directory
    const nonSkillDir = path.join(TEST_SKILLS_DIR, 'not-a-skill')
    await fs.mkdir(nonSkillDir, { recursive: true })
    await fs.writeFile(path.join(nonSkillDir, 'README.md'), '# Not a skill')

    const result = await transformSkillBatch(TEST_SKILLS_DIR, {
      dryRun: false,
      verbose: false,
    })

    expect(result.success).toBe(true)
    expect(result.processed).toBe(0)
    expect(result.skipped).toBe(1)
  })
})

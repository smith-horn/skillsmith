/**
 * @fileoverview Unit tests for `import-local` helpers (SMI-4665)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { walkSkillFiles, parseSkillFile, localSkillId } from '../../src/commands/import-local.js'

let workDir: string

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'skillsmith-import-local-'))
})

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

describe('localSkillId', () => {
  it('is deterministic — same path → same id', () => {
    const a = localSkillId('/foo/bar/SKILL.md')
    const b = localSkillId('/foo/bar/SKILL.md')
    expect(a).toBe(b)
    expect(a).toHaveLength(32)
  })

  it('different paths produce different ids', () => {
    const a = localSkillId('/foo/bar/SKILL.md')
    const b = localSkillId('/foo/baz/SKILL.md')
    expect(a).not.toBe(b)
  })
})

describe('walkSkillFiles', () => {
  it('discovers SKILL.md files at any depth', async () => {
    await fs.mkdir(join(workDir, 'skill-a'), { recursive: true })
    await fs.mkdir(join(workDir, 'nested', 'skill-b'), { recursive: true })
    await fs.writeFile(join(workDir, 'skill-a', 'SKILL.md'), '---\nname: a\n---\n# A\n')
    await fs.writeFile(join(workDir, 'nested', 'skill-b', 'SKILL.md'), '---\nname: b\n---\n# B\n')

    const { files, skipped } = await walkSkillFiles(workDir)
    expect(files).toHaveLength(2)
    expect(skipped).toHaveLength(0)
  })

  it('skips dotfile-prefixed directories (e.g. .git)', async () => {
    await fs.mkdir(join(workDir, '.git', 'skill'), { recursive: true })
    await fs.writeFile(join(workDir, '.git', 'skill', 'SKILL.md'), '---\nname: dot\n---\n')

    const { files } = await walkSkillFiles(workDir)
    expect(files).toHaveLength(0)
  })

  it('rejects symlinks whose target escapes the root', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'skillsmith-outside-'))
    try {
      await fs.mkdir(join(outside, 'rogue'), { recursive: true })
      await fs.writeFile(join(outside, 'rogue', 'SKILL.md'), '---\nname: rogue\n---\n')
      // Symlink inside workDir pointing to outside dir.
      await fs.symlink(outside, join(workDir, 'leak'))

      const { files, skipped } = await walkSkillFiles(workDir)
      expect(files).toHaveLength(0)
      expect(skipped.some((s) => s.reason === 'symlink-escapes-root')).toBe(true)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('parseSkillFile', () => {
  it('parses well-formed frontmatter (name, description, tags, triggers)', async () => {
    const file = join(workDir, 'SKILL.md')
    await fs.writeFile(
      file,
      '---\nname: my-skill\ndescription: A useful skill\ntags:\n  - foo\n  - bar\ntriggers:\n  - "do the thing"\n---\n# Body\n'
    )

    const record = await parseSkillFile(file)
    expect(record.error).toBeUndefined()
    expect(record.name).toBe('my-skill')
    expect(record.description).toBe('A useful skill')
    expect(record.tags).toEqual(['foo', 'bar'])
    expect(record.triggers).toEqual(['do the thing'])
  })

  it('falls back to parent dir name when frontmatter has no name', async () => {
    const dir = join(workDir, 'fallback-skill')
    await fs.mkdir(dir)
    const file = join(dir, 'SKILL.md')
    await fs.writeFile(file, '---\ndescription: nameless\n---\nbody\n')

    const record = await parseSkillFile(file)
    expect(record.name).toBe('fallback-skill')
    expect(record.description).toBe('nameless')
  })

  it('returns an error record (does not throw) on malformed YAML frontmatter', async () => {
    const file = join(workDir, 'SKILL.md')
    // Unclosed quote in YAML triggers parse failure.
    await fs.writeFile(file, '---\nname: "unterminated\n---\n# body\n')

    const record = await parseSkillFile(file)
    expect(record.error).toBeDefined()
    expect(record.error).toMatch(/frontmatter-parse-failed/)
  })

  it('extracts description from first body paragraph when frontmatter omits it', async () => {
    const file = join(workDir, 'SKILL.md')
    await fs.writeFile(
      file,
      '---\nname: paragraph-fallback\n---\n# Heading\n\nThe first non-heading line.\n\nSecond paragraph.\n'
    )

    const record = await parseSkillFile(file)
    expect(record.description).toBe('The first non-heading line.')
  })
})

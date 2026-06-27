/**
 * Unit tests for src/services/localSkillReader.ts (SMI-5401).
 *
 * All fs reads are exercised through the injectable `readFile` parameter so
 * no real filesystem access is needed. vscode is mocked at module level
 * because localSkillReader imports it (only used inside resolveSkillsRoot,
 * which is not under test here since it's vscode-config-bound).
 */
import { describe, it, expect, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'

// vscode must be mocked before importing any module that depends on it.
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => undefined),
    })),
  },
}))

import {
  resolveLocalSkillDir,
  loadLocalSkillFromDir,
  calculateLocalQualityScore,
  splitFrontmatter,
} from '../../services/localSkillReader.js'
import type { LocalSkillFrontmatter, SkillFileReader } from '../../services/localSkillReader.js'

// ── Test fixtures ──────────────────────────────────────────────────────────────

/** Uses os.homedir() so the path is valid on every platform running the suite. */
const TEST_ROOT = path.join(os.homedir(), '.claude', 'skills')

/** A complete SKILL.md with all frontmatter fields populated. */
const FIXTURE_SKILL_MD = `---
name: My CI Skill
description: Diagnoses CI pipeline issues
author: skillsmith
tags: [ci, testing, pipeline]
version: 1.0.0
repository: https://github.com/skillsmith/ci-doctor
---

# CI Doctor

This skill diagnoses CI pipeline issues quickly.
`

function makeEmptyFm(overrides: Partial<LocalSkillFrontmatter> = {}): LocalSkillFrontmatter {
  return {
    name: null,
    description: null,
    author: null,
    tags: [],
    version: null,
    repository: null,
    ...overrides,
  }
}

// ── resolveLocalSkillDir ───────────────────────────────────────────────────────

describe('resolveLocalSkillDir', () => {
  it('returns <root>/<id> for a safe single-segment slug', () => {
    const result = resolveLocalSkillDir('ci-doctor', TEST_ROOT)
    expect(result).toBe(path.join(TEST_ROOT, 'ci-doctor'))
  })

  it('throws on an empty id', () => {
    expect(() => resolveLocalSkillDir('', TEST_ROOT)).toThrow('Unsafe skill id')
  })

  it('throws on a path with a forward slash (a/b) — defense-in-depth against traversal', () => {
    expect(() => resolveLocalSkillDir('a/b', TEST_ROOT)).toThrow('Unsafe skill id')
  })

  it('throws on a path with a backslash (a\\\\b)', () => {
    expect(() => resolveLocalSkillDir('a\\b', TEST_ROOT)).toThrow('Unsafe skill id')
  })

  it('throws on a dotdot traversal component (../etc)', () => {
    expect(() => resolveLocalSkillDir('../etc', TEST_ROOT)).toThrow('Unsafe skill id')
  })

  it('throws on a dotdot embedded in a longer id (a..b)', () => {
    expect(() => resolveLocalSkillDir('a..b', TEST_ROOT)).toThrow('Unsafe skill id')
  })

  it('throws on a leading-dot id (.hidden)', () => {
    expect(() => resolveLocalSkillDir('.hidden', TEST_ROOT)).toThrow('Unsafe skill id')
  })

  it('throws on a NUL byte in the id (defense against OS injection)', () => {
    expect(() => resolveLocalSkillDir('id\0evil', TEST_ROOT)).toThrow('Unsafe skill id')
  })

  it('throws on an id that escapes the skills root via dotdot (resolves outside root)', () => {
    // '../evil' contains '..' — caught by the contains-dotdot check before path resolution.
    // The net effect is identical: any id that would escape the root is rejected.
    expect(() => resolveLocalSkillDir('../evil', TEST_ROOT)).toThrow(/Unsafe skill id/)
  })
})

// ── loadLocalSkillFromDir ──────────────────────────────────────────────────────

describe('loadLocalSkillFromDir', () => {
  it('sets id to the directory basename — NOT the frontmatter name (M1)', async () => {
    const dir = path.join(TEST_ROOT, 'ci-doctor')
    const readFile = vi.fn().mockResolvedValue(FIXTURE_SKILL_MD) as unknown as SkillFileReader

    const skill = await loadLocalSkillFromDir(dir, readFile)

    // The frontmatter says name: "My CI Skill" but id must be the on-disk slug.
    // This keeps telemetry, cross-ref, and inferRepositoryUrl keyed on the stable slug.
    expect(skill.id).toBe('ci-doctor')
    expect(skill.id).not.toBe('My CI Skill')
  })

  it('maps the display name from frontmatter', async () => {
    const dir = path.join(TEST_ROOT, 'ci-doctor')
    const readFile = vi.fn().mockResolvedValue(FIXTURE_SKILL_MD) as unknown as SkillFileReader

    const skill = await loadLocalSkillFromDir(dir, readFile)

    expect(skill.name).toBe('My CI Skill')
  })

  it('maps description from frontmatter', async () => {
    const dir = path.join(TEST_ROOT, 'ci-doctor')
    const readFile = vi.fn().mockResolvedValue(FIXTURE_SKILL_MD) as unknown as SkillFileReader

    const skill = await loadLocalSkillFromDir(dir, readFile)

    expect(skill.description).toBe('Diagnoses CI pipeline issues')
  })

  it('sets content to the markdown body (after the closing ---)', async () => {
    const dir = path.join(TEST_ROOT, 'ci-doctor')
    const readFile = vi.fn().mockResolvedValue(FIXTURE_SKILL_MD) as unknown as SkillFileReader

    const skill = await loadLocalSkillFromDir(dir, readFile)

    // Body starts after the closing ---.
    expect(skill.content).toContain('# CI Doctor')
    // Frontmatter delimiter must not appear in the body.
    expect(skill.content).not.toContain('name: My CI Skill')
  })

  it('sets trustTier to "local"', async () => {
    const dir = path.join(TEST_ROOT, 'ci-doctor')
    const readFile = vi.fn().mockResolvedValue(FIXTURE_SKILL_MD) as unknown as SkillFileReader

    const skill = await loadLocalSkillFromDir(dir, readFile)

    expect(skill.trustTier).toBe('local')
  })

  it('sets category to "local"', async () => {
    const dir = path.join(TEST_ROOT, 'ci-doctor')
    const readFile = vi.fn().mockResolvedValue(FIXTURE_SKILL_MD) as unknown as SkillFileReader

    const skill = await loadLocalSkillFromDir(dir, readFile)

    expect(skill.category).toBe('local')
  })

  it('computes a non-zero quality score for complete frontmatter', async () => {
    const dir = path.join(TEST_ROOT, 'ci-doctor')
    const readFile = vi.fn().mockResolvedValue(FIXTURE_SKILL_MD) as unknown as SkillFileReader

    const skill = await loadLocalSkillFromDir(dir, readFile)

    expect(skill.score).toBeGreaterThan(0)
  })

  it('sets all security fields to null (no registry scan data for local skills)', async () => {
    const dir = path.join(TEST_ROOT, 'ci-doctor')
    const readFile = vi.fn().mockResolvedValue(FIXTURE_SKILL_MD) as unknown as SkillFileReader

    const skill = await loadLocalSkillFromDir(dir, readFile)

    expect(skill.securityPassed).toBeNull()
    expect(skill.securityRiskScore).toBeNull()
    expect(skill.securityScannedAt).toBeNull()
    expect(skill.securityFindingsCount).toBeNull()
  })

  // origin-agnostic: a skill with a repository in its frontmatter (meaning it was
  // cloned from GitHub) is still keyed by its on-disk dir slug — not by the repo URL.
  it('id remains the dir basename even when frontmatter has a repository field (origin-agnostic)', async () => {
    const dir = path.join(TEST_ROOT, 'local-override')
    // FIXTURE_SKILL_MD includes repository: https://github.com/skillsmith/ci-doctor
    const readFile = vi.fn().mockResolvedValue(FIXTURE_SKILL_MD) as unknown as SkillFileReader

    const skill = await loadLocalSkillFromDir(dir, readFile)

    expect(skill.id).toBe('local-override')
    // The reader does not touch get_skill; it reads from disk.
  })

  // M3: missing SKILL.md → user-friendly error message
  it('rejects with the M3 user-friendly message when SKILL.md is missing', async () => {
    const dir = path.join(TEST_ROOT, 'nonexistent')
    const readFile = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
      ) as unknown as SkillFileReader

    await expect(loadLocalSkillFromDir(dir, readFile)).rejects.toThrow(
      'Skill "nonexistent" has no SKILL.md. Check ~/.claude/skills/nonexistent/'
    )
  })

  it('falls back to the dir basename as name when frontmatter name is absent', async () => {
    const dir = path.join(TEST_ROOT, 'my-skill')
    const noNameMd = `---
description: A skill without a name
---

Body text.
`
    const readFile = vi.fn().mockResolvedValue(noNameMd) as unknown as SkillFileReader

    const skill = await loadLocalSkillFromDir(dir, readFile)

    expect(skill.id).toBe('my-skill')
    expect(skill.name).toBe('my-skill') // falls back to id when no name in frontmatter
  })
})

// ── calculateLocalQualityScore — monotonicity ──────────────────────────────────

describe('calculateLocalQualityScore', () => {
  it('returns the hasSkillMd base score (20) for completely empty frontmatter', () => {
    const empty = makeEmptyFm()
    expect(calculateLocalQualityScore(empty)).toBe(20)
  })

  it('returns 0 when hasSkillMd is false and frontmatter is empty', () => {
    const empty = makeEmptyFm()
    expect(calculateLocalQualityScore(empty, false)).toBe(0)
  })

  it('scores higher when name is added', () => {
    const base = makeEmptyFm()
    const withName = makeEmptyFm({ name: 'My Skill' })
    expect(calculateLocalQualityScore(withName)).toBeGreaterThan(calculateLocalQualityScore(base))
  })

  it('scores higher with more fields filled in (monotonicity)', () => {
    const empty = makeEmptyFm()
    const withName = makeEmptyFm({ name: 'X' })
    const withNameAndDesc = makeEmptyFm({ name: 'X', description: 'Y' })
    const full = makeEmptyFm({
      name: 'X',
      description: 'Y',
      author: 'Z',
      tags: ['a', 'b', 'c'],
    })

    const [s0, s1, s2, s3] = [
      calculateLocalQualityScore(empty),
      calculateLocalQualityScore(withName),
      calculateLocalQualityScore(withNameAndDesc),
      calculateLocalQualityScore(full),
    ]

    expect(s0).toBeLessThan(s1)
    expect(s1).toBeLessThan(s2)
    expect(s2).toBeLessThan(s3)
  })

  it('caps at 100 (cannot overflow)', () => {
    const maxFm = makeEmptyFm({
      name: 'X',
      description: 'A'.repeat(200), // max description length bonus
      author: 'Z',
      tags: ['a', 'b', 'c', 'd', 'e'], // 5 tags → max tag bonus
    })
    expect(calculateLocalQualityScore(maxFm)).toBeLessThanOrEqual(100)
  })
})

// ── splitFrontmatter ───────────────────────────────────────────────────────────

describe('splitFrontmatter', () => {
  it('parses standard YAML frontmatter and returns the body', () => {
    const content = '---\nname: Test\ndescription: Desc\n---\n\n# Body\n'
    const { frontmatter, body } = splitFrontmatter(content)

    expect(frontmatter.name).toBe('Test')
    expect(frontmatter.description).toBe('Desc')
    expect(body).toContain('# Body')
    expect(body).not.toContain('---')
  })

  it('treats the entire content as body when no frontmatter delimiter present', () => {
    const content = '# Just a body\n\nNo frontmatter here.'
    const { frontmatter, body } = splitFrontmatter(content)

    expect(frontmatter.name).toBeNull()
    expect(body).toContain('Just a body')
  })

  it('parses inline tag lists (bracket syntax)', () => {
    const content = '---\ntags: [ci, testing, pipeline]\n---\n\nbody\n'
    const { frontmatter } = splitFrontmatter(content)

    expect(frontmatter.tags).toEqual(['ci', 'testing', 'pipeline'])
  })

  it('returns null for absent optional fields', () => {
    const content = '---\nname: X\n---\n\nbody\n'
    const { frontmatter } = splitFrontmatter(content)

    expect(frontmatter.description).toBeNull()
    expect(frontmatter.author).toBeNull()
    expect(frontmatter.repository).toBeNull()
  })
})

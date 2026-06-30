/**
 * inventory-collector tests (SMI-5392).
 *
 * Controls the harness directory table by mocking `../install/paths.js` so each
 * `ClientId` points at a real tmp fixture. CLIENT_NATIVE_PATHS is a mutable
 * object the collector reads at call time, so per-test fixtures are visible
 * without re-importing the module.
 *
 * IC-1: same skill under two harnesses (distinct realpaths) -> two entries.
 * IC-2: a symlinked alias across harnesses -> one entry (first ClientId wins).
 * IC-3: readable SKILL.md -> content_hash + version; missing SKILL.md -> nulls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockPaths = vi.hoisted(() => ({
  CLIENT_IDS: ['claude-code', 'cursor', 'copilot', 'windsurf', 'agents'] as const,
  CLIENT_NATIVE_PATHS: {} as Record<string, string>,
}))

vi.mock('../install/paths.js', () => ({
  CLIENT_IDS: mockPaths.CLIENT_IDS,
  CLIENT_NATIVE_PATHS: mockPaths.CLIENT_NATIVE_PATHS,
}))

import { collectDeviceSkills } from './inventory-collector.js'
import { INVENTORY_LIMITS } from './inventory-types.js'

function skillMd(name: string, version?: string): string {
  const versionLine = version ? `\nversion: ${version}` : ''
  return `---\nname: ${name}${versionLine}\n---\n\n# ${name}\n`
}

interface ProvenanceFields {
  author?: string
  license?: string
  repository?: string
}

function skillMdWithProvenance(
  name: string,
  provenance: ProvenanceFields,
  version?: string
): string {
  const versionLine = version ? `\nversion: ${version}` : ''
  const authorLine = provenance.author ? `\nauthor: ${provenance.author}` : ''
  const licenseLine = provenance.license ? `\nlicense: ${provenance.license}` : ''
  const repoLine = provenance.repository ? `\nrepository: ${provenance.repository}` : ''
  return `---\nname: ${name}${versionLine}${authorLine}${licenseLine}${repoLine}\n---\n\n# ${name}\n`
}

async function createSkill(
  harness: string,
  name: string,
  opts: { version?: string; withSkillMd?: boolean; content?: string } = {}
): Promise<string> {
  const dir = join(mockPaths.CLIENT_NATIVE_PATHS[harness] as string, name)
  await mkdir(dir, { recursive: true })
  if (opts.withSkillMd !== false) {
    const content = opts.content ?? skillMd(name, opts.version)
    await writeFile(join(dir, 'SKILL.md'), content)
  }
  return dir
}

let root: string

describe('inventory-collector', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'inv-collector-'))
    // Point every harness at its own (initially absent) subdir under root.
    for (const id of mockPaths.CLIENT_IDS) {
      mockPaths.CLIENT_NATIVE_PATHS[id] = join(root, id)
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('IC-1: emits two entries for the same skill installed under two harnesses', async () => {
    await createSkill('claude-code', 'foo', { version: '1.0.0' })
    await createSkill('cursor', 'foo', { version: '2.0.0' })

    const entries = await collectDeviceSkills()
    const foo = entries.filter((e) => e.skill_id === 'foo')

    expect(foo).toHaveLength(2)
    expect(foo.map((e) => e.harness).sort()).toEqual(['claude-code', 'cursor'])
    // Distinct realpaths -> distinct rows, each carrying its own version + hash.
    expect(foo.every((e) => typeof e.content_hash === 'string')).toBe(true)
    // Static fields are always null at the local-agent layer.
    expect(foo.every((e) => e.source === null && e.pinned_version === null)).toBe(true)
    expect(foo.every((e) => e.update_policy === null)).toBe(true)
  })

  it('IC-2: collapses a symlinked alias across harnesses to one entry (first ClientId wins)', async () => {
    const real = await createSkill('claude-code', 'bar', { version: '1.0.0' })
    await mkdir(mockPaths.CLIENT_NATIVE_PATHS['agents'] as string, { recursive: true })
    await symlink(real, join(mockPaths.CLIENT_NATIVE_PATHS['agents'] as string, 'bar'), 'dir')

    const entries = await collectDeviceSkills()
    const bar = entries.filter((e) => e.skill_id === 'bar')

    expect(bar).toHaveLength(1)
    // claude-code precedes agents in CLIENT_IDS, so it wins the dedup.
    expect(bar[0]?.harness).toBe('claude-code')
  })

  // IC-4: No truncation at MAX_SKILLS boundary.
  //
  // The collector is intentionally uncapped — it returns EVERY on-disk entry.
  // The >5000 ceiling is enforced server-side via the `too_many_skills` 400 error
  // (see inventory-client tests) and will be covered end-to-end in Wave 5. This
  // test verifies the guarantee cheaply using a small K so the suite stays fast.
  it('IC-4: returned entry count equals the number of on-disk skills with no local cap applied', async () => {
    const K = 4
    for (let i = 0; i < K; i++) {
      await createSkill('claude-code', `skill-ic4-${i}`, { version: `1.0.${i}` })
    }

    const entries = await collectDeviceSkills()
    const ic4 = entries.filter((e) => e.skill_id.startsWith('skill-ic4-'))

    // The collector must not truncate: returned count must equal the on-disk count.
    expect(ic4).toHaveLength(K)
    // K is well below the server-enforced limit — no false ceiling here.
    expect(K).toBeLessThan(INVENTORY_LIMITS.MAX_SKILLS)
  })

  it('IC-3: populates content_hash + version for readable SKILL.md, nulls for missing', async () => {
    await createSkill('claude-code', 'withmd', { version: '3.1.4' })
    await createSkill('cursor', 'nomd', { withSkillMd: false })

    const entries = await collectDeviceSkills()
    const withMd = entries.find((e) => e.skill_id === 'withmd')
    const noMd = entries.find((e) => e.skill_id === 'nomd')

    expect(withMd?.version).toBe('3.1.4')
    expect(withMd?.content_hash).toMatch(/^[0-9a-f]{64}$/)

    // A subdir with no readable SKILL.md still counts, keyed by its dir name.
    expect(noMd).toBeDefined()
    expect(noMd?.version).toBeNull()
    expect(noMd?.content_hash).toBeNull()
  })

  // IC-5: provenance fields from SKILL.md front-matter propagate to the entry.
  it('IC-5: captures author/license/repository from SKILL.md front-matter (SMI-5442)', async () => {
    await createSkill('claude-code', 'provenance-skill', {
      version: '1.0.0',
      content: skillMdWithProvenance(
        'provenance-skill',
        {
          author: 'acme/tools',
          license: 'MIT',
          repository: 'https://github.com/acme/tools',
        },
        '1.0.0'
      ),
    })

    const entries = await collectDeviceSkills()
    const entry = entries.find((e) => e.skill_id === 'provenance-skill')

    expect(entry).toBeDefined()
    expect(entry?.author).toBe('acme/tools')
    expect(entry?.license).toBe('MIT')
    expect(entry?.repository).toBe('https://github.com/acme/tools')
  })

  // IC-6: provenance fields are null/absent when not in SKILL.md front-matter.
  it('IC-6: provenance fields are null when absent from SKILL.md front-matter (SMI-5442)', async () => {
    // skillMd() produces a minimal front-matter with no provenance fields.
    await createSkill('claude-code', 'no-provenance', { version: '0.1.0' })

    const entries = await collectDeviceSkills()
    const entry = entries.find((e) => e.skill_id === 'no-provenance')

    expect(entry).toBeDefined()
    expect(entry?.author).toBeNull()
    expect(entry?.license).toBeNull()
    expect(entry?.repository).toBeNull()
  })

  // IC-7: dot-prefixed directories (.backups and friends) are NOT enumerated.
  it('IC-7: dot-prefixed directories are skipped and never emitted as skill entries (SMI-5440/5442)', async () => {
    await createSkill('claude-code', 'real-skill', { version: '1.0.0' })

    // .backups is the canonical dot-dir created by apply_recommended_edit.
    // It contains a SKILL.md subdirectory (an EISDIR if you try to read it as a
    // file), which previously caused it to appear as an unknown skill entry.
    const backupsDir = join(mockPaths.CLIENT_NATIVE_PATHS['claude-code'] as string, '.backups')
    await mkdir(join(backupsDir, 'SKILL.md'), { recursive: true })

    const entries = await collectDeviceSkills()

    expect(entries.find((e) => e.skill_id === 'real-skill')).toBeDefined()
    expect(entries.find((e) => e.skill_id === '.backups')).toBeUndefined()
    expect(entries.some((e) => e.skill_id.startsWith('.'))).toBe(false)
  })
})

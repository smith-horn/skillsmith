/**
 * @fileoverview Tests for the SMI-5676 `.mcp.json` cross-check additions to
 *   skill-installation.helpers.ts (`getRegisteredMcpServers`, and the
 *   resolution-aware warning filtering in `extractDepIntel`), plus the
 *   SMI-5894 Wave 1 multi-client manifest-keying + tips additions
 *   (`manifestKeyFor`, `generateTips`), plus the SMI-6007 `performUninstall`
 *   manifest-concurrency hardening.
 * @module @skillsmith/core/services/skill-installation.helpers.test
 * @see SMI-5676: Wave 1 Step 3b — harden extractMcpReferences
 * @see SMI-5894: Wave 1 Steps 3/5 — multi-client manifest re-keying + tips
 * @see SMI-6007: performUninstall now routes its final manifest mutation
 *   through ManifestManager.updateSafely() instead of a direct load+save,
 *   closing a lost-update hazard against concurrent operations on other
 *   manifest entries.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  extractDepIntel,
  getRegisteredMcpServers,
  generateTips,
  manifestKeyFor,
  performUninstall,
} from './skill-installation.helpers.js'
import { ManifestManager } from './skill-manifest.js'
import type { SkillManifestEntry } from './skill-installation.types.js'
import type { SkillDependencyRepository } from '../repositories/SkillDependencyRepository.js'

describe('getRegisteredMcpServers (SMI-5676)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-mcp-json-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns undefined when .mcp.json does not exist (fail open)', () => {
    expect(getRegisteredMcpServers(tmpDir)).toBeUndefined()
  })

  it('returns the registered server names when .mcp.json is valid', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { ruflo: {}, skillsmith: {} } })
    )
    expect(getRegisteredMcpServers(tmpDir)).toEqual(['ruflo', 'skillsmith'])
  })

  it('returns an empty array when mcpServers is present but empty (checked, found nothing)', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
    expect(getRegisteredMcpServers(tmpDir)).toEqual([])
  })

  it('fails open (returns undefined) on unparseable JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{ not valid json')
    expect(getRegisteredMcpServers(tmpDir)).toBeUndefined()
  })

  it('fails open (returns undefined) when the mcpServers key is missing', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ foo: 'bar' }))
    expect(getRegisteredMcpServers(tmpDir)).toBeUndefined()
  })

  it('fails open (returns undefined) when mcpServers is not an object', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: 'nope' }))
    expect(getRegisteredMcpServers(tmpDir)).toBeUndefined()
  })

  it('fails open (returns undefined) when mcpServers is an array', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: ['ruflo'] }))
    expect(getRegisteredMcpServers(tmpDir)).toBeUndefined()
  })
})

describe('extractDepIntel resolution-aware warnings (SMI-5676)', () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-dep-intel-'))
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does not warn about a server confirmed registered in .mcp.json', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { linear: {} } }))
    process.chdir(tmpDir)

    const result = extractDepIntel('Use mcp__linear__save_issue to create issues.')

    expect(result.dep_inferred_servers).toContain('linear')
    expect(result.dep_warnings.some((w) => w.includes('linear'))).toBe(false)
  })

  it('warns about a server absent from .mcp.json (e.g. the claude-flow -> ruflo rename)', () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { ruflo: {} } }))
    process.chdir(tmpDir)

    const result = extractDepIntel('Use mcp__claude-flow__agent_spawn to spawn agents.')

    expect(result.dep_inferred_servers).toContain('claude-flow')
    expect(result.dep_warnings.some((w) => w.includes('claude-flow'))).toBe(true)
  })

  it('still warns when .mcp.json is missing (fail open -> unknown, not silently trusted)', () => {
    process.chdir(tmpDir) // no .mcp.json written

    const result = extractDepIntel('Use mcp__linear__save_issue to create issues.')

    expect(result.dep_warnings.some((w) => w.includes('linear'))).toBe(true)
  })
})

describe('manifestKeyFor (SMI-5894 Wave 1 Step 3)', () => {
  it('keys the canonical client (claude-code) by bare name — backward compatible', () => {
    expect(manifestKeyFor('my-skill', 'claude-code')).toBe('my-skill')
  })

  it('keys a non-canonical client with a composite name::client key', () => {
    expect(manifestKeyFor('my-skill', 'cursor')).toBe('my-skill::cursor')
    expect(manifestKeyFor('my-skill', 'windsurf')).toBe('my-skill::windsurf')
  })

  it('produces distinct keys for the same skill name under different clients', () => {
    const claudeKey = manifestKeyFor('same-name', 'claude-code')
    const cursorKey = manifestKeyFor('same-name', 'cursor')
    expect(claudeKey).not.toBe(cursorKey)
  })
})

describe('generateTips (SMI-5894 Wave 1 Step 5)', () => {
  const optimizationInfo = { optimized: false } as const

  it('defaults to Claude Code wording when client/skillsDir are omitted (backward compatible)', () => {
    const tips = generateTips('my-skill', optimizationInfo)
    expect(tips.join('\n')).toContain('mention it in Claude Code')
    expect(tips.join('\n')).toContain('ls ~/.claude/skills/')
  })

  it('names the actual client and install path when a non-canonical client is resolved', () => {
    const tips = generateTips('my-skill', optimizationInfo, 'cursor', '/home/user/.cursor/skills')
    const joined = tips.join('\n')
    expect(joined).toContain('mention it in Cursor')
    expect(joined).toContain('ls /home/user/.cursor/skills/')
    expect(joined).not.toContain('Claude Code')
  })
})

describe('performUninstall manifest concurrency (SMI-6007)', () => {
  let tmpDir: string
  let manifest: ManifestManager
  let skillDependencyRepo: SkillDependencyRepository

  function makeEntry(overrides: Partial<SkillManifestEntry> = {}): SkillManifestEntry {
    const now = new Date().toISOString()
    return {
      id: overrides.id ?? 'author/skill-to-remove',
      name: overrides.name ?? 'skill-to-remove',
      version: overrides.version ?? '1.0.0',
      source: overrides.source ?? 'github:author/skill-to-remove',
      installPath: overrides.installPath ?? path.join(tmpDir, 'skill-to-remove'),
      installedAt: overrides.installedAt ?? now,
      lastUpdated: overrides.lastUpdated ?? now,
      ...overrides,
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-uninstall-race-'))
    manifest = new ManifestManager(path.join(tmpDir, 'manifest.json'))
    // clearAll is best-effort (wrapped in try/catch by performUninstall) — a
    // minimal stub is sufficient for these manifest-concurrency tests.
    skillDependencyRepo = { clearAll: () => {} } as unknown as SkillDependencyRepository
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('an unrelated entry survives a concurrent update racing an uninstall (core SMI-6007 fix)', async () => {
    await manifest.save({
      version: '1.0.0',
      installedSkills: {
        'skill-to-remove': makeEntry(),
        'unrelated-skill': makeEntry({
          id: 'author/unrelated-skill',
          name: 'unrelated-skill',
          installPath: path.join(tmpDir, 'unrelated-skill'),
        }),
      },
    })

    const uninstall = performUninstall({
      skillName: 'skill-to-remove',
      force: true,
      skillsDir: tmpDir,
      manifest,
      skillDependencyRepo,
      onProgress: () => {},
    })

    // Simulates a second operation (e.g. a concurrent install) racing the
    // uninstall above, touching a DIFFERENT manifest entry.
    const concurrentUpdate = manifest.updateSafely((current) => ({
      ...current,
      installedSkills: {
        ...current.installedSkills,
        'concurrent-skill': makeEntry({
          id: 'author/concurrent-skill',
          name: 'concurrent-skill',
          installPath: path.join(tmpDir, 'concurrent-skill'),
        }),
      },
    }))

    const [uninstallResult] = await Promise.all([uninstall, concurrentUpdate])

    expect(uninstallResult.success).toBe(true)

    const finalManifest = await manifest.load()
    expect(finalManifest.installedSkills['skill-to-remove']).toBeUndefined()
    expect(finalManifest.installedSkills['unrelated-skill']).toBeDefined()
    expect(finalManifest.installedSkills['concurrent-skill']).toBeDefined()
  })
})

describe('performUninstall adopts untracked skills (ADR-139 point 1, SMI-6274 Wave 4 — required test 17)', () => {
  let tmpDir: string
  let manifest: ManifestManager
  let skillDependencyRepo: SkillDependencyRepository

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-adopt-'))
    manifest = new ManifestManager(path.join(tmpDir, 'manifest.json'))
    skillDependencyRepo = { clearAll: () => {} } as unknown as SkillDependencyRepository
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('adopts a skill on disk with no manifest entry and removes it WITHOUT requiring force', async () => {
    const skillDir = path.join(tmpDir, 'untracked-skill')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: untracked-skill\n---\n# hi\n')

    // Manifest genuinely has no entry at all — the exact "untracked" state
    // `list` would surface (a skill on disk, nothing tracking it).
    await manifest.save({ version: '1.0.0', installedSkills: {} })

    const result = await performUninstall({
      skillName: 'untracked-skill',
      force: false, // deliberately NOT forced — adoption must not require it
      skillsDir: tmpDir,
      manifest,
      skillDependencyRepo,
      onProgress: () => {},
    })

    expect(result.success).toBe(true)
    expect(result.warning).toContain('adopted')
    expect(fs.existsSync(skillDir)).toBe(false)
  })

  it('adoption reconstructs version/source as "unknown" rather than guessing', async () => {
    // Verified via a spy manifest so the adopted entry can be inspected
    // before removal deletes it again.
    const skillDir = path.join(tmpDir, 'untracked-skill-fields')
    fs.mkdirSync(skillDir, { recursive: true })
    await manifest.save({ version: '1.0.0', installedSkills: {} })

    let adoptedSnapshot: SkillManifestEntry | undefined
    const spyManifest = {
      path: manifest.path,
      load: () => manifest.load(),
      updateSafely: async (updateFn: Parameters<ManifestManager['updateSafely']>[0]) => {
        await manifest.updateSafely((current) => {
          const next = updateFn(current)
          // performUninstall calls updateSafely TWICE: once to write the
          // adopted entry, once more afterward to delete it post-removal.
          // Only capture the write — the later deletion call's `next` has
          // no entry for this key and must not clobber the snapshot.
          const candidate = next.installedSkills['untracked-skill-fields']
          if (candidate) adoptedSnapshot = candidate
          return next
        })
      },
    } as unknown as ManifestManager

    await performUninstall({
      skillName: 'untracked-skill-fields',
      force: false,
      skillsDir: tmpDir,
      manifest: spyManifest,
      skillDependencyRepo,
      onProgress: () => {},
    })

    expect(adoptedSnapshot).toBeDefined()
    expect(adoptedSnapshot?.version).toBe('unknown')
    expect(adoptedSnapshot?.source).toBe('unknown')
    expect(adoptedSnapshot?.installPath).toBe(skillDir)
  })

  it('only errors — naming the skill, path, and manifest — when adoption itself fails', async () => {
    const skillDir = path.join(tmpDir, 'untracked-skill-fail')
    fs.mkdirSync(skillDir, { recursive: true })

    // A minimal manifest double whose load() succeeds (so performUninstall
    // reaches the adoption step) but whose updateSafely() fails — isolates
    // the adoption-write failure path without relying on filesystem
    // permission tricks (unreliable when tests run as root in CI).
    const brokenManifest = {
      path: path.join(tmpDir, 'broken-manifest.json'),
      load: async () => ({ version: '1.0.0', installedSkills: {} }),
      updateSafely: async () => {
        throw new Error('disk full (simulated)')
      },
    } as unknown as ManifestManager

    const result = await performUninstall({
      skillName: 'untracked-skill-fail',
      force: false,
      skillsDir: tmpDir,
      manifest: brokenManifest,
      skillDependencyRepo,
      onProgress: () => {},
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('untracked-skill-fail')
    expect(result.message).toContain(skillDir)
    expect(result.message).toContain('broken-manifest.json')
    expect(result.message).toContain('disk full (simulated)')
    // Adoption failed, so removal must never have proceeded.
    expect(fs.existsSync(skillDir)).toBe(true)
  })
})

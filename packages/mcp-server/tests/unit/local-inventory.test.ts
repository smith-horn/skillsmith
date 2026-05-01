/**
 * Unit tests for SMI-4587 Wave 1 Step 2 — local-inventory scanner.
 * Covers all 4 sources (skills / commands / agents / CLAUDE.md) plus
 * fresh-install latency bound (P-ANTI-2 carryover) and CLAUDE.md
 * tolerance for malformed / missing files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { scanLocalInventory } from '../../src/utils/local-inventory.js'
import {
  WARNING_CODES,
  capTriggerSurface,
  hashClaudeMdLine,
  splitDescriptionToPhrases,
  MAX_TRIGGER_PHRASES_PER_SKILL,
} from '../../src/utils/local-inventory.helpers.js'
import type { ScanWarning } from '../../src/utils/local-inventory.types.js'

let TEST_HOME: string

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-inventory-'))
})

afterEach(() => {
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
})

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

describe('scanLocalInventory', () => {
  it('returns empty entries + warnings on fresh-install (no .claude dir)', async () => {
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('extracts skill kind=skill entries with name from frontmatter', async () => {
    writeFile(
      path.join(TEST_HOME, '.claude', 'skills', 'docker', 'SKILL.md'),
      `---\nname: docker\ndescription: Docker container management\n---\n# Docker Skill\n`
    )
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    const skill = result.entries.find((e) => e.kind === 'skill')
    expect(skill).toBeDefined()
    expect(skill?.identifier).toBe('docker')
    expect(skill?.meta?.description).toBe('Docker container management')
    expect(skill?.triggerSurface).toContain('docker')
  })

  it('falls back to directory name when SKILL.md missing and warns', async () => {
    fs.mkdirSync(path.join(TEST_HOME, '.claude', 'skills', 'orphan'), { recursive: true })
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    const orphan = result.entries.find((e) => e.identifier === 'orphan')
    expect(orphan).toBeDefined()
    expect(result.warnings.some((w) => w.code === WARNING_CODES.PARSE_FAILED)).toBe(true)
  })

  it('handles block-scalar description (description: |) via parseYamlFrontmatter', async () => {
    writeFile(
      path.join(TEST_HOME, '.claude', 'skills', 'multi', 'SKILL.md'),
      `---\nname: multi\ndescription: |\n  First line.\n  Second line.\n---\nbody\n`
    )
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    const skill = result.entries.find((e) => e.identifier === 'multi')
    expect(skill?.meta?.description).toMatch(/First line/)
    expect(skill?.meta?.description).toMatch(/Second line/)
  })

  it('scans frontmatter-less command files using first body line', async () => {
    writeFile(
      path.join(TEST_HOME, '.claude', 'commands', 'ship.md'),
      `Ship code: commit, push, PR, merge.\nMore detail follows.\n`
    )
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    const cmd = result.entries.find((e) => e.kind === 'command' && e.identifier === 'ship')
    expect(cmd).toBeDefined()
    expect(cmd?.meta?.description).toMatch(/Ship code/)
  })

  it('scans agent files with frontmatter description as trigger surface', async () => {
    writeFile(
      path.join(TEST_HOME, '.claude', 'agents', 'reviewer.md'),
      `---\nname: reviewer\ndescription: Reviews PRs for quality\n---\nbody\n`
    )
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    const agent = result.entries.find((e) => e.kind === 'agent' && e.identifier === 'reviewer')
    expect(agent).toBeDefined()
    expect(agent?.triggerSurface).toContain('reviewer')
    expect(agent?.meta?.description).toBe('Reviews PRs for quality')
  })

  it('extracts CLAUDE.md trigger phrases from Trigger phrases heading', async () => {
    writeFile(
      path.join(TEST_HOME, '.claude', 'CLAUDE.md'),
      `# Project notes\n\n## Trigger phrases\n\n- deploy to staging\n- run the migration\n\n## Other section\n\n- not a trigger\n`
    )
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    const triggers = result.entries.filter((e) => e.kind === 'claude_md_rule')
    expect(triggers).toHaveLength(2)
    const phrases = triggers.flatMap((t) => t.triggerSurface)
    expect(phrases).toContain('deploy to staging')
    expect(phrases).toContain('run the migration')
    expect(phrases).not.toContain('not a trigger')
  })

  it('captures high-confidence <!-- skillsmith:trigger --> markers', async () => {
    writeFile(
      path.join(TEST_HOME, '.claude', 'CLAUDE.md'),
      `# Notes\n\nNormal text.\n\nDeploy to staging <!-- skillsmith:trigger -->\n`
    )
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    const triggers = result.entries.filter((e) => e.kind === 'claude_md_rule')
    expect(triggers.length).toBeGreaterThanOrEqual(1)
    expect(triggers[0]?.triggerSurface[0]).toContain('Deploy to staging')
  })

  it('does not throw on malformed CLAUDE.md (binary-ish content)', async () => {
    writeFile(path.join(TEST_HOME, '.claude', 'CLAUDE.md'), '\x00\x01\x02\x03 not text')
    // Also include a valid skill so we can confirm the scan still produced output.
    writeFile(
      path.join(TEST_HOME, '.claude', 'skills', 'foo', 'SKILL.md'),
      `---\nname: foo\n---\nbody\n`
    )
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    expect(result.entries.some((e) => e.identifier === 'foo')).toBe(true)
  })

  it('populates entry.meta.author from manifest when present', async () => {
    writeFile(
      path.join(TEST_HOME, '.claude', 'skills', 'docker', 'SKILL.md'),
      `---\nname: docker\n---\nbody\n`
    )
    writeFile(
      path.join(TEST_HOME, '.skillsmith', 'manifest.json'),
      JSON.stringify({
        skills: [{ id: 'docker', author: 'anthropic', tags: ['container'] }],
      })
    )
    const result = await scanLocalInventory({
      homeDir: TEST_HOME,
      manifestPath: path.join(TEST_HOME, '.skillsmith', 'manifest.json'),
    })
    const skill = result.entries.find((e) => e.identifier === 'docker')
    expect(skill?.meta?.author).toBe('anthropic')
    expect(skill?.meta?.tags).toEqual(['container'])
  })

  it('leaves entry.meta.author undefined when manifest missing', async () => {
    writeFile(
      path.join(TEST_HOME, '.claude', 'skills', 'docker', 'SKILL.md'),
      `---\nname: docker\n---\nbody\n`
    )
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    const skill = result.entries.find((e) => e.identifier === 'docker')
    expect(skill?.meta?.author).toBeUndefined()
  })

  it('fresh-install latency: empty home + 5 unmanaged skills completes within 50ms (P-ANTI-2)', async () => {
    for (let i = 0; i < 5; i++) {
      writeFile(
        path.join(TEST_HOME, '.claude', 'skills', `unmanaged-${i}`, 'SKILL.md'),
        `---\nname: unmanaged-${i}\ndescription: Test skill ${i}\n---\nbody\n`
      )
    }

    // Warm any module caches with one untimed run.
    await scanLocalInventory({ homeDir: TEST_HOME })

    const t0 = process.hrtime.bigint()
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000
    expect(result.entries.length).toBeGreaterThanOrEqual(5)
    // 50ms is the P-ANTI-2 worst-case bound (10x the steady-state 5ms p95).
    expect(elapsedMs).toBeLessThan(50)
  })

  it('populates mtime field for skill entries', async () => {
    writeFile(
      path.join(TEST_HOME, '.claude', 'skills', 'docker', 'SKILL.md'),
      `---\nname: docker\n---\nbody\n`
    )
    const result = await scanLocalInventory({ homeDir: TEST_HOME })
    const skill = result.entries.find((e) => e.identifier === 'docker')
    expect(skill?.mtime).toBeTypeOf('number')
    expect(skill?.mtime).toBeGreaterThan(0)
  })

  it('caps triggerSurface at MAX_TRIGGER_PHRASES_PER_SKILL', () => {
    const warnings: ScanWarning[] = []
    const phrases = Array.from({ length: MAX_TRIGGER_PHRASES_PER_SKILL + 5 }, (_, i) => `p${i}`)
    const capped = capTriggerSurface('demo', phrases, warnings)
    expect(capped).toHaveLength(MAX_TRIGGER_PHRASES_PER_SKILL)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe(WARNING_CODES.TRIGGER_SURFACE_TRUNCATED)
    expect(warnings[0]?.context?.dropped_count).toBe(5)
  })
})

describe('local-inventory.helpers', () => {
  it('hashClaudeMdLine yields stable hash for same input', () => {
    const a = hashClaudeMdLine('/path/CLAUDE.md', 'deploy to staging')
    const b = hashClaudeMdLine('/path/CLAUDE.md', 'deploy to staging')
    expect(a).toBe(b)
    expect(a).toMatch(/^claude_md:[0-9a-f]{12}$/)
  })

  it('hashClaudeMdLine differs for different lines', () => {
    const a = hashClaudeMdLine('/path/CLAUDE.md', 'deploy')
    const b = hashClaudeMdLine('/path/CLAUDE.md', 'rollback')
    expect(a).not.toBe(b)
  })

  it('splitDescriptionToPhrases handles empty/undefined', () => {
    expect(splitDescriptionToPhrases(undefined)).toEqual([])
    expect(splitDescriptionToPhrases('')).toEqual([])
  })

  it('splitDescriptionToPhrases splits on sentence terminators', () => {
    const phrases = splitDescriptionToPhrases('First sentence. Second one! Third?')
    expect(phrases).toEqual(['First sentence', 'Second one', 'Third'])
  })
})

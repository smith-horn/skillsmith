/**
 * @fileoverview Unit tests for the rot detector (SMI-5536 Wave 2B — R0 rot
 *               detection).
 * @module @skillsmith/mcp-server/audit/rot-detector.test
 *
 * `detectRot` reads `entry.source_path` off disk, so fixtures write real
 * files to a tmp dir (cleaned up in `afterEach`) rather than mocking `fs`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectRot } from './rot-detector.js'
import type { InventoryEntry } from '../utils/local-inventory.types.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'skillsmith-rot-detector-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function entry(overrides: Partial<InventoryEntry> & { source_path: string }): InventoryEntry {
  return {
    kind: 'skill',
    identifier: 'noop',
    triggerSurface: ['noop'],
    ...overrides,
  }
}

describe('detectRot — dead-ref signal', () => {
  it('flags a skill whose content contains a dead placeholder link AS A LINK TARGET', async () => {
    const sourcePath = join(tmpDir, 'SKILL.md')
    writeFileSync(
      sourcePath,
      '---\nname: docs-fetcher\n---\nSee the [docs](https://example.com) for more.\n'
    )
    const inventory = [
      entry({ identifier: 'docs-fetcher', source_path: sourcePath, kind: 'skill' }),
    ]

    const findings = await detectRot(inventory)

    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('rot')
    expect(findings[0]?.signal).toBe('dead-ref')
    expect(findings[0]?.severity).toBe('warning')
    expect(findings[0]?.entry.source_path).toBe(sourcePath)
    expect(findings[0]?.rotId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('flags a skill whose content contains an explicit deprecation marker', async () => {
    const sourcePath = join(tmpDir, 'SKILL.md')
    writeFileSync(
      sourcePath,
      '---\nname: legacy-tool\n---\nThis skill is deprecated. Use new-tool instead.\n'
    )
    const inventory = [entry({ identifier: 'legacy-tool', source_path: sourcePath, kind: 'skill' })]

    const findings = await detectRot(inventory)

    expect(findings).toHaveLength(1)
    expect(findings[0]?.signal).toBe('dead-ref')
    expect(findings[0]?.severity).toBe('warning')
    expect(findings[0]?.reason).toMatch(/deprecation marker/)
  })

  it('flags a skill whose content contains a self-referential "no longer maintained" marker', async () => {
    // "no longer maintained" is too generic to treat as a bare substring
    // (see the migration-guide FP guard below) — it must only fire when
    // gated to a "this skill/command/agent" subject.
    const sourcePath = join(tmpDir, 'SKILL.md')
    writeFileSync(sourcePath, '---\nname: retired-tool\n---\nThis skill is no longer maintained.\n')
    const inventory = [
      entry({ identifier: 'retired-tool', source_path: sourcePath, kind: 'skill' }),
    ]

    const findings = await detectRot(inventory)

    expect(findings).toHaveLength(1)
    expect(findings[0]?.signal).toBe('dead-ref')
    expect(findings[0]?.severity).toBe('warning')
    expect(findings[0]?.reason).toMatch(/deprecation marker/)
  })

  it('produces exactly one dead-ref finding per entry, not one per matched pattern', async () => {
    const sourcePath = join(tmpDir, 'SKILL.md')
    // Contains BOTH a dead-link pattern (as a link target) AND a
    // deprecation marker — must still only produce one finding for this
    // entry (first-match wins).
    writeFileSync(
      sourcePath,
      '---\nname: double-trouble\n---\n[link](https://example.com) — this skill is deprecated.\n'
    )
    const inventory = [
      entry({ identifier: 'double-trouble', source_path: sourcePath, kind: 'skill' }),
    ]

    const findings = await detectRot(inventory)

    expect(findings).toHaveLength(1)
  })

  it('FP GUARD: prose mentions of example.com/localhost with no link target produce zero findings', async () => {
    const sourcePath = join(tmpDir, 'SKILL.md')
    writeFileSync(
      sourcePath,
      [
        '---',
        'name: local-dev-helper',
        '---',
        '',
        '# Local Dev Helper',
        '',
        'See example.com or run against http://localhost:3000 for local dev.',
        '',
        '```bash',
        'curl http://localhost:3000/health',
        '```',
        '',
      ].join('\n')
    )
    const inventory = [
      entry({ identifier: 'local-dev-helper', source_path: sourcePath, kind: 'skill' }),
    ]

    const findings = await detectRot(inventory)

    expect(findings).toEqual([])
  })

  it('FP GUARD: a migration guide discussing a third-party deprecation produces zero findings', async () => {
    // Neither "superseded by" nor "no longer supported" names THIS
    // skill/command/agent as the subject — a migration guide describing
    // someone else's deprecated API must not be flagged.
    const sourcePath = join(tmpDir, 'SKILL.md')
    writeFileSync(
      sourcePath,
      '---\nname: migration-guide\n---\nThe legacy API is superseded by the new one; the old flag is no longer supported.\n'
    )
    const inventory = [
      entry({ identifier: 'migration-guide', source_path: sourcePath, kind: 'skill' }),
    ]

    const findings = await detectRot(inventory)

    expect(findings).toEqual([])
  })

  it('FRESH-SKILL FP GUARD: a well-formed, current skill with no dead markers produces zero findings', async () => {
    const sourcePath = join(tmpDir, 'SKILL.md')
    writeFileSync(
      sourcePath,
      [
        '---',
        'name: healthy-skill',
        'description: A perfectly normal, actively maintained skill.',
        '---',
        '',
        '# Healthy Skill',
        '',
        'See https://skillsmith.app/docs for the real documentation.',
        '',
        '## Usage',
        '',
        'Run the tool as documented. Nothing here is deprecated or dead.',
      ].join('\n')
    )
    const inventory = [
      entry({ identifier: 'healthy-skill', source_path: sourcePath, kind: 'skill' }),
    ]

    const findings = await detectRot(inventory)

    expect(findings).toEqual([])
  })

  it('skips claude_md_rule entries entirely — never reads or flags them', async () => {
    const sourcePath = join(tmpDir, 'CLAUDE.md')
    writeFileSync(sourcePath, 'Some rule text mentioning https://example.com.\n')
    const inventory = [
      entry({
        identifier: 'rule-hash-abc123',
        source_path: sourcePath,
        kind: 'claude_md_rule',
        triggerSurface: ['some rule text'],
      }),
    ]

    const findings = await detectRot(inventory)

    expect(findings).toEqual([])
  })

  it('fails toward no finding (never throws) when source_path is unreadable', async () => {
    const missingPath = join(tmpDir, 'does-not-exist.md')
    const inventory = [entry({ identifier: 'ghost', source_path: missingPath, kind: 'skill' })]

    await expect(detectRot(inventory)).resolves.toEqual([])
  })

  it('folds the provided auditId into the derived rotId', async () => {
    const sourcePath = join(tmpDir, 'SKILL.md')
    writeFileSync(sourcePath, '[link](https://example.com)\n')
    const inventory = [entry({ identifier: 'x', source_path: sourcePath, kind: 'skill' })]

    const withAuditId = await detectRot(inventory, { auditId: 'audit-123' })
    const withoutAuditId = await detectRot(inventory)

    expect(withAuditId[0]?.rotId).not.toBe(withoutAuditId[0]?.rotId)
  })

  it('returns findings sorted by source_path regardless of inventory scan order (determinism)', async () => {
    // Regression guard (SMI-5536 Wave 2B determinism fix): a mere file
    // `touch` (mtime change, no content change) or a differently-ordered
    // inventory scan must never reorder the rot section of the report.
    const pathA = join(tmpDir, 'a-skill.md')
    const pathZ = join(tmpDir, 'z-skill.md')
    writeFileSync(pathA, '[link](https://example.com)\n')
    writeFileSync(pathZ, '[link](https://example.com)\n')
    const entryA = entry({ identifier: 'a', source_path: pathA, kind: 'skill' })
    const entryZ = entry({ identifier: 'z', source_path: pathZ, kind: 'skill' })

    const findingsForward = await detectRot([entryA, entryZ])
    const findingsReversed = await detectRot([entryZ, entryA])

    const expectedOrder = [pathA, pathZ]
    expect(findingsForward.map((f) => f.entry.source_path)).toEqual(expectedOrder)
    expect(findingsReversed.map((f) => f.entry.source_path)).toEqual(expectedOrder)
  })
})

/**
 * @fileoverview Unit tests for `dedupeAgentPackCollisions` (SMI-5456 Wave 1
 *               Step 5, plan §6 — dual-path pack dedup + self-exemption).
 * @module @skillsmith/mcp-server/tests/unit/run-inventory-audit.dedup
 *
 * Scoped to `dedupeAgentPackCollisions` directly (not the full
 * `runInventoryAudit` pipeline) because that pipeline writes to the real
 * `~/.skillsmith/audits/` with no test-isolation override today — see the
 * function's own JSDoc in `run-inventory-audit.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dedupeAgentPackCollisions } from '../../src/audit/run-inventory-audit.js'
import type { InventoryAuditResult } from '../../src/audit/collision-detector.types.js'
import type { ExactCollisionFlag, InventoryEntry } from '../../src/utils/local-inventory.types.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'skillsmith-audit-dedup-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function skillEntry(identifier: string, sourcePath: string): InventoryEntry {
  return { kind: 'skill', source_path: sourcePath, identifier, triggerSurface: [identifier] }
}

function baseResult(exactCollisions: ExactCollisionFlag[]): InventoryAuditResult {
  return {
    auditId: 'test-audit' as InventoryAuditResult['auditId'],
    inventory: [],
    exactCollisions,
    genericFlags: [],
    semanticCollisions: [],
    summary: {
      totalEntries: 0,
      totalFlags: exactCollisions.length,
      errorCount: exactCollisions.length,
      warningCount: 0,
      durationMs: 0,
      passDurations: { exact: 0, generic: 0, semantic: 0 },
    },
  }
}

function flag(entries: InventoryEntry[]): ExactCollisionFlag {
  return {
    kind: 'exact',
    collisionId: 'test-collision' as ExactCollisionFlag['collisionId'],
    identifier: entries[0]?.identifier ?? '',
    entries,
    severity: 'error',
    reason: 'exact identifier collision',
  }
}

describe('dedupeAgentPackCollisions', () => {
  it('drops a collision between byte-identical dual-path skillsmith-agent copies', () => {
    const claudePath = join(tmpDir, 'claude-SKILL.md')
    const agentsPath = join(tmpDir, 'agents-SKILL.md')
    const content = '---\nname: skillsmith-agent\n---\nSame content.\n'
    writeFileSync(claudePath, content)
    writeFileSync(agentsPath, content)

    const result = baseResult([
      flag([
        skillEntry('skillsmith-agent', claudePath),
        skillEntry('skillsmith-agent', agentsPath),
      ]),
    ])

    const deduped = dedupeAgentPackCollisions(result)

    expect(deduped.exactCollisions).toHaveLength(0)
    expect(deduped.summary.errorCount).toBe(0)
    expect(deduped.summary.totalFlags).toBe(0)
  })

  it('KEEPS the collision when content differs (namespace-squatting guard — name alone is not enough)', () => {
    const claudePath = join(tmpDir, 'claude-SKILL.md')
    const agentsPath = join(tmpDir, 'agents-SKILL.md')
    writeFileSync(claudePath, '---\nname: skillsmith-agent\n---\nReal pack.\n')
    writeFileSync(agentsPath, '---\nname: skillsmith-agent\n---\nImpostor content!\n')

    const result = baseResult([
      flag([
        skillEntry('skillsmith-agent', claudePath),
        skillEntry('skillsmith-agent', agentsPath),
      ]),
    ])

    const deduped = dedupeAgentPackCollisions(result)

    expect(deduped.exactCollisions).toHaveLength(1)
    expect(deduped.summary.errorCount).toBe(1)
  })

  it('does NOT self-exempt a collision between two DIFFERENTLY-named skills, even if content matches', () => {
    const pathA = join(tmpDir, 'a-SKILL.md')
    const pathB = join(tmpDir, 'b-SKILL.md')
    const content = '---\nname: some-other-skill\n---\nBody.\n'
    writeFileSync(pathA, content)
    writeFileSync(pathB, content)

    const result = baseResult([
      flag([skillEntry('some-other-skill', pathA), skillEntry('some-other-skill', pathB)]),
    ])

    const deduped = dedupeAgentPackCollisions(result)

    // Not the agent pack (wrong identifier) — general content-identical
    // duplicates are NOT dedup'd by this function; only the specific
    // skillsmith-agent dual-path scenario is in scope (Do not change other
    // audit behavior).
    expect(deduped.exactCollisions).toHaveLength(1)
  })

  it('KEEPS the collision when an entry is not kind: skill (e.g. a command sharing the identifier)', () => {
    const claudePath = join(tmpDir, 'claude-SKILL.md')
    const content = '---\nname: skillsmith-agent\n---\nBody.\n'
    writeFileSync(claudePath, content)

    const commandEntry: InventoryEntry = {
      kind: 'command',
      source_path: join(tmpDir, 'skillsmith-agent.md'),
      identifier: 'skillsmith-agent',
      triggerSurface: ['skillsmith-agent'],
    }
    const result = baseResult([flag([skillEntry('skillsmith-agent', claudePath), commandEntry])])

    const deduped = dedupeAgentPackCollisions(result)

    expect(deduped.exactCollisions).toHaveLength(1)
  })

  it('KEEPS the collision (fails toward showing it) when a source file is unreadable', () => {
    const claudePath = join(tmpDir, 'claude-SKILL.md')
    const missingPath = join(tmpDir, 'does-not-exist-SKILL.md')
    writeFileSync(claudePath, '---\nname: skillsmith-agent\n---\nBody.\n')

    const result = baseResult([
      flag([
        skillEntry('skillsmith-agent', claudePath),
        skillEntry('skillsmith-agent', missingPath),
      ]),
    ])

    const deduped = dedupeAgentPackCollisions(result)

    expect(deduped.exactCollisions).toHaveLength(1)
  })

  it('leaves genericFlags/semanticCollisions and non-agent-pack exact collisions untouched', () => {
    const pathA = join(tmpDir, 'a-SKILL.md')
    const pathB = join(tmpDir, 'b-SKILL.md')
    writeFileSync(pathA, 'a')
    writeFileSync(pathB, 'b')
    const otherFlag = flag([skillEntry('foo', pathA), skillEntry('foo', pathB)])
    const result = baseResult([otherFlag])

    const deduped = dedupeAgentPackCollisions(result)

    expect(deduped.exactCollisions).toEqual([otherFlag])
    expect(deduped.genericFlags).toEqual(result.genericFlags)
    expect(deduped.semanticCollisions).toEqual(result.semanticCollisions)
  })

  it('is a no-op (returns the same object reference) when nothing is deduped', () => {
    const pathA = join(tmpDir, 'a-SKILL.md')
    writeFileSync(pathA, 'a')
    const result = baseResult([flag([skillEntry('foo', pathA), skillEntry('foo', pathA)])])

    expect(dedupeAgentPackCollisions(result)).toBe(result)
  })

  it('handles an empty exactCollisions array', () => {
    const result = baseResult([])
    expect(dedupeAgentPackCollisions(result)).toBe(result)
  })
})

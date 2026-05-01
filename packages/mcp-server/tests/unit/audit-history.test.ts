/**
 * Unit tests for SMI-4587 Wave 1 Step 3 — audit history persistence.
 * Covers ULID format, atomic write, round-trip, mkdir-on-first-run
 * (E-MISS-2), and the `claude_md_rule` collisionId special case (E-CONF-1).
 *
 * The CLAUDE.md scan caveat report-section test (D-ANTI-1) and the
 * `audit_mode: 'off'` skip-write test (P-ANTI-1) live in subsequent PRs
 * since they depend on the report-writer / audit-mode resolver.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  deriveCollisionId,
  hasClaudeMdEntries,
  newAuditId,
  readAuditHistory,
  writeAuditHistory,
} from '../../src/audit/audit-history.js'
import type {
  ExactCollisionFlag,
  InventoryAuditResult,
} from '../../src/audit/collision-detector.types.js'
import type { InventoryEntry } from '../../src/utils/local-inventory.types.js'

let TEST_HOME: string

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-audit-'))
})

afterEach(() => {
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
})

function makeEntry(overrides: Partial<InventoryEntry> = {}): InventoryEntry {
  return {
    kind: 'skill',
    source_path: '/tmp/SKILL.md',
    identifier: 'foo',
    triggerSurface: ['foo'],
    ...overrides,
  }
}

function makeResult(overrides: Partial<InventoryAuditResult> = {}): InventoryAuditResult {
  const auditId = newAuditId()
  return {
    auditId,
    inventory: [],
    exactCollisions: [],
    genericFlags: [],
    semanticCollisions: [],
    summary: {
      totalEntries: 0,
      totalFlags: 0,
      errorCount: 0,
      warningCount: 0,
      durationMs: 1.2,
      passDurations: { exact: 0.3, generic: 0, semantic: 0 },
    },
    ...overrides,
  }
}

describe('newAuditId', () => {
  it('returns a ULID-shaped string', () => {
    const id = newAuditId()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('returns distinct ids on each call', () => {
    const a = newAuditId()
    const b = newAuditId()
    expect(a).not.toBe(b)
  })
})

describe('writeAuditHistory + readAuditHistory', () => {
  it('writes result.json under a per-audit directory', async () => {
    const result = makeResult()
    const auditsDir = path.join(TEST_HOME, '.skillsmith', 'audits')
    const written = await writeAuditHistory(result, { auditsDir })
    expect(written.auditId).toBe(result.auditId)
    expect(written.resultPath).toBe(path.join(auditsDir, result.auditId, 'result.json'))
    expect(fs.existsSync(written.resultPath)).toBe(true)
  })

  it('round-trips an InventoryAuditResult via readAuditHistory', async () => {
    const result = makeResult({
      summary: {
        totalEntries: 3,
        totalFlags: 1,
        errorCount: 1,
        warningCount: 0,
        durationMs: 4.2,
        passDurations: { exact: 0.5, generic: 0, semantic: 0 },
      },
    })
    const auditsDir = path.join(TEST_HOME, '.skillsmith', 'audits')
    await writeAuditHistory(result, { auditsDir })
    const restored = await readAuditHistory(result.auditId, { auditsDir })
    expect(restored).not.toBeNull()
    expect(restored?.auditId).toBe(result.auditId)
    expect(restored?.summary.totalEntries).toBe(3)
  })

  it('readAuditHistory returns null for unknown auditId', async () => {
    const auditsDir = path.join(TEST_HOME, '.skillsmith', 'audits')
    const restored = await readAuditHistory('01H0NONEXISTENTNONEXISTENTAB', { auditsDir })
    expect(restored).toBeNull()
  })

  it('atomic write — no .tmp file remains after success', async () => {
    const result = makeResult()
    const auditsDir = path.join(TEST_HOME, '.skillsmith', 'audits')
    const written = await writeAuditHistory(result, { auditsDir })
    expect(fs.existsSync(`${written.resultPath}.tmp`)).toBe(false)
  })

  it('creates the audits directory on first run (E-MISS-2)', async () => {
    const auditsDir = path.join(TEST_HOME, 'never-existed', '.skillsmith', 'audits')
    expect(fs.existsSync(auditsDir)).toBe(false)
    const result = makeResult()
    const written = await writeAuditHistory(result, { auditsDir })
    expect(fs.existsSync(auditsDir)).toBe(true)
    expect(fs.existsSync(written.resultPath)).toBe(true)
  })

  it('reportPath is sibling of resultPath under the per-audit directory', async () => {
    const result = makeResult()
    const auditsDir = path.join(TEST_HOME, '.skillsmith', 'audits')
    const written = await writeAuditHistory(result, { auditsDir })
    expect(path.dirname(written.reportPath)).toBe(path.dirname(written.resultPath))
    expect(path.basename(written.reportPath)).toBe('report.md')
  })
})

describe('deriveCollisionId', () => {
  it('produces a 16-hex-char identifier', () => {
    const auditId = newAuditId()
    const entries = [
      makeEntry({ source_path: '/a/SKILL.md' }),
      makeEntry({ source_path: '/b/SKILL.md' }),
    ]
    const id = deriveCollisionId(auditId, entries)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is stable for the same input regardless of entry order', () => {
    const auditId = newAuditId()
    const a = makeEntry({ source_path: '/a/SKILL.md' })
    const b = makeEntry({ source_path: '/b/SKILL.md' })
    const id1 = deriveCollisionId(auditId, [a, b])
    const id2 = deriveCollisionId(auditId, [b, a])
    expect(id1).toBe(id2)
  })

  it('differs across different audit ids', () => {
    const e = [makeEntry({ source_path: '/a/SKILL.md' })]
    const id1 = deriveCollisionId(newAuditId(), e)
    const id2 = deriveCollisionId(newAuditId(), e)
    expect(id1).not.toBe(id2)
  })

  it('claude_md_rule special case: same source path + different identifiers produce distinct ids (E-CONF-1)', () => {
    const auditId = newAuditId()
    const sharedPath = '/home/user/.claude/CLAUDE.md'
    const claudeA = makeEntry({
      kind: 'claude_md_rule',
      source_path: sharedPath,
      identifier: 'claude_md:aaaaaaaaaaaa',
    })
    const claudeB = makeEntry({
      kind: 'claude_md_rule',
      source_path: sharedPath,
      identifier: 'claude_md:bbbbbbbbbbbb',
    })
    const skill = makeEntry({ source_path: '/skills/foo/SKILL.md' })

    const id1 = deriveCollisionId(auditId, [claudeA, skill])
    const id2 = deriveCollisionId(auditId, [claudeB, skill])
    expect(id1).not.toBe(id2)
  })

  it('without claude_md_rule entries: collisionId derivation ignores identifier suffix', () => {
    const auditId = newAuditId()
    const a = makeEntry({ source_path: '/a/SKILL.md', identifier: 'A' })
    const aRenamed = makeEntry({ source_path: '/a/SKILL.md', identifier: 'A-renamed' })
    const b = makeEntry({ source_path: '/b/SKILL.md', identifier: 'B' })
    const id1 = deriveCollisionId(auditId, [a, b])
    const id2 = deriveCollisionId(auditId, [aRenamed, b])
    expect(id1).toBe(id2)
  })
})

describe('hasClaudeMdEntries', () => {
  it('returns true when any entry is claude_md_rule', () => {
    const flag = {
      entries: [makeEntry({ kind: 'claude_md_rule' }), makeEntry({ kind: 'skill' })],
    } satisfies Pick<ExactCollisionFlag, 'entries'>
    expect(hasClaudeMdEntries(flag)).toBe(true)
  })

  it('returns false when no entry is claude_md_rule', () => {
    const flag = {
      entries: [makeEntry({ kind: 'skill' }), makeEntry({ kind: 'agent' })],
    }
    expect(hasClaudeMdEntries(flag)).toBe(false)
  })
})

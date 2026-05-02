/**
 * @fileoverview Shared test fixtures for SMI-4589 Wave 3 edit-suggester /
 *               edit-applier unit tests.
 * @module @skillsmith/mcp-server/tests/unit/edit-suggester.fixtures
 *
 * Extracted from `edit-suggester.test.ts` per the 500-LOC pre-commit
 * file-length gate. The `.fixtures.ts` suffix keeps the file outside
 * vitest's `**\/*.test.ts` glob — no tests run from this module.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  AuditId,
  CollisionId,
  InventoryAuditResult,
  SemanticCollisionFlag,
} from '../../src/audit/collision-detector.types.js'
import type { InventoryEntry } from '../../src/utils/local-inventory.types.js'

export const cid = (s: string): CollisionId => s as CollisionId
export const aid = (s: string): AuditId => s as AuditId

/**
 * Write a stub SKILL.md to `<TEST_HOME>/.claude/skills/<identifier>/SKILL.md`.
 * Returns the absolute file path. Caller is responsible for setting
 * `process.env.HOME = TEST_HOME` before invoking — the helper does NOT
 * resolve `getCanonicalInstallPath` itself.
 */
export function writeSkillMd(
  testHome: string,
  args: { identifier: string; description: string; tag?: string }
): string {
  const dir = path.join(testHome, '.claude', 'skills', args.identifier)
  fs.mkdirSync(dir, { recursive: true })
  const tagLine = args.tag ? `tags:\n  - ${args.tag}\n` : ''
  const content = [
    '---',
    `name: ${args.identifier}`,
    `description: ${args.description}`,
    tagLine.trimEnd(),
    '---',
    '',
    `# ${args.identifier}`,
    '',
  ]
    .filter((l) => l.length > 0 || l === '')
    .join('\n')
  const filePath = path.join(dir, 'SKILL.md')
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

export function makeEntry(args: {
  source_path: string
  identifier: string
  description: string
  tag?: string
}): InventoryEntry {
  return {
    kind: 'skill',
    source_path: args.source_path,
    identifier: args.identifier,
    triggerSurface: [args.identifier],
    meta: {
      description: args.description,
      tags: args.tag ? [args.tag] : [],
    },
  }
}

export function makeSemanticFlag(args: {
  collisionId: string
  entryA: InventoryEntry
  entryB: InventoryEntry
  cosineScore?: number
}): SemanticCollisionFlag {
  return {
    kind: 'semantic',
    collisionId: cid(args.collisionId),
    entryA: args.entryA,
    entryB: args.entryB,
    cosineScore: args.cosineScore ?? 0.82,
    overlappingPhrases: [
      { phrase1: 'Use when deploying', phrase2: 'Use when deploying', similarity: 0.9 },
    ],
    severity: 'warning',
    reason: `semantic overlap (cosine ${(args.cosineScore ?? 0.82).toFixed(2)})`,
  }
}

export function makeAuditResult(flags: SemanticCollisionFlag[]): InventoryAuditResult {
  const inventory = flags.flatMap((f) => [f.entryA, f.entryB])
  return {
    auditId: aid('aud_test_01'),
    inventory,
    exactCollisions: [],
    genericFlags: [],
    semanticCollisions: flags,
    summary: {
      totalEntries: inventory.length,
      totalFlags: flags.length,
      errorCount: 0,
      warningCount: flags.length,
      durationMs: 1,
      passDurations: { exact: 0, generic: 0, semantic: 1 },
    },
  }
}

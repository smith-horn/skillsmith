/**
 * Unit tests for SMI-5671 Change 0 — revert ledger lookup disambiguation.
 *
 * Split out of `rename-engine.test.ts` (<500-line file-length gate). Covers
 * the `(auditId, collisionId)` lookup added to `revertRename()`:
 *   1. Two ledger entries share one `auditId` with distinct `collisionId`s —
 *      revert by `(auditId, collisionId)` reverts only the intended entry.
 *   2. A legacy entry with no `collisionId`, sole match for its `auditId` —
 *      revert still succeeds via the back-compat fallback.
 *   3. Two legacy entries (no `collisionId`) share one `auditId` — revert
 *      refuses with `namespace.rename.revert_ambiguous` rather than guess.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { applyRename } from '../../src/audit/rename-engine.js'
import { readLedger, writeLedger } from '../../src/audit/namespace-overrides.js'
import type { CollisionId, InventoryEntry } from '../../src/audit/collision-detector.types.js'
import type { RenameSuggestion } from '../../src/audit/rename-engine.types.js'

let TEST_HOME: string
let ORIGINAL_HOME: string | undefined

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-rename-engine-revert-'))
  ORIGINAL_HOME = process.env['HOME']
  process.env['HOME'] = TEST_HOME
})

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) {
    process.env['HOME'] = ORIGINAL_HOME
  } else {
    delete process.env['HOME']
  }
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
})

const cid = (s: string): CollisionId => s as CollisionId

function makeSuggestion(args: {
  source_path: string
  identifier: string
  applyAction: RenameSuggestion['applyAction']
  suggested: string
  author?: string
  collisionId?: string
}): RenameSuggestion {
  const entry: InventoryEntry = {
    kind: args.applyAction === 'rename_skill_dir_and_frontmatter' ? 'skill' : 'command',
    source_path: args.source_path,
    identifier: args.identifier,
    triggerSurface: [args.identifier],
    meta: args.author ? { author: args.author } : undefined,
  }
  return {
    collisionId: cid(args.collisionId ?? 'test-collision-01'),
    entry,
    currentName: args.identifier,
    suggested: args.suggested,
    applyAction: args.applyAction,
    reason: `collision test for ${args.identifier}`,
  }
}

describe('applyRename — revert disambiguation (SMI-5671 Change 0)', () => {
  it('reverts only the entry matching (auditId, collisionId) when 2 share one auditId', async () => {
    const cmdDir = path.join(TEST_HOME, '.claude', 'commands')
    await fsp.mkdir(cmdDir, { recursive: true })
    const shipSrc = path.join(cmdDir, 'ship.md')
    const deploySrc = path.join(cmdDir, 'deploy.md')
    await fsp.writeFile(shipSrc, '---\nname: ship\n---\n', 'utf-8')
    await fsp.writeFile(deploySrc, '---\nname: deploy\n---\n', 'utf-8')

    const shipSuggestion = makeSuggestion({
      source_path: shipSrc,
      identifier: 'ship',
      applyAction: 'rename_command_file',
      suggested: 'anthropic-ship',
      collisionId: 'collision-ship',
    })
    const deploySuggestion = makeSuggestion({
      source_path: deploySrc,
      identifier: 'deploy',
      applyAction: 'rename_command_file',
      suggested: 'anthropic-deploy',
      collisionId: 'collision-deploy',
    })

    // One audit run resolved two collisions → two ledger entries, one auditId.
    await applyRename({
      suggestion: shipSuggestion,
      request: { action: 'apply', auditId: 'audit_multi' },
    })
    await applyRename({
      suggestion: deploySuggestion,
      request: { action: 'apply', auditId: 'audit_multi' },
    })
    expect((await readLedger()).overrides).toHaveLength(2)

    // Revert ONLY the ship rename by its collisionId.
    const reverted = await applyRename({
      suggestion: shipSuggestion,
      request: { action: 'revert', auditId: 'audit_multi', collisionId: 'collision-ship' },
    })
    expect(reverted.success).toBe(true)
    expect(reverted.error).toBeUndefined()

    // ship is restored; deploy is untouched (still renamed).
    expect(fs.existsSync(shipSrc)).toBe(true)
    expect(fs.existsSync(path.join(cmdDir, 'anthropic-ship.md'))).toBe(false)
    expect(fs.existsSync(deploySrc)).toBe(false)
    expect(fs.existsSync(path.join(cmdDir, 'anthropic-deploy.md'))).toBe(true)

    // Only the deploy entry survives in the ledger.
    const ledger = await readLedger()
    expect(ledger.overrides).toHaveLength(1)
    expect(ledger.overrides[0]?.collisionId).toBe('collision-deploy')
  })

  it('falls back to a single legacy auditId-only entry that has no collisionId', async () => {
    const cmdDir = path.join(TEST_HOME, '.claude', 'commands')
    await fsp.mkdir(cmdDir, { recursive: true })
    const src = path.join(cmdDir, 'ship.md')
    await fsp.writeFile(src, '---\nname: ship\n---\n', 'utf-8')

    const suggestion = makeSuggestion({
      source_path: src,
      identifier: 'ship',
      applyAction: 'rename_command_file',
      suggested: 'anthropic-ship',
    })
    await applyRename({
      suggestion,
      request: { action: 'apply', auditId: 'audit_legacy' },
    })

    // Simulate a pre-SMI-5671 ledger entry: strip the collisionId field so the
    // sole entry for this auditId carries no collisionId at all.
    const ledger = await readLedger()
    for (const o of ledger.overrides) {
      delete o.collisionId
    }
    await writeLedger(ledger)

    // Revert by (auditId, collisionId): the collisionId matches nothing, but
    // it's the ONLY entry for the auditId → safe back-compat fallback.
    const reverted = await applyRename({
      suggestion,
      request: { action: 'revert', auditId: 'audit_legacy', collisionId: 'test-collision-01' },
    })
    expect(reverted.success).toBe(true)
    expect(reverted.error).toBeUndefined()
    expect(fs.existsSync(src)).toBe(true)
    expect(fs.existsSync(path.join(cmdDir, 'anthropic-ship.md'))).toBe(false)
    expect((await readLedger()).overrides).toHaveLength(0)
  })

  it('refuses with revert_ambiguous when 2+ legacy entries share an auditId', async () => {
    const cmdDir = path.join(TEST_HOME, '.claude', 'commands')
    await fsp.mkdir(cmdDir, { recursive: true })
    const shipSrc = path.join(cmdDir, 'ship.md')
    const deploySrc = path.join(cmdDir, 'deploy.md')
    await fsp.writeFile(shipSrc, '---\nname: ship\n---\n', 'utf-8')
    await fsp.writeFile(deploySrc, '---\nname: deploy\n---\n', 'utf-8')

    const shipSuggestion = makeSuggestion({
      source_path: shipSrc,
      identifier: 'ship',
      applyAction: 'rename_command_file',
      suggested: 'anthropic-ship',
      collisionId: 'collision-ship',
    })
    const deploySuggestion = makeSuggestion({
      source_path: deploySrc,
      identifier: 'deploy',
      applyAction: 'rename_command_file',
      suggested: 'anthropic-deploy',
      collisionId: 'collision-deploy',
    })
    await applyRename({
      suggestion: shipSuggestion,
      request: { action: 'apply', auditId: 'audit_ambiguous' },
    })
    await applyRename({
      suggestion: deploySuggestion,
      request: { action: 'apply', auditId: 'audit_ambiguous' },
    })

    // Strip collisionId from BOTH entries → two legacy entries, one auditId.
    const ledger = await readLedger()
    for (const o of ledger.overrides) {
      delete o.collisionId
    }
    await writeLedger(ledger)

    // Revert with a collisionId that matches neither → must refuse, not guess.
    const result = await applyRename({
      suggestion: shipSuggestion,
      request: { action: 'revert', auditId: 'audit_ambiguous', collisionId: 'collision-ship' },
    })
    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('namespace.rename.revert_ambiguous')
    if (result.error?.kind === 'namespace.rename.revert_ambiguous') {
      expect(result.error.candidateCount).toBe(2)
    }

    // Nothing was reverted — both renames remain, both ledger entries intact.
    expect(fs.existsSync(path.join(cmdDir, 'anthropic-ship.md'))).toBe(true)
    expect(fs.existsSync(path.join(cmdDir, 'anthropic-deploy.md'))).toBe(true)
    expect((await readLedger()).overrides).toHaveLength(2)
  })
})

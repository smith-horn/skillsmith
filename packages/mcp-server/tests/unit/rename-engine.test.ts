/**
 * Unit tests for SMI-4588 Wave 2 Steps 3+4 — frontmatter rewriter + apply paths.
 * PR #2 of the Wave 2 stack.
 *
 * Coverage:
 *   Frontmatter rewriter:
 *     1. Round-trip rewrites `name:` while preserving block-scalar `description`.
 *     2. Inline comments on the `name:` line are preserved.
 *     3. No frontmatter → `no_frontmatter` error.
 *     4. No `name:` field → `no_name_field` error.
 *
 *   Rename engine apply paths:
 *     5. `rename_command_file` — backup created, file renamed, ledger appended.
 *     6. `rename_agent_file` — same coverage.
 *     7. `rename_skill_dir_and_frontmatter` — directory renamed, frontmatter
 *        rewritten, ledger appended.
 *     8. Idempotent re-apply — second call returns success with
 *        `fromPath === toPath` and `backupPath === ''`.
 *     9. Disk-vs-ledger divergence → `namespace.ledger.disk_divergence` error.
 *    10. Rename target collides with existing file → `target_exists` error.
 *    11. Frontmatter helper does NOT write a backup (Edit 4 contract).
 *    12. Revert — restores original filename + removes ledger entry.
 *    13. Revert idempotency — second revert returns success no-op.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { applyRename, getBackupsDir } from '../../src/audit/rename-engine.js'
import { rewriteFrontmatterName } from '../../src/audit/rename-engine.helpers.js'
import { readLedger } from '../../src/audit/namespace-overrides.js'
import type { CollisionId, InventoryEntry } from '../../src/audit/collision-detector.types.js'
import type { RenameSuggestion } from '../../src/audit/rename-engine.types.js'

let TEST_HOME: string
let ORIGINAL_HOME: string | undefined

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-rename-engine-'))
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
}): RenameSuggestion {
  const entry: InventoryEntry = {
    kind: args.applyAction === 'rename_skill_dir_and_frontmatter' ? 'skill' : 'command',
    source_path: args.source_path,
    identifier: args.identifier,
    triggerSurface: [args.identifier],
    meta: args.author ? { author: args.author } : undefined,
  }
  return {
    collisionId: cid('test-collision-01'),
    entry,
    currentName: args.identifier,
    suggested: args.suggested,
    applyAction: args.applyAction,
    reason: `collision test for ${args.identifier}`,
  }
}

describe('rewriteFrontmatterName', () => {
  it('preserves block-scalar description across rewrite', () => {
    const input = [
      '---',
      'name: ship',
      'description: |',
      '  multiline',
      '  block',
      'tags:',
      '  - release',
      '---',
      '# body',
    ].join('\n')
    const result = rewriteFrontmatterName(input, 'anthropic-ship')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.content).toContain('name: anthropic-ship')
    expect(result.content).toContain('description: |')
    expect(result.content).toContain('  multiline')
    expect(result.content).toContain('# body')
  })

  it('preserves inline comment on name: line', () => {
    const input = '---\nname: ship  # original\n---\n'
    const result = rewriteFrontmatterName(input, 'anthropic-ship')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.content).toContain('# original')
    expect(result.content).toContain('name: anthropic-ship')
  })

  it('returns no_frontmatter when content has no `---` block', () => {
    const result = rewriteFrontmatterName('# body only\n', 'foo')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('no_frontmatter')
  })

  it('returns no_name_field when frontmatter has no name', () => {
    const result = rewriteFrontmatterName('---\ndescription: x\n---\n', 'foo')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('no_name_field')
  })

  it('preserves quoted value style', () => {
    const input = '---\nname: "ship"\n---\n'
    const result = rewriteFrontmatterName(input, 'anthropic-ship')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.content).toContain('name: "anthropic-ship"')
  })
})

describe('applyRename — rename_command_file', () => {
  it('backs up, renames, and appends ledger entry', async () => {
    const cmdDir = path.join(TEST_HOME, '.claude', 'commands')
    await fsp.mkdir(cmdDir, { recursive: true })
    const src = path.join(cmdDir, 'ship.md')
    await fsp.writeFile(src, '---\nname: ship\n---\n# ship command\n', 'utf-8')

    const suggestion = makeSuggestion({
      source_path: src,
      identifier: 'ship',
      applyAction: 'rename_command_file',
      suggested: 'anthropic-ship',
    })
    const result = await applyRename({
      suggestion,
      request: { action: 'apply', auditId: 'audit_01' },
    })

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.toPath).toBe(path.join(cmdDir, 'anthropic-ship.md'))
    expect(result.backupPath).toContain(getBackupsDir())
    expect(fs.existsSync(result.toPath)).toBe(true)
    expect(fs.existsSync(src)).toBe(false)
    expect(result.summary).toBe(
      'Renamed /ship → /anthropic-ship. To undo: sklx audit revert audit_01'
    )

    const ledger = await readLedger()
    expect(ledger.overrides).toHaveLength(1)
    expect(ledger.overrides[0]?.renamedTo).toBe('anthropic-ship')
    expect(ledger.overrides[0]?.kind).toBe('command')
  })

  it('returns target_exists when destination already occupied', async () => {
    const cmdDir = path.join(TEST_HOME, '.claude', 'commands')
    await fsp.mkdir(cmdDir, { recursive: true })
    const src = path.join(cmdDir, 'ship.md')
    const occupied = path.join(cmdDir, 'anthropic-ship.md')
    await fsp.writeFile(src, '---\nname: ship\n---\n', 'utf-8')
    await fsp.writeFile(occupied, '---\nname: anthropic-ship\n---\n', 'utf-8')

    const suggestion = makeSuggestion({
      source_path: src,
      identifier: 'ship',
      applyAction: 'rename_command_file',
      suggested: 'anthropic-ship',
    })
    const result = await applyRename({
      suggestion,
      request: { action: 'apply', auditId: 'audit_01' },
    })

    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('namespace.rename.target_exists')
  })
})

describe('applyRename — rename_agent_file', () => {
  it('backs up, renames, and appends ledger entry', async () => {
    const agentDir = path.join(TEST_HOME, '.claude', 'agents')
    await fsp.mkdir(agentDir, { recursive: true })
    const src = path.join(agentDir, 'reviewer.md')
    await fsp.writeFile(src, '---\nname: reviewer\n---\n', 'utf-8')

    const suggestion = makeSuggestion({
      source_path: src,
      identifier: 'reviewer',
      applyAction: 'rename_agent_file',
      suggested: 'anthropic-reviewer',
    })
    const result = await applyRename({
      suggestion,
      request: { action: 'apply', auditId: 'audit_02' },
    })
    expect(result.success).toBe(true)
    expect(result.toPath).toBe(path.join(agentDir, 'anthropic-reviewer.md'))
    const ledger = await readLedger()
    expect(ledger.overrides[0]?.kind).toBe('agent')
  })
})

describe('applyRename — rename_skill_dir_and_frontmatter', () => {
  it('renames directory and rewrites frontmatter name', async () => {
    const skillsRoot = path.join(TEST_HOME, '.claude', 'skills')
    const skillDir = path.join(skillsRoot, 'code-review')
    await fsp.mkdir(skillDir, { recursive: true })
    const skillMd = path.join(skillDir, 'SKILL.md')
    await fsp.writeFile(
      skillMd,
      '---\nname: code-review\ndescription: A skill\n---\n# body\n',
      'utf-8'
    )

    const suggestion = makeSuggestion({
      source_path: skillDir,
      identifier: 'code-review',
      applyAction: 'rename_skill_dir_and_frontmatter',
      suggested: 'anthropic-code-review',
    })
    const result = await applyRename({
      suggestion,
      request: { action: 'apply', auditId: 'audit_03' },
    })
    expect(result.success).toBe(true)
    const newDir = path.join(skillsRoot, 'anthropic-code-review')
    expect(fs.existsSync(newDir)).toBe(true)
    expect(fs.existsSync(skillDir)).toBe(false)
    const rewritten = await fsp.readFile(path.join(newDir, 'SKILL.md'), 'utf-8')
    expect(rewritten).toContain('name: anthropic-code-review')
    expect(rewritten).toContain('description: A skill')
    expect(rewritten).toContain('# body')
  })
})

describe('applyRename — idempotency', () => {
  it('second apply returns no-op success with fromPath === toPath', async () => {
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
    const first = await applyRename({
      suggestion,
      request: { action: 'apply', auditId: 'audit_04' },
    })
    expect(first.success).toBe(true)

    // Re-apply with the SAME suggestion. The on-disk source no longer
    // exists; the ledger has the entry. Engine should detect the
    // idempotent state and no-op.
    const second = await applyRename({
      suggestion,
      request: { action: 'apply', auditId: 'audit_04' },
    })
    expect(second.success).toBe(true)
    expect(second.fromPath).toBe(second.toPath)
    expect(second.backupPath).toBe('')
    const ledger = await readLedger()
    // Still only one entry — no duplicate appended.
    expect(ledger.overrides).toHaveLength(1)
  })

  it('returns disk_divergence when ledger has entry but on-disk file missing', async () => {
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
      request: { action: 'apply', auditId: 'audit_05' },
    })

    // User manually renamed it back. On-disk: `ship.md` exists; ledger
    // says it should be at `anthropic-ship.md`.
    const renamed = path.join(cmdDir, 'anthropic-ship.md')
    await fsp.rename(renamed, src)

    const second = await applyRename({
      suggestion,
      request: { action: 'apply', auditId: 'audit_05' },
    })
    expect(second.success).toBe(false)
    expect(second.error?.kind).toBe('namespace.ledger.disk_divergence')
  })
})

describe('applyRename — revert', () => {
  it('reverts a previously applied rename and removes ledger entry', async () => {
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
      request: { action: 'apply', auditId: 'audit_06' },
    })

    const reverted = await applyRename({
      suggestion,
      request: { action: 'revert', auditId: 'audit_06' },
    })
    expect(reverted.success).toBe(true)
    expect(fs.existsSync(src)).toBe(true)
    expect(fs.existsSync(path.join(cmdDir, 'anthropic-ship.md'))).toBe(false)
    const ledger = await readLedger()
    expect(ledger.overrides).toHaveLength(0)
  })

  it('revert is idempotent — second revert returns success no-op', async () => {
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
      request: { action: 'apply', auditId: 'audit_07' },
    })
    await applyRename({
      suggestion,
      request: { action: 'revert', auditId: 'audit_07' },
    })
    const second = await applyRename({
      suggestion,
      request: { action: 'revert', auditId: 'audit_07' },
    })
    expect(second.success).toBe(true)
    expect(second.fromPath).toBe(second.toPath)
  })

  it('reverts a skill rename and restores frontmatter name', async () => {
    const skillsRoot = path.join(TEST_HOME, '.claude', 'skills')
    const skillDir = path.join(skillsRoot, 'code-review')
    await fsp.mkdir(skillDir, { recursive: true })
    const skillMd = path.join(skillDir, 'SKILL.md')
    await fsp.writeFile(skillMd, '---\nname: code-review\n---\n', 'utf-8')

    const suggestion = makeSuggestion({
      source_path: skillDir,
      identifier: 'code-review',
      applyAction: 'rename_skill_dir_and_frontmatter',
      suggested: 'anthropic-code-review',
    })
    await applyRename({
      suggestion,
      request: { action: 'apply', auditId: 'audit_08' },
    })
    const reverted = await applyRename({
      suggestion,
      request: { action: 'revert', auditId: 'audit_08' },
    })
    expect(reverted.success).toBe(true)
    const restored = await fsp.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
    expect(restored).toContain('name: code-review')
    expect(restored).not.toContain('anthropic-code-review')
  })
})

describe('Edit 4 — helper does not write a backup', () => {
  it('rewriteFrontmatterName does not touch ~/.claude/skills/.backups', async () => {
    // Sanity: the helper is pure (string in, string out). No fs writes.
    const before = fs.existsSync(getBackupsDir())
    const result = rewriteFrontmatterName('---\nname: ship\n---\n', 'anthropic-ship')
    expect(result.ok).toBe(true)
    const after = fs.existsSync(getBackupsDir())
    expect(after).toBe(before)
  })
})

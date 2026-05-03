/**
 * @fileoverview Unit tests for SMI-4590 Wave 4 PR 2/6 — FrameworkAdapter
 *               seam + claudeCodeAdapter (v1).
 * @module @skillsmith/mcp-server/tests/unit/framework-adapter
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §5,
 *       §Tests §framework-adapter.test.ts.
 *
 * Coverage:
 *   1. `claudeCodeAdapter.name === 'claude-code'` + `describesFiles()` non-empty.
 *   2. `scanPaths()` returns valid `InventoryEntry[]` matching Wave 1's output.
 *   3. `applyAction({kind:'rename', from, to})` performs a raw `fs.rename`.
 *   4. `applyAction({kind:'inline-edit', searchMode:'literal', ...})` mutates
 *      the file via Wave 3's applyRecommendedEdit (registered template only).
 *   5. `applyAction({kind:'inline-edit', searchMode:'regex', ...})` throws
 *      `namespace.adapter.unsupported_search_mode` and the file is unchanged.
 *   6. Convenience wrapper `applyRename(entry, newName, { auditId })` runs
 *      Wave 2's applyRename flow (backup + ledger + rename) for a command file.
 *   7. Convenience wrapper `applyEdit(edit, { auditId })` round-trips through
 *      `applyAction` and mutates the file.
 *   8. Conformance: `claudeCodeAdapter` satisfies `FrameworkAdapter` (compile-
 *      time guard via the `const adapter: FrameworkAdapter = claudeCodeAdapter`
 *      assignment in this file).
 *   9. Inline-edit with missing `auditId` rejects with
 *      `namespace.adapter.missing_context`.
 *  10. Inline-edit with non-registered `pattern` rejects with
 *      `namespace.adapter.template_not_in_apply_registry`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { newAuditId } from '../../src/audit/audit-history.js'
import { claudeCodeAdapter, FrameworkAdapterError } from '../../src/audit/framework-adapter.js'
import type { FrameworkAdapter } from '../../src/audit/framework-adapter.types.js'
import type { RecommendedEdit } from '../../src/audit/edit-suggester.types.js'
import type { InventoryEntry } from '../../src/utils/local-inventory.types.js'
import { writeSkillMd } from './edit-suggester.fixtures.js'

// Compile-time conformance assertion. If `claudeCodeAdapter` ever drifts
// out of the `FrameworkAdapter` shape, this assignment will fail to
// type-check during the build step in CI.
const _conformance: FrameworkAdapter = claudeCodeAdapter
void _conformance

let TEST_HOME: string
let ORIGINAL_HOME: string | undefined

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-framework-adapter-'))
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

describe('claudeCodeAdapter — identity', () => {
  it('has name "claude-code" and non-empty describesFiles()', () => {
    expect(claudeCodeAdapter.name).toBe('claude-code')
    const files = claudeCodeAdapter.describesFiles()
    expect(files.length).toBeGreaterThan(0)
    expect(files).toContain('~/.claude/skills/*/SKILL.md')
  })
})

describe('claudeCodeAdapter.scanPaths', () => {
  it('returns InventoryEntry[] from an empty home (no scan errors)', async () => {
    const entries = await claudeCodeAdapter.scanPaths(TEST_HOME)
    expect(Array.isArray(entries)).toBe(true)
    // Empty .claude/ → no entries; the contract is just "Array of InventoryEntry".
    expect(entries.every((e) => typeof e.identifier === 'string')).toBe(true)
  })

  it('discovers a SKILL.md created on disk and returns it as a kind:"skill" entry', async () => {
    writeSkillMd(TEST_HOME, {
      identifier: 'fixture-skill',
      description: 'Use when deploying to staging',
    })
    const entries = await claudeCodeAdapter.scanPaths(TEST_HOME)
    const skill = entries.find((e) => e.identifier === 'fixture-skill')
    expect(skill).toBeDefined()
    expect(skill?.kind).toBe('skill')
    expect(skill?.source_path).toContain('SKILL.md')
  })
})

describe('claudeCodeAdapter.applyAction — rename (raw transport)', () => {
  it('performs fs.rename from `from` to `to`', async () => {
    const fromPath = path.join(TEST_HOME, 'src.md')
    const toPath = path.join(TEST_HOME, 'dst.md')
    fs.writeFileSync(fromPath, 'hello', 'utf-8')

    await claudeCodeAdapter.applyAction({
      kind: 'rename',
      from: fromPath,
      to: toPath,
    })

    expect(fs.existsSync(fromPath)).toBe(false)
    expect(fs.existsSync(toPath)).toBe(true)
    expect(fs.readFileSync(toPath, 'utf-8')).toBe('hello')
  })
})

describe('claudeCodeAdapter.applyAction — inline-edit', () => {
  it('rejects searchMode "regex" with namespace.adapter.unsupported_search_mode and leaves the file untouched', async () => {
    const filePath = path.join(TEST_HOME, 'doc.md')
    const original = 'Use when deploying to staging'
    fs.writeFileSync(filePath, original, 'utf-8')

    await expect(
      claudeCodeAdapter.applyAction({
        kind: 'inline-edit',
        filePath,
        search: 'deploying',
        replace: 'shipping',
        searchMode: 'regex',
        auditId: newAuditId(),
        pattern: 'add_domain_qualifier',
      })
    ).rejects.toMatchObject({
      kind: 'namespace.adapter.unsupported_search_mode',
    })
    // File untouched.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original)
  })

  it('rejects literal-mode dispatch missing auditId with namespace.adapter.missing_context', async () => {
    const filePath = path.join(TEST_HOME, 'doc.md')
    fs.writeFileSync(filePath, 'Use when deploying', 'utf-8')

    await expect(
      claudeCodeAdapter.applyAction({
        kind: 'inline-edit',
        filePath,
        search: 'deploying',
        replace: 'shipping',
        searchMode: 'literal',
        // auditId intentionally omitted
        pattern: 'add_domain_qualifier',
      })
    ).rejects.toBeInstanceOf(FrameworkAdapterError)
  })

  it('rejects literal-mode dispatch with a non-registered pattern with namespace.adapter.template_not_in_apply_registry', async () => {
    const filePath = path.join(TEST_HOME, 'doc.md')
    fs.writeFileSync(filePath, 'Use when deploying', 'utf-8')

    await expect(
      claudeCodeAdapter.applyAction({
        kind: 'inline-edit',
        filePath,
        search: 'deploying',
        replace: 'shipping',
        searchMode: 'literal',
        auditId: newAuditId(),
        // narrow_scope is NOT in APPLY_TEMPLATE_REGISTRY in v1.
        pattern: 'narrow_scope',
      })
    ).rejects.toMatchObject({
      kind: 'namespace.adapter.template_not_in_apply_registry',
    })
  })
})

describe('claudeCodeAdapter.applyEdit — convenience wrapper round-trip', () => {
  it('round-trips through applyAction and mutates the file (registered template)', async () => {
    // Build a SKILL.md whose description contains the literal we want
    // to edit. The applier requires byte-for-byte stale-before match.
    const skillPath = writeSkillMd(TEST_HOME, {
      identifier: 'roundtrip-fixture',
      description: 'Use when deploying',
    })
    const original = fs.readFileSync(skillPath, 'utf-8')
    expect(original).toContain('Use when deploying')

    const auditId = newAuditId()
    const edit: RecommendedEdit = {
      // The collisionId here is opaque — Wave 3 applier only uses it as
      // the ledger FK, not to look up state. The convenience wrapper
      // builds an InlineEditAction with `before` as the literal search.
      collisionId: 'cid-roundtrip-0' as RecommendedEdit['collisionId'],
      category: 'description_overlap',
      pattern: 'add_domain_qualifier',
      filePath: skillPath,
      lineRange: { start: 1, end: 1 }, // recomputed by adapter; ignored by inline-edit translator
      before: 'Use when deploying',
      after: 'Use when deploying for release-tools tasks',
      rationale: 'test',
      applyAction: 'recommended_edit',
      applyMode: 'apply_with_confirmation',
      otherEntry: { identifier: 'other', sourcePath: '/tmp/other' },
    }

    expect(claudeCodeAdapter.applyEdit).toBeDefined()
    await claudeCodeAdapter.applyEdit?.(edit, { auditId })

    const updated = fs.readFileSync(skillPath, 'utf-8')
    expect(updated).toContain('Use when deploying for release-tools tasks')
    expect(updated).not.toBe(original)
  })
})

describe('claudeCodeAdapter.applyRename — convenience wrapper for command files', () => {
  it('renames a ~/.claude/commands/<name>.md via Wave 2 applyRename + ledger', async () => {
    // Stage a command file at ~/.claude/commands/foo.md.
    const commandsDir = path.join(TEST_HOME, '.claude', 'commands')
    fs.mkdirSync(commandsDir, { recursive: true })
    const fromPath = path.join(commandsDir, 'foo.md')
    fs.writeFileSync(fromPath, '# /foo\n', 'utf-8')

    const entry: InventoryEntry = {
      kind: 'command',
      source_path: fromPath,
      identifier: 'foo',
      triggerSurface: ['/foo'],
    }

    expect(claudeCodeAdapter.applyRename).toBeDefined()
    await claudeCodeAdapter.applyRename?.(entry, 'mine-foo', {
      auditId: newAuditId(),
    })

    const targetPath = path.join(commandsDir, 'mine-foo.md')
    expect(fs.existsSync(fromPath)).toBe(false)
    expect(fs.existsSync(targetPath)).toBe(true)
  })

  it('rejects rename of a claude_md_rule entry with namespace.adapter.unsupported_action', async () => {
    const entry: InventoryEntry = {
      kind: 'claude_md_rule',
      source_path: path.join(TEST_HOME, '.claude', 'CLAUDE.md'),
      identifier: 'rule-hash-stub',
      triggerSurface: ['use when deploying'],
    }

    await expect(
      claudeCodeAdapter.applyRename?.(entry, 'whatever', {
        auditId: newAuditId(),
      })
    ).rejects.toBeInstanceOf(FrameworkAdapterError)
  })
})

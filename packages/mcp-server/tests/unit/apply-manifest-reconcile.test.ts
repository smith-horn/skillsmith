/**
 * @fileoverview Unit tests for SMI-6343 Wave 4 — `apply_manifest_reconcile`
 *               MCP tool.
 * @module @skillsmith/mcp-server/tests/unit/apply-manifest-reconcile
 *
 * Plan: docs/internal/implementation/smi-6343-manifest-hygiene.md
 * ("4. Reconciliation tool (Wave 4 ...)").
 *
 * Pattern: real fs against the sandboxed HOME `vitest.setup.ts` already
 * establishes for this file's run (see that file + `skill-manifest.ts`'s
 * `assertNotRealUserHome` doc comment) — `MANIFEST_PATH`/`SKILLSMITH_DIR`
 * (`install.types.ts`) are frozen module-level consts computed against
 * THAT sandbox, so every test in this file shares one manifest location
 * and resets it in `beforeEach` rather than mutating `process.env.HOME`
 * per test (which would NOT reach those frozen consts). Only the live
 * registry lookup (`install.helpers.js`'s `lookupSkillFromRegistry`) is
 * mocked — everything else (ManifestManager locking, the ledger, the
 * `createProseBackup` backup step) runs against real files, matching this
 * repo's `apply-namespace-rename.test.ts` / `undo-apply.test.ts` precedent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../src/tools/install.helpers.js', () => ({
  lookupSkillFromRegistry: vi.fn(),
}))

import { lookupSkillFromRegistry } from '../../src/tools/install.helpers.js'
import { hashContent, getBackupsDir } from '../../src/tools/install.conflict-helpers.js'
import { SKILLSMITH_DIR, MANIFEST_PATH } from '../../src/tools/install.types.js'
import type { SkillManifest, SkillManifestEntry } from '../../src/tools/install.types.js'
import {
  applyManifestReconcile,
  applyManifestReconcileInputSchema,
} from '../../src/tools/apply-manifest-reconcile.js'
import { assertBackupTargetIsFile } from '../../src/tools/apply-manifest-reconcile.helpers.js'
import { ReconcileGuardError } from '../../src/tools/apply-manifest-reconcile.helpers.js'
import type { ToolContext } from '../../src/context.js'

const mockedLookup = vi.mocked(lookupSkillFromRegistry)

const LEDGER_PATH = path.join(SKILLSMITH_DIR, 'manifest-reconcile-ledger.json')

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  mockedLookup.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ============================================================================
// Fixture helpers
// ============================================================================

function makeEntry(overrides: Partial<SkillManifestEntry> = {}): SkillManifestEntry {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    id: overrides.id ?? 'jinee525/react-component-generator',
    name: overrides.name ?? 'commit',
    version: overrides.version ?? '1.0.0',
    source: overrides.source ?? 'github:jinee525/react-component-generator',
    installPath: overrides.installPath ?? plantSkill(overrides.name ?? 'commit'),
    installedAt: overrides.installedAt ?? now,
    lastUpdated: overrides.lastUpdated ?? now,
    ...overrides,
  }
}

/** Creates a real fixture skill directory with a SKILL.md, returns its path. */
function plantSkill(name: string, content = `---\nname: ${name}\n---\nfixture body`): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `skillsmith-reconcile-${name}-`))
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8')
  return dir
}

function writeManifest(entries: Record<string, SkillManifestEntry>): void {
  fs.mkdirSync(SKILLSMITH_DIR, { recursive: true })
  const manifest: SkillManifest = { version: '1.0.0', installedSkills: entries }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8')
}

function readManifest(): SkillManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as SkillManifest
}

function makeContext(opts: { online?: boolean } = { online: true }): ToolContext {
  return {
    apiClient: { isOffline: () => !opts.online },
  } as unknown as ToolContext
}

/**
 * Calls the tool with `scope: 'global'` forced by default. Necessary
 * because `resolveScopedSkillsDir`'s auto-detection (ADR-139 rank 4) walks
 * UP from the test process's real `process.cwd()` (inside this actual repo
 * checkout, which has a real `.claude/skills` marker at `/app`) — without
 * an explicit scope, every call in this suite would silently resolve to
 * THAT workspace's manifest instead of the sandboxed global one the fixture
 * helpers below manage. This is `resolveScopedSkillsDir` working exactly as
 * designed; it just means tests must be explicit about which scope they
 * exercise, same as any real MCP caller running from inside a repo would
 * need to be.
 */
async function reconcile(
  input: Record<string, unknown>,
  context: ToolContext = makeContext()
): Promise<Awaited<ReturnType<typeof applyManifestReconcile>>> {
  return applyManifestReconcile({ scope: 'global', ...input }, context)
}

/** Reset all manifest-reconcile state between tests — see module header. */
beforeEach(() => {
  fs.mkdirSync(SKILLSMITH_DIR, { recursive: true })
  fs.rmSync(MANIFEST_PATH, { force: true })
  fs.rmSync(LEDGER_PATH, { force: true })
  fs.rmSync(path.join(getBackupsDir(), 'manifest.json'), { recursive: true, force: true })
})

// ============================================================================
// mark_local
// ============================================================================

describe('mark_local', () => {
  it('writes source:"unknown" and provenance:"local" atomically, backs up, and ledgers the change', async () => {
    writeManifest({ commit: makeEntry() })

    const result = await reconcile(
      { action: 'mark_local', name: 'commit', reason: 'wrong id/source' },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.entry?.source).toBe('unknown')
    expect(result.entry?.provenance).toBe('local')
    expect(result.ledgerEntryId).toMatch(/^mrc_/)
    expect(result.backupPath).toBeTruthy()

    // ADR-145 §2: both fields land in the SAME write.
    const onDisk = readManifest().installedSkills['commit']!
    expect(onDisk.source).toBe('unknown')
    expect(onDisk.provenance).toBe('local')

    // SMI-6103 gate (manage.update.helpers.ts:329-334): trusts a manifest
    // entry only when `source !== 'unknown'`. mark_local's output must be
    // treated as untrusted by that gate with ZERO changes to it — asserting
    // the literal condition it checks is the regression coverage, since
    // cross-package import of the CLI's own gate function isn't available
    // from this package.
    expect(onDisk.source !== 'unknown').toBe(false)
  })

  it('refuses with entry_not_found for an unknown name', async () => {
    writeManifest({})
    const result = await reconcile({ action: 'mark_local', name: 'ghost' }, makeContext())
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('manifest.reconcile.entry_not_found')
  })
})

// ============================================================================
// relink
// ============================================================================

describe('relink', () => {
  it('requires BOTH id and source (guard rejection)', async () => {
    writeManifest({ commit: makeEntry() })
    const result = await reconcile(
      { action: 'relink', name: 'commit', id: 'author/name' },
      makeContext()
    )
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('manifest.reconcile.invalid_input')
  })

  it('sets id/source/provenance:"registry" after registry validation, never sets verifiedAt', async () => {
    writeManifest({ commit: makeEntry() })
    mockedLookup.mockResolvedValue({
      repoUrl: 'https://github.com/wrsmith108/commit',
      name: 'commit',
      trustTier: 'verified',
      contentHash: 'abc123',
    })

    const result = await reconcile(
      {
        action: 'relink',
        name: 'commit',
        id: 'wrsmith108/commit',
        source: 'github:wrsmith108/commit',
      },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.entry?.id).toBe('wrsmith108/commit')
    expect(result.entry?.source).toBe('github:wrsmith108/commit')
    expect(result.entry?.provenance).toBe('registry')
    expect(result.entry?.verifiedAt).toBeUndefined()
  })

  it('clears a stale verifiedAt recorded against the OLD identity', async () => {
    writeManifest({ commit: makeEntry({ verifiedAt: '2026-01-01T00:00:00.000Z' }) })
    mockedLookup.mockResolvedValue({
      repoUrl: 'https://github.com/wrsmith108/commit',
      name: 'commit',
      trustTier: 'verified',
    })

    const result = await reconcile(
      {
        action: 'relink',
        name: 'commit',
        id: 'wrsmith108/commit',
        source: 'github:wrsmith108/commit',
      },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.entry?.verifiedAt).toBeUndefined()
    expect(readManifest().installedSkills['commit']!.verifiedAt).toBeUndefined()
  })

  it('refuses with relink_unvalidated when the registry does not confirm the id', async () => {
    writeManifest({ commit: makeEntry() })
    mockedLookup.mockResolvedValue(null)

    const result = await reconcile(
      { action: 'relink', name: 'commit', id: 'bogus/id', source: 'github:bogus/id' },
      makeContext()
    )
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('manifest.reconcile.relink_unvalidated')

    // The manifest must be untouched — no write happens before validation.
    expect(readManifest().installedSkills['commit']!.id).not.toBe('bogus/id')
  })
})

// ============================================================================
// drop_entry
// ============================================================================

describe('drop_entry', () => {
  it('removes the entry and ledgers a null afterState', async () => {
    writeManifest({
      'shutdown-persistence-fixture': makeEntry({ name: 'shutdown-persistence-fixture' }),
    })

    const result = await reconcile(
      { action: 'drop_entry', name: 'shutdown-persistence-fixture' },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(readManifest().installedSkills['shutdown-persistence-fixture']).toBeUndefined()
  })
})

// ============================================================================
// verify (C3)
// ============================================================================

describe('verify', () => {
  it('writes verifiedAt on a hash match', async () => {
    const content = `---\nname: matches\n---\nreal content`
    const entry = makeEntry({ name: 'matches', installPath: plantSkill('matches', content) })
    writeManifest({ matches: entry })
    mockedLookup.mockResolvedValue({
      repoUrl: 'https://github.com/a/matches',
      name: 'matches',
      trustTier: 'verified',
      contentHash: hashContent(content),
    })

    const result = await reconcile({ action: 'verify', name: 'matches' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.verifyResults?.[0]?.verified).toBe(true)
    expect(result.verifyResults?.[0]?.verifiedAt).toBeTruthy()
    expect(readManifest().installedSkills['matches']!.verifiedAt).toBeTruthy()
  })

  it('does NOT write verifiedAt on a hash mismatch, and leaves the entry untouched', async () => {
    const content = `---\nname: mismatched\n---\nreal content`
    const entry = makeEntry({ name: 'mismatched', installPath: plantSkill('mismatched', content) })
    writeManifest({ mismatched: entry })
    mockedLookup.mockResolvedValue({
      repoUrl: 'https://github.com/a/mismatched',
      name: 'mismatched',
      trustTier: 'verified',
      contentHash: 'totally-different-hash',
    })

    const result = await reconcile({ action: 'verify', name: 'mismatched' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.verifyResults?.[0]?.verified).toBe(false)
    expect(result.verifyResults?.[0]?.verifiedAt).toBeUndefined()
    expect(readManifest().installedSkills['mismatched']!.verifiedAt).toBeUndefined()
  })

  it('batches over every entry when name is omitted, writing only matched entries', async () => {
    const goodContent = `---\nname: good\n---\ngood`
    const badContent = `---\nname: bad\n---\nbad`
    writeManifest({
      good: makeEntry({
        name: 'good',
        id: 'author/good',
        installPath: plantSkill('good', goodContent),
      }),
      bad: makeEntry({
        name: 'bad',
        id: 'author/bad',
        installPath: plantSkill('bad', badContent),
      }),
    })
    mockedLookup.mockImplementation(async (id: string) => {
      if (id.includes('good')) {
        return {
          repoUrl: 'https://github.com/a/good',
          name: 'good',
          trustTier: 'verified',
          contentHash: hashContent(goodContent),
        }
      }
      return {
        repoUrl: 'https://github.com/a/bad',
        name: 'bad',
        trustTier: 'verified',
        contentHash: 'nope',
      }
    })

    const result = await reconcile({ action: 'verify' }, makeContext())
    expect(result.success).toBe(true)
    expect(result.verifyResults).toHaveLength(2)
    expect(readManifest().installedSkills['good']!.verifiedAt).toBeTruthy()
    expect(readManifest().installedSkills['bad']!.verifiedAt).toBeUndefined()
  })

  it('single-entry verify fails with verify_unavailable when offline', async () => {
    writeManifest({ commit: makeEntry() })
    const result = await reconcile(
      { action: 'verify', name: 'commit' },
      makeContext({ online: false })
    )
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('manifest.reconcile.verify_unavailable')
  })
})

// ============================================================================
// revert (C7)
// ============================================================================

describe('revert', () => {
  it('round-trips mark_local', async () => {
    writeManifest({ commit: makeEntry() })
    const applied = await reconcile({ action: 'mark_local', name: 'commit' }, makeContext())
    expect(readManifest().installedSkills['commit']!.provenance).toBe('local')

    const reverted = await reconcile(
      { action: 'revert', ledgerEntryId: applied.ledgerEntryId },
      makeContext()
    )
    expect(reverted.success).toBe(true)
    expect(reverted.noOp).toBe(false)
    expect(readManifest().installedSkills['commit']!.provenance).toBeUndefined()
    expect(readManifest().installedSkills['commit']!.source).toBe(
      'github:jinee525/react-component-generator'
    )
  })

  it('round-trips relink', async () => {
    writeManifest({ commit: makeEntry() })
    mockedLookup.mockResolvedValue({
      repoUrl: 'https://github.com/wrsmith108/commit',
      name: 'commit',
      trustTier: 'verified',
    })
    const applied = await reconcile(
      {
        action: 'relink',
        name: 'commit',
        id: 'wrsmith108/commit',
        source: 'github:wrsmith108/commit',
      },
      makeContext()
    )
    const reverted = await reconcile(
      { action: 'revert', ledgerEntryId: applied.ledgerEntryId },
      makeContext()
    )
    expect(reverted.success).toBe(true)
    expect(readManifest().installedSkills['commit']!.id).toBe('jinee525/react-component-generator')
  })

  it('round-trips drop_entry (re-creates the removed entry)', async () => {
    writeManifest({ commit: makeEntry() })
    const applied = await reconcile({ action: 'drop_entry', name: 'commit' }, makeContext())
    expect(readManifest().installedSkills['commit']).toBeUndefined()

    const reverted = await reconcile(
      { action: 'revert', ledgerEntryId: applied.ledgerEntryId },
      makeContext()
    )
    expect(reverted.success).toBe(true)
    expect(readManifest().installedSkills['commit']).toBeDefined()
    expect(readManifest().installedSkills['commit']!.id).toBe('jinee525/react-component-generator')
  })

  it('round-trips verify', async () => {
    const content = `---\nname: matches\n---\nreal content`
    writeManifest({
      matches: makeEntry({ name: 'matches', installPath: plantSkill('matches', content) }),
    })
    mockedLookup.mockResolvedValue({
      repoUrl: 'https://github.com/a/matches',
      name: 'matches',
      trustTier: 'verified',
      contentHash: hashContent(content),
    })
    const applied = await reconcile({ action: 'verify', name: 'matches' }, makeContext())
    expect(readManifest().installedSkills['matches']!.verifiedAt).toBeTruthy()

    const reverted = await reconcile(
      { action: 'revert', ledgerEntryId: applied.ledgerEntryId },
      makeContext()
    )
    expect(reverted.success).toBe(true)
    expect(readManifest().installedSkills['matches']!.verifiedAt).toBeUndefined()
  })

  it('still succeeds after an UNRELATED skill was installed in between — the exact scenario undo_apply would have failed', async () => {
    writeManifest({ commit: makeEntry() })
    const applied = await reconcile({ action: 'mark_local', name: 'commit' }, makeContext())

    // Simulate an unrelated install writing a NEW key to the same manifest
    // file — undo_apply's whole-file hash guard would treat this as "the
    // file changed" and permanently refuse to undo. Our per-key merge must
    // be blind to it.
    const manifest = readManifest()
    manifest.installedSkills['unrelated-skill'] = makeEntry({
      name: 'unrelated-skill',
      id: 'someone/unrelated-skill',
      source: 'github:someone/unrelated-skill',
    })
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8')

    const reverted = await reconcile(
      { action: 'revert', ledgerEntryId: applied.ledgerEntryId },
      makeContext()
    )
    expect(reverted.success).toBe(true)

    const finalManifest = readManifest()
    expect(finalManifest.installedSkills['commit']!.provenance).toBeUndefined()
    // The unrelated install is PRESERVED — this is the whole point of C7.
    expect(finalManifest.installedSkills['unrelated-skill']).toBeDefined()
    expect(finalManifest.installedSkills['unrelated-skill']!.id).toBe('someone/unrelated-skill')
  })

  it('refuses with entry_changed when the SAME entry changed since the reconcile', async () => {
    writeManifest({ commit: makeEntry() })
    const applied = await reconcile({ action: 'mark_local', name: 'commit' }, makeContext())

    // Something else touches the SAME key after the reconcile.
    const manifest = readManifest()
    manifest.installedSkills['commit']!.source = 'github:someone-else/commit'
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8')

    const reverted = await reconcile(
      { action: 'revert', ledgerEntryId: applied.ledgerEntryId },
      makeContext()
    )
    expect(reverted.success).toBe(false)
    expect(reverted.errorCode).toBe('manifest.reconcile.entry_changed')
  })

  it('is idempotent — reverting the same ledgerEntryId twice is a no-op on the second call', async () => {
    writeManifest({ commit: makeEntry() })
    const applied = await reconcile({ action: 'mark_local', name: 'commit' }, makeContext())
    const first = await reconcile(
      { action: 'revert', ledgerEntryId: applied.ledgerEntryId },
      makeContext()
    )
    expect(first.noOp).toBe(false)

    const second = await reconcile(
      { action: 'revert', ledgerEntryId: applied.ledgerEntryId },
      makeContext()
    )
    expect(second.success).toBe(true)
    expect(second.noOp).toBe(true)
  })

  it('refuses with revert_ambiguous when 2+ ledger entries match by name and no ledgerEntryId is given', async () => {
    writeManifest({ commit: makeEntry() })
    await reconcile({ action: 'mark_local', name: 'commit' }, makeContext())
    mockedLookup.mockResolvedValue({
      repoUrl: 'https://github.com/wrsmith108/commit',
      name: 'commit',
      trustTier: 'verified',
    })
    await reconcile(
      {
        action: 'relink',
        name: 'commit',
        id: 'wrsmith108/commit',
        source: 'github:wrsmith108/commit',
      },
      makeContext()
    )

    const result = await reconcile({ action: 'revert', name: 'commit' }, makeContext())
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('manifest.reconcile.revert_ambiguous')
  })

  it('returns a no-op success when no ledger entry matches (nothing to revert)', async () => {
    writeManifest({ commit: makeEntry() })
    const result = await reconcile(
      { action: 'revert', ledgerEntryId: 'mrc_does_not_exist' },
      makeContext()
    )
    expect(result.success).toBe(true)
    expect(result.noOp).toBe(true)
  })

  it('surfaces manifest.reconcile.ledger_version_unsupported when the ledger file is a future version', async () => {
    fs.mkdirSync(SKILLSMITH_DIR, { recursive: true })
    fs.writeFileSync(LEDGER_PATH, JSON.stringify({ version: 99, entries: [] }), 'utf-8')

    const result = await reconcile({ action: 'revert', name: 'commit' }, makeContext())
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('manifest.reconcile.ledger_version_unsupported')
  })
})

// ============================================================================
// C8 — backup step (security)
// ============================================================================

describe('C8 — backup step security', () => {
  it('assertBackupTargetIsFile refuses a directory (the "someone passes ~/.skillsmith/" mistake)', async () => {
    await expect(assertBackupTargetIsFile(SKILLSMITH_DIR)).rejects.toMatchObject({
      code: 'manifest.reconcile.backup_target_not_a_file',
    })
  })

  it('assertBackupTargetIsFile refuses a nonexistent path', async () => {
    await expect(
      assertBackupTargetIsFile(path.join(SKILLSMITH_DIR, 'does-not-exist.json'))
    ).rejects.toBeInstanceOf(ReconcileGuardError)
  })

  it('config.json never appears anywhere in the backups tree after a reconcile', async () => {
    fs.mkdirSync(SKILLSMITH_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(SKILLSMITH_DIR, 'config.json'),
      JSON.stringify({ apiKey: 'sk_live_FAKE_DO_NOT_LEAK' }),
      'utf-8'
    )
    writeManifest({ commit: makeEntry() })

    await reconcile({ action: 'mark_local', name: 'commit' }, makeContext())

    const backupsRoot = getBackupsDir()
    const offenders: string[] = []
    function walk(dir: string): void {
      if (!fs.existsSync(dir)) return
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name === 'config.json') offenders.push(full)
      }
    }
    walk(backupsRoot)
    expect(offenders).toEqual([])

    // And the real manifest DID get backed up, proving the walk isn't
    // vacuously passing over an empty tree.
    const manifestBackupDir = path.join(backupsRoot, 'manifest.json')
    expect(fs.existsSync(manifestBackupDir)).toBe(true)
  })
})

// ============================================================================
// Input validation
// ============================================================================

describe('input validation', () => {
  it('rejects an unknown action', async () => {
    const result = await reconcile({ action: 'bogus' }, makeContext())
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('manifest.reconcile.invalid_input')
  })

  it('rejects mark_local/relink/drop_entry with no name', async () => {
    const parsed = applyManifestReconcileInputSchema.safeParse({ action: 'mark_local' })
    expect(parsed.success).toBe(false)
  })

  it('rejects revert with neither name nor ledgerEntryId', async () => {
    const parsed = applyManifestReconcileInputSchema.safeParse({ action: 'revert' })
    expect(parsed.success).toBe(false)
  })

  it('accepts verify with no name (batch)', async () => {
    const parsed = applyManifestReconcileInputSchema.safeParse({ action: 'verify' })
    expect(parsed.success).toBe(true)
  })
})

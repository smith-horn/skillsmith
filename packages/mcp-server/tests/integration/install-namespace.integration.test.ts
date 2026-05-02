/**
 * SMI-4588 Wave 2 PR #4 — install namespace integration tests (Step 7).
 *
 * Exercises the namespace surface bracketing `service.install()` in the
 * install hot path: ledger replay → pre-flight scan → mode gate, plus the
 * agent's two-step `apply_namespace_rename` recovery flow. Tests run
 * against a real filesystem rooted under `tmpdir()` with `HOME` overridden.
 * `scanLocalInventory` captures `os.homedir()` at module load, so the
 * scanner is mocked to forward `TEST_HOME` per call. Wave 4's
 * `apply_namespace_rename` MCP tool is stubbed via direct `applyRename`
 * invocation (per task brief).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// `scanLocalInventory` captures `os.homedir()` at module load time
// (DEFAULT_HOME_CLAUDE_DIR / DEFAULT_MANIFEST_PATH constants), so a
// runtime HOME override does NOT redirect its file reads. Mock the
// scanner against the integration suite's tmp filesystem so the gate
// receives the planted inventory.
import * as localInventoryModule from '../../src/utils/local-inventory.js'

vi.mock('../../src/utils/local-inventory.js', async (importActual) => {
  const actual = await importActual<typeof localInventoryModule>()
  return {
    ...actual,
    scanLocalInventory: vi.fn(),
  }
})

import { runNamespaceGate } from '../../src/tools/install.namespace-gate.js'
import { applyRename } from '../../src/audit/rename-engine.js'
import { runBackupGC } from '../../src/tools/install.backup-gc.js'
import { renderAuditReport } from '../../src/audit/audit-report-writer.js'
import { newAuditId } from '../../src/audit/audit-history.js'
import { readLedger, writeLedger } from '../../src/audit/namespace-overrides.js'
import { scanLocalInventory } from '../../src/utils/local-inventory.js'
import { CURRENT_VERSION } from '../../src/audit/namespace-overrides.types.js'
import type {
  CollisionId,
  ExactCollisionFlag,
  InventoryAuditResult,
  InventoryEntry,
} from '../../src/audit/collision-detector.types.js'
import type { CandidateSkill } from '../../src/audit/install-preflight.js'
import type { RenameSuggestion } from '../../src/audit/rename-engine.types.js'

let TEST_HOME: string
let ORIGINAL_HOME: string | undefined
let CLAUDE_DIR: string
let SKILLS_DIR: string
let SKILLSMITH_DIR: string
let LEDGER_PATH: string
let BACKUPS_DIR: string

beforeEach(async () => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-install-namespace-'))
  ORIGINAL_HOME = process.env['HOME']
  process.env['HOME'] = TEST_HOME
  CLAUDE_DIR = path.join(TEST_HOME, '.claude')
  SKILLS_DIR = path.join(CLAUDE_DIR, 'skills')
  SKILLSMITH_DIR = path.join(TEST_HOME, '.skillsmith')
  LEDGER_PATH = path.join(SKILLSMITH_DIR, 'namespace-overrides.json')
  BACKUPS_DIR = path.join(SKILLS_DIR, '.backups')
  fs.mkdirSync(SKILLS_DIR, { recursive: true })
  fs.mkdirSync(SKILLSMITH_DIR, { recursive: true })
  // Stub fetch — collision-detector fires aggregate-only telemetry; tests
  // never make network calls.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  // Stub the semantic pass so `power_user` / `governance` modes do not
  // attempt to load ONNX models. The exact + generic passes still run
  // unaffected.
  const embeddings = await import('@skillsmith/core/embeddings')
  const core = await import('@skillsmith/core')
  vi.spyOn(embeddings.EmbeddingService.prototype, 'embed').mockImplementation(
    async () => new Float32Array(384)
  )
  vi.spyOn(core.OverlapDetector.prototype, 'findAllOverlaps').mockImplementation(async () => [])

  // Wire the scanner mock to scan the test HOME at call time. The real
  // `scanLocalInventory` accepts `homeDir` opts; we forward TEST_HOME so
  // each invocation reads the freshly-planted state.
  const realModule = await vi.importActual<typeof localInventoryModule>(
    '../../src/utils/local-inventory.js'
  )
  vi.mocked(scanLocalInventory).mockImplementation((opts) =>
    realModule.scanLocalInventory({ ...opts, homeDir: TEST_HOME })
  )
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Plant a SKILL.md inside `<SKILLS_DIR>/<name>/` so scanLocalInventory picks
 * it up. Matches the `name:` field in frontmatter to the directory name.
 */
function plantSkill(name: string, opts: { author?: string; description?: string } = {}): string {
  const dir = path.join(SKILLS_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  const lines = ['---', `name: ${name}`]
  if (opts.author) lines.push(`author: ${opts.author}`)
  if (opts.description) lines.push(`description: ${opts.description}`)
  lines.push('---', `# ${name}`, '', 'body content')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'), 'utf-8')
  return dir
}

/**
 * Plant a "shadowing" sibling skill — a directory at one location whose
 * frontmatter `name:` collides with another (`identifier`). Used to set
 * up exact-collision scenarios that survive `excludeSelfReinstall`
 * filtering (which keys on `(candidate.identifier, candidate.projectedSourcePath)`).
 */
function plantShadow(dirName: string, identifier: string, author: string): string {
  const dir = path.join(SKILLS_DIR, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${identifier}`, `author: ${author}`, '---', `# ${identifier}`, '', 'body'].join(
      '\n'
    ),
    'utf-8'
  )
  return dir
}

function candidate(name: string, overrides: Partial<CandidateSkill> = {}): CandidateSkill {
  return {
    identifier: name,
    projectedSourcePath: path.join(SKILLS_DIR, name),
    skillId: `anthropic/${name}`,
    author: 'anthropic',
    ...overrides,
  }
}

/** Build a skill `RenameSuggestion` for the rename-engine helper paths. */
function skillSuggestion(args: {
  source_path: string
  identifier: string
  suggested: string
  author: string
  collisionId?: string
}): RenameSuggestion {
  const entry: InventoryEntry = {
    kind: 'skill',
    source_path: args.source_path,
    identifier: args.identifier,
    triggerSurface: [args.identifier],
    meta: { author: args.author },
  }
  return {
    collisionId: (args.collisionId ?? `cid-${args.identifier}`) as CollisionId,
    entry,
    currentName: args.identifier,
    suggested: args.suggested,
    applyAction: 'rename_skill_dir_and_frontmatter',
    reason: 'integration test',
  }
}

describe('install namespace integration', () => {
  it('case 1: preventative + collision → blocks install; on-disk state unchanged', async () => {
    // Shadow at different dir avoids `excludeSelfReinstall` filtering.
    plantShadow('sibling-pack', 'code-helper', 'old-vendor')
    const c = candidate('code-helper')

    const outcome = await runNamespaceGate({
      candidate: c,
      mode: 'preventative',
      tier: 'community',
    })

    expect(outcome.decision).toBe('block')
    expect(outcome.resultPatch.installComplete).toBe(false)
    expect(outcome.resultPatch.pendingCollision).toBeDefined()
    expect(outcome.resultPatch.pendingCollision!.suggestionChain.length).toBeGreaterThan(0)
    expect(outcome.resultPatch.pendingCollision!.suggestedRename.suggested).toBe(
      'anthropic-code-helper'
    )
    // Skills dir state untouched — only the planted shadowing sibling exists.
    const after = fs.readdirSync(SKILLS_DIR).sort()
    expect(after).toEqual(['sibling-pack'])
  })

  it('case 2: two-step agent flow — block → applyRename (Wave 4 stub) → gate proceeds', async () => {
    plantShadow('sibling-pack', 'code-helper', 'sibling-vendor')
    const c = candidate('code-helper', { skillId: 'anthropic/code-helper' })

    // A: gate blocks.
    const blocked = await runNamespaceGate({
      candidate: c,
      mode: 'preventative',
      tier: 'community',
    })
    expect(blocked.decision).toBe('block')
    expect(blocked.resultPatch.pendingCollision!.suggestedRename.suggested).toBe(
      'anthropic-code-helper'
    )

    // B: rename the EXISTING shadowing sibling (frees the namespace).
    const applyResult = await applyRename({
      suggestion: skillSuggestion({
        source_path: path.join(SKILLS_DIR, 'sibling-pack'),
        identifier: 'code-helper',
        suggested: 'sibling-vendor-code-helper',
        author: 'sibling-vendor',
      }),
      request: { action: 'apply', auditId: newAuditId() },
    })
    expect(applyResult.success).toBe(true)
    expect(applyResult.toPath).toBe(path.join(SKILLS_DIR, 'sibling-vendor-code-helper'))

    // C: gate now proceeds.
    const reattempt = await runNamespaceGate({
      candidate: c,
      mode: 'preventative',
      tier: 'community',
    })
    expect(reattempt.decision).toBe('proceed')
    expect(reattempt.resultPatch.installComplete).toBe(true)
    expect(reattempt.resultPatch.pendingCollision).toBeUndefined()
  })

  it('case 3: power_user mode + collision → proceeds with warnings[]', async () => {
    plantShadow('sibling-pack', 'code-helper', 'sibling')
    const c = candidate('code-helper')
    const outcome = await runNamespaceGate({
      candidate: c,
      mode: 'power_user',
      tier: 'team',
    })
    expect(outcome.decision).toBe('proceed')
    expect(outcome.resultPatch.installComplete).toBe(true)
    expect(outcome.resultPatch.warnings).toBeDefined()
    expect(outcome.resultPatch.warnings!.length).toBeGreaterThan(0)
    expect(outcome.resultPatch.warnings![0]!.kind).toBe('exact')
  })

  it('case 4: governance mode + collision → proceeds with warnings[]', async () => {
    plantShadow('sibling-pack', 'code-helper', 'sibling')
    const c = candidate('code-helper')
    const outcome = await runNamespaceGate({
      candidate: c,
      mode: 'governance',
      tier: 'enterprise',
    })
    expect(outcome.decision).toBe('proceed')
    expect(outcome.resultPatch.installComplete).toBe(true)
    expect(outcome.resultPatch.warnings).toBeDefined()
    expect(outcome.resultPatch.warnings!.length).toBeGreaterThan(0)
  })

  it('case 5: pre-flight failure (unsupported ledger version) → non-blocking proceed', async () => {
    // Write a ledger with version > CURRENT_VERSION. `readLedger` throws
    // `namespace.ledger.version_unsupported`; the gate catches and degrades.
    const badLedger = {
      version: CURRENT_VERSION + 99,
      overrides: [],
    }
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(badLedger), 'utf-8')

    plantSkill('code-helper')
    const c = candidate('code-helper')

    // Suppress the expected warn from the gate.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const outcome = await runNamespaceGate({
      candidate: c,
      mode: 'preventative',
      tier: 'community',
    })

    expect(outcome.decision).toBe('proceed')
    expect(outcome.resultPatch.installComplete).toBe(true)
    expect(outcome.resultPatch.warnings).toBeUndefined()
    expect(outcome.resultPatch.pendingCollision).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('case 6: mid-rename atomicity probe — target_exists short-circuits before mutation; ledger NOT appended', async () => {
    // Atomicity: target-collision aborts BEFORE any mutation or ledger
    // append. Induce by pre-creating the destination (vi cannot spy on
    // ESM fs exports for fault-injection).
    plantSkill('code-helper', { author: 'sibling' })
    const skillDir = path.join(SKILLS_DIR, 'code-helper')
    const skillMdBefore = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')
    const targetDir = path.join(SKILLS_DIR, 'sibling-code-helper')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'PLACEHOLDER'), 'do not overwrite\n')

    const result = await applyRename({
      suggestion: skillSuggestion({
        source_path: skillDir,
        identifier: 'code-helper',
        suggested: 'sibling-code-helper',
        author: 'sibling',
      }),
      request: { action: 'apply', auditId: newAuditId() },
    })

    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('namespace.rename.target_exists')
    expect((await readLedger()).overrides).toEqual([])
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toBe(skillMdBefore)
    expect(fs.existsSync(path.join(targetDir, 'PLACEHOLDER'))).toBe(true)
    // No backup taken — `runBackup` runs only after the target pre-check passes.
    expect(fs.existsSync(BACKUPS_DIR)).toBe(false)
  })

  it('case 7: ledger replay collision after independent install', async () => {
    // User previously renamed `ship` → `anthropic-ship` (recorded in ledger).
    plantSkill('anthropic-ship', { author: 'anthropic' })
    const replayLedger = {
      version: CURRENT_VERSION,
      overrides: [
        {
          id: 'ovr_TEST01',
          skillId: 'anthropic/ship',
          kind: 'skill' as const,
          originalIdentifier: 'ship',
          renamedTo: 'anthropic-ship',
          originalPath: path.join(SKILLS_DIR, 'ship'),
          renamedPath: path.join(SKILLS_DIR, 'anthropic-ship'),
          appliedAt: '2026-04-30T15:42:18.331Z',
          auditId: 'audit_TEST01',
          reason: 'collision with sibling',
        },
      ],
    }
    await writeLedger(replayLedger)

    // A new install of `anthropic/ship` should replay → identifier becomes
    // `anthropic-ship`, which now collides with the existing planted entry.
    const c = candidate('ship', { skillId: 'anthropic/ship' })
    const outcome = await runNamespaceGate({
      candidate: c,
      mode: 'preventative',
      tier: 'community',
    })

    // The replayed candidate identifier is `anthropic-ship`, which collides
    // with the planted skill above → block.
    expect(outcome.candidate.identifier).toBe('anthropic-ship')
    expect(outcome.decision).toBe('block')
    expect(outcome.resultPatch.pendingCollision).toBeDefined()
  })

  it('case 8: audit-report writer renders rename-suggestion section when supplied', () => {
    const auditId = newAuditId()
    const e: InventoryEntry = {
      kind: 'skill',
      source_path: path.join(SKILLS_DIR, 'ship'),
      identifier: 'ship',
      triggerSurface: ['ship'],
      meta: { author: 'release-tools' },
    }
    const result: InventoryAuditResult = {
      auditId,
      inventory: [e],
      exactCollisions: [
        {
          kind: 'exact',
          severity: 'error',
          collisionId: 'cid-ship-1' as CollisionId,
          identifier: 'ship',
          entries: [e],
          reason: 'exact collision',
        } as ExactCollisionFlag,
      ],
      genericFlags: [],
      semanticCollisions: [],
      summary: {
        totalEntries: 1,
        totalFlags: 1,
        errorCount: 1,
        warningCount: 0,
        durationMs: 1,
        passDurations: { exact: 1, generic: 0, semantic: 0 },
      },
    }
    const suggestions: RenameSuggestion[] = [
      {
        collisionId: 'cid-ship-1' as CollisionId,
        entry: e,
        currentName: 'ship',
        suggested: 'release-tools-ship',
        applyAction: 'rename_skill_dir_and_frontmatter',
        reason: 'collision',
      },
    ]
    const md = renderAuditReport(result, { renameSuggestions: suggestions })
    expect(md).toContain('## Recommended edits')
    expect(md).toContain('| Current name | Suggested rename | Apply action | Apply command |')
    expect(md).toContain('`release-tools-ship`')
    expect(md).toContain(`sklx audit collisions apply ${auditId} cid-ship-1`)
    expect(md).not.toContain('_No automated edits suggested in Wave 1._')

    // Backwards-compat: rendering WITHOUT suggestions retains the
    // placeholder.
    const placeholderMd = renderAuditReport(result)
    expect(placeholderMd).toContain('_No automated edits suggested in Wave 1._')
  })

  it('case 9: backup-gc sweeps old, retains recent, skips malformed via canonical path resolution', async () => {
    // Plant backups in the canonical layout. Use absolute path because
    // getBackupsDir() captures HOME at module load — see test setup notes.
    const skillBackupRoot = path.join(BACKUPS_DIR, 'anthropic-ship')
    fs.mkdirSync(skillBackupRoot, { recursive: true })

    const now = new Date('2026-05-01T12:00:00.000Z')
    const oldStamp = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/[:.]/g, '-')
    const recentStamp = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/[:.]/g, '-')
    fs.mkdirSync(path.join(skillBackupRoot, `${oldStamp}_namespace-rename`), { recursive: true })
    fs.mkdirSync(path.join(skillBackupRoot, `${recentStamp}_namespace-rename`), {
      recursive: true,
    })
    // Malformed leaf — must be skipped, not removed.
    fs.mkdirSync(path.join(skillBackupRoot, '_no-timestamp'), { recursive: true })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await runBackupGC({ backupsDir: BACKUPS_DIR, retentionDays: 14, now })
    expect(result.removed).toBe(1)
    expect(result.kept).toBe(1)
    expect(result.skipped).toBe(1)
    expect(fs.existsSync(path.join(skillBackupRoot, `${oldStamp}_namespace-rename`))).toBe(false)
    expect(fs.existsSync(path.join(skillBackupRoot, `${recentStamp}_namespace-rename`))).toBe(true)
    expect(fs.existsSync(path.join(skillBackupRoot, '_no-timestamp'))).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('case 10: end-to-end — gate-block → applyRename → gate-proceed; ledger has 1 entry', async () => {
    plantShadow('sibling-pack', 'code-helper', 'sibling-vendor')
    const c = candidate('code-helper', { skillId: 'anthropic/code-helper' })
    const auditId = newAuditId()

    // A: gate blocks.
    expect(
      (await runNamespaceGate({ candidate: c, mode: 'preventative', tier: 'community' })).decision
    ).toBe('block')

    // B: apply rename to the existing shadowing sibling.
    const applyResult = await applyRename({
      suggestion: skillSuggestion({
        source_path: path.join(SKILLS_DIR, 'sibling-pack'),
        identifier: 'code-helper',
        suggested: 'sibling-vendor-code-helper',
        author: 'sibling-vendor',
        collisionId: 'e2e-01',
      }),
      request: { action: 'apply', auditId },
    })
    expect(applyResult.success).toBe(true)
    expect(applyResult.summary).toMatch(
      /Renamed \/code-helper → \/sibling-vendor-code-helper\. To undo: sklx/
    )

    // C: gate now proceeds.
    const proceeded = await runNamespaceGate({
      candidate: c,
      mode: 'preventative',
      tier: 'community',
    })
    expect(proceeded.decision).toBe('proceed')
    expect(proceeded.resultPatch.installComplete).toBe(true)

    const ledger = await readLedger()
    expect(ledger.overrides.length).toBe(1)
    expect(ledger.overrides[0]!.auditId).toBe(auditId)
    expect(ledger.overrides[0]!.originalIdentifier).toBe('code-helper')
    expect(ledger.overrides[0]!.renamedTo).toBe('sibling-vendor-code-helper')
  })
})

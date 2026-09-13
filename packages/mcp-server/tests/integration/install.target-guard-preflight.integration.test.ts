/**
 * SMI-6529 L20 (round 2) — the MCP `install_skill` tool's `force` +
 * `conflictAction` pre-flight (install.ts) must run core's
 * `checkInstallTarget()` BEFORE its own backup/GC side effects
 * (`createSkillBackup`/`cleanupOldBackups`, inside `checkForConflicts`).
 *
 * Before this fix, a target-guard refusal (an untracked pre-existing
 * directory, a git working tree, etc.) was only ever discovered LATER,
 * inside `service.install()`'s own internal call to the same guard — by
 * which point this pre-flight had already written a backup file and swept
 * old backups for an install that was going to be refused anyway.
 *
 * Real end-to-end coverage (no `@skillsmith/core` mocking of the guard
 * itself) — only the GitHub fetch is mocked, and its mock must NEVER be
 * called: a refusal this early must short-circuit before any network I/O
 * too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

vi.mock('@skillsmith/core/services/skill-installation-io', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    fetchFromGitHub: vi.fn(async () => {
      throw new Error('should never be reached — the target guard must refuse first')
    }),
    fetchAndScanOptionalFiles: vi.fn(),
  }
})

// SMI-6529 N5 (round 4): `buildPreflightCandidate`/`resolveCallerTier`/
// `readAuditModeOverride`/`extractSkillName` moved into this module (to
// keep install.ts under the 500-line gate) — `install.ts` now imports ALL
// of them from here, so this mock must pass those four through via
// `importActual` (they're pure, deterministic, no side effects) and only
// override `runNamespaceGate` itself (the one export this test needs
// bypassed, to skip real namespace-collision detection).
vi.mock('../../src/tools/install.namespace-gate.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/tools/install.namespace-gate.js')>()
  return {
    ...actual,
    runNamespaceGate: vi.fn(async (input: { candidate: { identifier: string } }) => ({
      decision: 'proceed' as const,
      candidate: input.candidate,
      preflight: { warnings: [], pendingCollision: null, auditId: 'test-audit-id', problem: null },
      resultPatch: { installComplete: true },
      // SMI-6588: `problems` is non-optional on NamespaceGateOutcome and
      // `install.ts` spreads it. Omitting it here spreads `undefined` and
      // throws — and TypeScript cannot catch that through an untyped mock
      // factory, which is precisely why the field is not optional.
      problems: [],
    })),
  }
})

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

describe('SMI-6529 L20: install_skill conflict pre-flight runs the target guard before backup/GC', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), 'smi6529-mcp-preflight-'))
    process.env['HOME'] = homeDir
    process.env['USERPROFILE'] = homeDir
    vi.resetModules()

    const ioModule = await import('@skillsmith/core/services/skill-installation-io')
    vi.mocked(
      ioModule.fetchAndScanOptionalFiles as (...args: unknown[]) => unknown
    ).mockResolvedValue({ configWarnings: [], failedScans: [], filesToWrite: [] })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (ORIGINAL_HOME === undefined) delete process.env['HOME']
    else process.env['HOME'] = ORIGINAL_HOME
    if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE']
    else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE
    await rm(homeDir, { recursive: true, force: true })
  })

  it('refuses a git-worktree install target BEFORE creating a backup or running backup GC', async () => {
    const skillsDir = path.join(homeDir, '.claude', 'skills')
    const targetDir = path.join(skillsDir, 'preflight-skill')
    // A real git clone at the target — checkInstallTarget's rule (d) fires
    // on this regardless of manifest tracking, and MUST fire before the
    // pre-flight's own backup/GC side effects.
    await mkdir(path.join(targetDir, '.git'), { recursive: true })
    await writeFile(path.join(targetDir, 'SKILL.md'), '# uncommitted user work\n', 'utf-8')

    // Tracked (and path-matching, so rule (e) would also pass if ever
    // reached) with `originalContentHash` set — so `checkForConflicts`
    // WOULD find a "hasLocalModifications" conflict and attempt a backup
    // if the target guard didn't refuse first.
    const { ManifestManager } = await import('@skillsmith/core')
    const manifestPath = path.join(homeDir, '.skillsmith', 'manifest.json')
    await new ManifestManager(manifestPath).save({
      version: '1.0.0',
      installedSkills: {
        'preflight-skill': {
          id: 'https://github.com/owner/preflight-skill',
          name: 'preflight-skill',
          version: '1.0.0',
          source: 'github:owner/preflight-skill',
          installPath: targetDir,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          originalContentHash: 'deadbeef',
        },
      },
    })

    const { createToolContext } = await import('../../src/context.js')
    const context = createToolContext({
      dbPath: ':memory:',
      apiClientConfig: { offlineMode: true },
    })

    const { installSkill } = await import('../../src/tools/install.js')
    const result = await installSkill(
      {
        skillId: 'https://github.com/owner/preflight-skill',
        force: true,
        conflictAction: 'overwrite',
        confirmed: true,
        skipOptimize: true,
        // Explicit `cwd`, anchored at this test's own temp $HOME — without
        // it, resolveScopedSkillsDir() walks from the test RUNNER's actual
        // process.cwd() (the repo root when run via vitest), which can find
        // a real workspace marker there and silently resolve to WORKSPACE
        // scope instead of the global scope this test means to exercise.
        cwd: homeDir,
      },
      context
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('git working tree')

    // No backup was ever created — the guard refused before
    // createSkillBackup()/cleanupOldBackups() could run.
    const backupsRoot = path.join(skillsDir, '.backups')
    expect(await pathExists(backupsRoot)).toBe(false)

    // The pre-existing directory and its content are completely untouched.
    const remaining = (await readdir(targetDir)).sort()
    expect(remaining).toEqual(['.git', 'SKILL.md'])

    const ioModule = await import('@skillsmith/core/services/skill-installation-io')
    expect(ioModule.fetchFromGitHub as (...args: unknown[]) => unknown).not.toHaveBeenCalled()
  })

  // SMI-6529 N5 (round 4, reviewer probe-preflight.mjs): the pre-flight used
  // to look up the manifest by the BARE skill name (missing every
  // non-canonical client's entry, whose key is always `name::client`) and
  // compute `installPath` as `path.join(effectiveSkillsDir, skillName)`
  // using whatever `effectiveSkillsDir` the OLD code resolved — for a
  // non-default client this could point at an entirely unrelated
  // directory. The reviewer's exact scenario: `~/.claude` (the DEFAULT
  // client's own directory) is a real git repo, but the install is for
  // `cursor` — a correct pre-flight must judge `~/.cursor/skills/...`
  // (which has nothing to do with `~/.claude`), not wrongly refuse based on
  // an unrelated directory's git status.
  it('a non-default client (cursor) is judged against its OWN skills dir, never a git repo living under an unrelated client dir', async () => {
    const skillName = 'preflight-cursor-skill'

    // The DEFAULT client's own directory is a real git repo — irrelevant to
    // a cursor install, but exactly what the OLD bug's wrong installPath
    // computation would have accidentally hit.
    await mkdir(path.join(homeDir, '.claude'), { recursive: true })
    await mkdir(path.join(homeDir, '.claude', '.git'), { recursive: true })

    // The REAL cursor target: tracked, path-matching, with
    // `originalContentHash` set so `checkForConflicts` would attempt a
    // conflict resolution if the (correct) target guard doesn't refuse —
    // no `.git` anywhere near it.
    const cursorSkillsDir = path.join(homeDir, '.cursor', 'skills')
    const targetDir = path.join(cursorSkillsDir, skillName)
    await mkdir(targetDir, { recursive: true })
    await writeFile(path.join(targetDir, 'SKILL.md'), '# cursor install\n', 'utf-8')

    // SMI-6529 N5: recorded under the NON-canonical composite key
    // (`name::client`) — a bare-name lookup would miss this entirely.
    const { ManifestManager } = await import('@skillsmith/core')
    const manifestPath = path.join(homeDir, '.skillsmith', 'manifest.json')
    await new ManifestManager(manifestPath).save({
      version: '1.0.0',
      installedSkills: {
        [`${skillName}::cursor`]: {
          id: `https://github.com/owner/${skillName}`,
          name: skillName,
          version: '1.0.0',
          source: `github:owner/${skillName}`,
          installPath: targetDir,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          originalContentHash: 'deadbeef',
          client: 'cursor',
        },
      },
    })

    const { createToolContext } = await import('../../src/context.js')
    const context = createToolContext({
      dbPath: ':memory:',
      apiClientConfig: { offlineMode: true },
    })

    const { installSkill } = await import('../../src/tools/install.js')
    const result = await installSkill(
      {
        skillId: `https://github.com/owner/${skillName}`,
        client: 'cursor',
        force: true,
        conflictAction: 'overwrite',
        confirmed: true,
        skipOptimize: true,
        cwd: homeDir,
      },
      context
    )

    // Must NOT be refused as a git working tree — `~/.claude` being a git
    // repo is irrelevant to this cursor install.
    expect(result.error ?? '').not.toContain('git working tree')
    // The cursor target itself is untouched by any git-worktree refusal —
    // it never had a `.git` to begin with, so this just confirms no
    // recursive delete/backup churn happened on it either.
    const remaining = (await readdir(targetDir)).sort()
    expect(remaining).toEqual(['SKILL.md'])
  })
})

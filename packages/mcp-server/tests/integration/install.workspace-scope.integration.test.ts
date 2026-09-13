/**
 * ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review — install_skill MCP tool
 * workspace-scope wiring.
 *
 * The prior review round found `install_skill` never called
 * `resolveScopedSkillsDir()`/`resolveSkillScope()` at all — it always called
 * `getInstallPath(effectiveClient)`, the OLD global-only resolution, so the
 * MCP server could never reach workspace scope (contradicting ADR-139's own
 * stated MCP requirement, point 7). This file proves the fix with REAL
 * end-to-end coverage — deliberately NOT mocking `@skillsmith/core/install`
 * (that's the whole point: a mocked resolver would prove nothing about
 * whether the real one is actually wired in).
 *
 * Mirrors the CLI-side Wave 4 real-e2e test pattern
 * (`manage-multi-client.test.ts` / `manage-update-adoption-real.test.ts`,
 * packages/cli): a temp `$HOME` (the global side) plus a separate temp
 * "workspace" directory with a real `.git` marker, `vi.resetModules()` so
 * `CLIENT_NATIVE_PATHS`/`CLAUDE_SKILLS_DIR` (both frozen at module-load via
 * `os.homedir()`) re-derive from the new `$HOME`, and GitHub fetch mocked
 * for network isolation only — not scope resolution, which stays real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

// SMI-5260: SkillInstallationService fetches via `skill-installation.io`
// directly (not the mcp-server-local `install.helpers.js` re-export) — see
// `install.execution.integration.test.ts`'s identical mock for the full
// rationale. `writeInstallFiles` is left REAL so the install actually
// writes SKILL.md to disk, which the assertions below depend on.
vi.mock('@skillsmith/core/services/skill-installation-io', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    fetchFromGitHub: vi.fn(),
    fetchAndScanOptionalFiles: vi.fn(),
  }
})

// SMI-4588 Wave 2 PR #3's namespace pre-flight (`runNamespaceGate`) is an
// orthogonal concern to what this file proves (scope resolution) — it scans
// local inventory unrelated to `$HOME`/cwd redirection and, at the default
// `community`-tier `preventative` mode, blocks on ANY detected collision.
// Mocked to a deterministic `proceed` outcome, matching install.test.ts's
// identical isolation of this same concern.
// SMI-6529 N5 (round 4): `buildPreflightCandidate`/`resolveCallerTier`/
// `readAuditModeOverride`/`extractSkillName` moved into this module (to
// keep install.ts under the 500-line gate) — `install.ts` now imports ALL
// of them from here, so this mock must pass those four through via
// `importActual` (pure, deterministic, no side effects) and only override
// `runNamespaceGate` itself.
vi.mock('../../src/tools/install.namespace-gate.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/tools/install.namespace-gate.js')>()
  return {
    ...actual,
    runNamespaceGate: vi.fn(async (input: { candidate: { identifier: string } }) => ({
      decision: 'proceed' as const,
      candidate: input.candidate,
      preflight: { warnings: [], pendingCollision: null, auditId: 'test-audit-id' },
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
const ORIGINAL_SKILLSMITH_SCOPE = process.env['SKILLSMITH_SCOPE']

const SKILL_MD = [
  '---',
  'name: workspace-scope-test-skill',
  'description: A test skill for ADR-139 workspace-scope MCP wiring coverage.',
  '---',
  '# Workspace Scope Test Skill',
  '',
  'This is a test skill with sufficient content to pass all validation checks.',
  'It has YAML frontmatter, a markdown heading, and enough body text.',
].join('\n')

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

describe('ADR-139 (SMI-6274 Wave 4): install_skill MCP tool workspace-scope wiring', () => {
  let homeDir: string
  let workspaceDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), 'smi6274-mcp-global-'))
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'smi6274-mcp-workspace-'))
    // A real VCS boundary — findWorkspaceRoot()'s VCS-fallback tier (no
    // pre-existing `.claude/skills` marker in this dir, deliberately: proves
    // the VCS-only case, not the already-marked case).
    await mkdir(path.join(workspaceDir, '.git'), { recursive: true })

    process.env['HOME'] = homeDir
    process.env['USERPROFILE'] = homeDir
    delete process.env['SKILLSMITH_SCOPE']

    // CLIENT_NATIVE_PATHS / CLAUDE_SKILLS_DIR / DEFAULT_MANIFEST_PATH-style
    // constants compute homedir() at module import time — reset modules so
    // every import below sees this test's own $HOME.
    vi.resetModules()

    const ioModule = await import('@skillsmith/core/services/skill-installation-io')
    vi.mocked(ioModule.fetchFromGitHub as (...args: unknown[]) => unknown).mockResolvedValue(
      SKILL_MD
    )
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
    if (ORIGINAL_SKILLSMITH_SCOPE === undefined) delete process.env['SKILLSMITH_SCOPE']
    else process.env['SKILLSMITH_SCOPE'] = ORIGINAL_SKILLSMITH_SCOPE
    await rm(homeDir, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('SKILLSMITH_SCOPE=workspace + cwd installs into the workspace directory, never the global one', async () => {
    process.env['SKILLSMITH_SCOPE'] = 'workspace'

    const { createToolContext } = await import('../../src/context.js')
    const context = createToolContext({
      dbPath: ':memory:',
      apiClientConfig: { offlineMode: true },
    })

    const { installSkill } = await import('../../src/tools/install.js')
    const result = await installSkill(
      {
        skillId: 'https://github.com/owner/workspace-scope-test-skill',
        // A raw GitHub URL is always 'unknown' trust tier (no registry
        // metadata) — skipScan is forbidden for that tier (SKIP_SCAN_FORBIDDEN),
        // so this lets the REAL scanner run against the innocuous SKILL_MD
        // content above and confirms past the unknown-tier warning instead.
        confirmed: true,
        skipOptimize: true,
        cwd: workspaceDir,
      },
      context
    )

    expect(result.success).toBe(true)
    const expectedWorkspaceDir = path.join(workspaceDir, '.claude', 'skills')
    const globalDir = path.join(homeDir, '.claude', 'skills')
    expect(result.installPath.startsWith(expectedWorkspaceDir)).toBe(true)
    expect(result.installPath.startsWith(globalDir)).toBe(false)

    // The manifest write landed in the WORKSPACE manifest — the global one
    // was never even created (ADR-139 point 1: workspace-local manifest,
    // global manifest completely untouched).
    const workspaceManifestRaw = await readFile(
      path.join(workspaceDir, '.skillsmith', 'manifest.json'),
      'utf-8'
    )
    const workspaceManifest = JSON.parse(workspaceManifestRaw) as {
      installedSkills: Record<string, unknown>
    }
    expect(Object.keys(workspaceManifest.installedSkills).length).toBeGreaterThan(0)
    expect(await pathExists(path.join(homeDir, '.skillsmith', 'manifest.json'))).toBe(false)
  })

  it('explicit scope: "workspace" param wins over SKILLSMITH_SCOPE=global (rank 1 over rank 2)', async () => {
    process.env['SKILLSMITH_SCOPE'] = 'global'

    const { createToolContext } = await import('../../src/context.js')
    const context = createToolContext({
      dbPath: ':memory:',
      apiClientConfig: { offlineMode: true },
    })

    const { installSkill } = await import('../../src/tools/install.js')
    const result = await installSkill(
      {
        skillId: 'https://github.com/owner/workspace-scope-test-skill',
        // A raw GitHub URL is always 'unknown' trust tier (no registry
        // metadata) — skipScan is forbidden for that tier (SKIP_SCAN_FORBIDDEN),
        // so this lets the REAL scanner run against the innocuous SKILL_MD
        // content above and confirms past the unknown-tier warning instead.
        confirmed: true,
        skipOptimize: true,
        cwd: workspaceDir,
        scope: 'workspace',
      },
      context
    )

    expect(result.success).toBe(true)
    const expectedWorkspaceDir = path.join(workspaceDir, '.claude', 'skills')
    expect(result.installPath.startsWith(expectedWorkspaceDir)).toBe(true)
  })

  it('bare install with no scope signal resolves to global — no workspace directory silently created (ADR-139 point 5 / required test 12)', async () => {
    // workspaceDir has a real .git but NO pre-existing marker — a bare VCS
    // boundary alone must NOT count as auto-detection (ADR-139 point 2 rank
    // 4 requires an EXISTING marker, `via === 'marker'`), so this must fall
    // all the way through to global.
    const { createToolContext } = await import('../../src/context.js')
    const context = createToolContext({
      dbPath: ':memory:',
      apiClientConfig: { offlineMode: true },
    })

    const { installSkill } = await import('../../src/tools/install.js')
    const result = await installSkill(
      {
        skillId: 'https://github.com/owner/workspace-scope-test-skill',
        // A raw GitHub URL is always 'unknown' trust tier (no registry
        // metadata) — skipScan is forbidden for that tier (SKIP_SCAN_FORBIDDEN),
        // so this lets the REAL scanner run against the innocuous SKILL_MD
        // content above and confirms past the unknown-tier warning instead.
        confirmed: true,
        skipOptimize: true,
        cwd: workspaceDir,
      },
      context
    )

    expect(result.success).toBe(true)
    const expectedGlobalDir = path.join(homeDir, '.claude', 'skills')
    expect(result.installPath.startsWith(expectedGlobalDir)).toBe(true)

    // No workspace directory was created anywhere under workspaceDir.
    expect(await pathExists(path.join(workspaceDir, '.claude', 'skills'))).toBe(false)
  })

  it('explicit scope: "workspace" from OUTSIDE any workspace is a hard error, never a silent downgrade to global (ADR-139 point 2 / required test 11)', async () => {
    // A non-existent subdirectory of homeDir — findWorkspaceRoot() doesn't
    // require cwd to exist (pure path-string walk), and this deterministically
    // terminates AT $HOME (the walk's own exclusive bound) rather than
    // depending on real filesystem state above /tmp.
    const outsideDir = path.join(homeDir, 'no-such-workspace-for-outside-test')

    const { createToolContext } = await import('../../src/context.js')
    const context = createToolContext({
      dbPath: ':memory:',
      apiClientConfig: { offlineMode: true },
    })

    const { installSkill } = await import('../../src/tools/install.js')
    const result = await installSkill(
      {
        skillId: 'https://github.com/owner/workspace-scope-test-skill',
        // A raw GitHub URL is always 'unknown' trust tier (no registry
        // metadata) — skipScan is forbidden for that tier (SKIP_SCAN_FORBIDDEN),
        // so this lets the REAL scanner run against the innocuous SKILL_MD
        // content above and confirms past the unknown-tier warning instead.
        confirmed: true,
        skipOptimize: true,
        cwd: outsideDir,
        scope: 'workspace',
      },
      context
    )

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('no workspace root was found')
    // No filesystem write of any kind — global or otherwise.
    expect(await pathExists(path.join(homeDir, '.claude', 'skills'))).toBe(false)
  })

  it('GPT-5.6-Sol PR review round 2: a workspace-scoped forced reinstall with conflictAction "cancel" against a locally-modified install actually cancels, never overwrites', async () => {
    // SkillInstallationService.install() never reads `conflictAction` at all
    // — the MCP-only pre-flight in install.ts is conflictAction's ENTIRE
    // effect. Round-1 of this fix gated that pre-flight to global scope
    // only, silently dropping `conflictAction` for workspace-scoped
    // reinstalls; this proves the fix reads the WORKSPACE manifest so
    // "cancel" is actually honored, not silently ignored.
    const skillDir = path.join(workspaceDir, '.claude', 'skills', 'workspace-scope-test-skill')
    await mkdir(skillDir, { recursive: true })

    const ORIGINAL_CONTENT = SKILL_MD
    const LOCALLY_MODIFIED_CONTENT =
      SKILL_MD + '\n\nLocally added a note the user does not want lost.\n'
    await writeFile(path.join(skillDir, 'SKILL.md'), LOCALLY_MODIFIED_CONTENT, 'utf-8')

    const { ManifestManager } = await import('@skillsmith/core')
    const workspaceManifestPath = path.join(workspaceDir, '.skillsmith', 'manifest.json')
    await new ManifestManager(workspaceManifestPath).save({
      version: '1.0.0',
      installedSkills: {
        'workspace-scope-test-skill': {
          id: 'https://github.com/owner/workspace-scope-test-skill',
          name: 'workspace-scope-test-skill',
          version: '1.0.0',
          source: 'github:owner/workspace-scope-test-skill',
          installPath: skillDir,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          // The pre-flight's conflict detection keys off this exact field —
          // it must differ from the ON-DISK content's hash for
          // detectModifications() to report `modified: true`.
          originalContentHash: createHash('sha256').update(ORIGINAL_CONTENT).digest('hex'),
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
        skillId: 'https://github.com/owner/workspace-scope-test-skill',
        force: true,
        conflictAction: 'cancel',
        confirmed: true,
        skipOptimize: true,
        cwd: workspaceDir,
        scope: 'workspace',
      },
      context
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('Installation cancelled by user')

    // The install must NEVER have proceeded — the locally-modified content
    // on disk is byte-identical to what it was before this call.
    const contentAfter = await readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
    expect(contentAfter).toBe(LOCALLY_MODIFIED_CONTENT)
  })

  it('SMI-6529: --also-link fan-out surfaces a leftover interrupted-refresh backup warning in tips', async () => {
    // extractSkillName('https://github.com/owner/workspace-scope-test-skill')
    // takes the last '/'-segment -- the same literal name every other test
    // in this file uses for the GLOBAL install directory.
    const canonicalSkillDir = path.join(homeDir, '.claude', 'skills', 'workspace-scope-test-skill')
    const cursorDestDir = path.join(homeDir, '.cursor', 'skills', 'workspace-scope-test-skill')

    // Pre-seed the --also-link fan-out destination as an existing,
    // manifest-recorded copy so `force: true` is allowed to overwrite it
    // (assertOverwritable in fan-out.overwrite.ts) -- and so
    // recoverDestination() does NOT restore the leftover backup seeded
    // below (it only restores a backup when the destination is MISSING).
    await mkdir(cursorDestDir, { recursive: true })
    await writeFile(path.join(cursorDestDir, 'SKILL.md'), '# stale cursor copy\n', 'utf-8')

    const { saveManifest } = await import('@skillsmith/core/install')
    await saveManifest({
      version: 1,
      links: [
        {
          skillId: 'workspace-scope-test-skill',
          from: canonicalSkillDir,
          to: cursorDestDir,
          kind: 'copy',
          createdAt: new Date().toISOString(),
        },
      ],
    })

    // A hidden backup folder left behind by an earlier interrupted refresh,
    // sitting next to the fan-out destination.
    const backupDir = path.join(
      homeDir,
      '.cursor',
      'skills',
      '.workspace-scope-test-skill.skillsmith-backup-AbC123'
    )
    await mkdir(path.join(backupDir, 'original'), { recursive: true })
    await writeFile(path.join(backupDir, 'original', 'SKILL.md'), '# orphaned\n', 'utf-8')

    const { createToolContext } = await import('../../src/context.js')
    const context = createToolContext({
      dbPath: ':memory:',
      apiClientConfig: { offlineMode: true },
    })

    const { installSkill } = await import('../../src/tools/install.js')
    const result = await installSkill(
      {
        skillId: 'https://github.com/owner/workspace-scope-test-skill',
        confirmed: true,
        skipOptimize: true,
        // No explicit `scope` -- `workspaceDir` has only a bare `.git`
        // marker, which the "bare install ... resolves to global" test
        // above already proves is not enough to auto-detect workspace
        // scope, so this lands the PRIMARY install at global, matching
        // `canonicalSkillDir` above.
        cwd: workspaceDir,
        alsoLink: ['cursor'],
        force: true,
      },
      context
    )

    expect(result.success).toBe(true)
    expect(result.installPath).toBe(canonicalSkillDir)

    const tipsText = (result.tips ?? []).join('\n')
    expect(tipsText).toContain('alsoLink to cursor')
    expect(tipsText).toContain('an interrupted refresh')

    // The cursor destination now holds the fresh fan-out copy, not the
    // stale pre-seeded content...
    const cursorSkillMd = await readFile(path.join(cursorDestDir, 'SKILL.md'), 'utf-8')
    expect(cursorSkillMd).not.toBe('# stale cursor copy\n')

    // ...but the orphaned backup folder is left alone, only ever reported.
    expect(await pathExists(path.join(backupDir, 'original', 'SKILL.md'))).toBe(true)
  })
})

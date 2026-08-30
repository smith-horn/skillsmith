/**
 * ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review — uninstall_skill MCP
 * tool workspace-scope wiring.
 *
 * Companion to `install.workspace-scope.integration.test.ts`. The same
 * review round that found `install_skill` couldn't reach workspace scope
 * also found `uninstall_skill` had the SAME gap, plus a narrower
 * pre-existing one on top: it constructed `SkillInstallationService` with
 * NO `skillsDir`/`manifestPath`/`client` at all, so it could only ever
 * target the global directory for the canonical client, full stop.
 *
 * This proves the fix with a real plant-then-uninstall round trip: a skill
 * physically installed at WORKSPACE scope is found and removed only when
 * `uninstall_skill` is asked for that exact scope — a same-named GLOBAL
 * copy must survive completely untouched (the SMI-5894 "wrong-copy"
 * failure class, one axis over, per ADR-139 point 1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']
const ORIGINAL_SKILLSMITH_SCOPE = process.env['SKILLSMITH_SCOPE']

const SKILL_MD_BODY =
  '\n# Dual Scope Skill\n\nEnough body content to pass the 100-character minimum ' +
  'validation threshold, in case anything downstream re-validates it.\n'

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

describe('ADR-139 (SMI-6274 Wave 4): uninstall_skill MCP tool workspace-scope wiring', () => {
  let homeDir: string
  let workspaceDir: string
  // A temp dir with NO ancestor relationship to homeDir/workspaceDir at all
  // (a sibling under tmpdir(), not a descendant of either) — used as `cwd`
  // for the "bare call" test below. `homeDir` itself unavoidably ends up
  // with a REAL `.claude/skills` marker once the global-scope plant step
  // runs (that marker path IS `CLIENT_NATIVE_PATHS['claude-code']`), so
  // passing homeDir (or any descendant of it) as `cwd` would let rank-4
  // auto-detection "find" it — this dir never does, since walking up from
  // it never visits homeDir's subtree at all, only tmpdir()'s own ancestry.
  let neutralCwd: string

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), 'smi6274-mcp-uninstall-global-'))
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'smi6274-mcp-uninstall-workspace-'))
    neutralCwd = await mkdtemp(path.join(tmpdir(), 'smi6274-mcp-uninstall-neutral-'))

    process.env['HOME'] = homeDir
    process.env['USERPROFILE'] = homeDir
    delete process.env['SKILLSMITH_SCOPE']

    // CLIENT_NATIVE_PATHS / DEFAULT_MANIFEST_PATH-style constants compute
    // homedir() at module import time — vi.resetModules() lives in each
    // it() below (via dynamic import after the env var is set) rather than
    // beforeEach, matching install.workspace-scope.integration.test.ts.
  })

  afterEach(async () => {
    if (ORIGINAL_HOME === undefined) delete process.env['HOME']
    else process.env['HOME'] = ORIGINAL_HOME
    if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE']
    else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE
    if (ORIGINAL_SKILLSMITH_SCOPE === undefined) delete process.env['SKILLSMITH_SCOPE']
    else process.env['SKILLSMITH_SCOPE'] = ORIGINAL_SKILLSMITH_SCOPE
    await rm(homeDir, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
    await rm(neutralCwd, { recursive: true, force: true })
  })

  it('scope: "workspace" removes the workspace-scoped copy and leaves an identically-named global copy untouched', async () => {
    vi.resetModules()

    const { ManifestManager } = await import('@skillsmith/core')

    // Plant a WORKSPACE-scoped install — the real directory itself IS the
    // marker findWorkspaceRoot() looks for (created via mkdir recursive).
    const workspaceSkillDir = path.join(workspaceDir, '.claude', 'skills', 'dual-scope-skill')
    await mkdir(workspaceSkillDir, { recursive: true })
    await writeFile(
      path.join(workspaceSkillDir, 'SKILL.md'),
      `---\nname: dual-scope-skill\ndescription: test\n---\n${SKILL_MD_BODY}`,
      'utf-8'
    )
    const workspaceManifestPath = path.join(workspaceDir, '.skillsmith', 'manifest.json')
    await new ManifestManager(workspaceManifestPath).save({
      version: '1.0.0',
      installedSkills: {
        'dual-scope-skill': {
          id: 'owner/dual-scope-skill',
          name: 'dual-scope-skill',
          version: '1.0.0',
          source: 'github:owner/dual-scope-skill',
          installPath: workspaceSkillDir,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      },
    })

    // Plant a DIFFERENT, GLOBAL install of the SAME skill name — proves
    // uninstall targets the exact (scope, client, name) triple, never
    // "whichever scope happens to match by name" (ADR-139 point 1).
    const globalSkillDir = path.join(homeDir, '.claude', 'skills', 'dual-scope-skill')
    await mkdir(globalSkillDir, { recursive: true })
    await writeFile(
      path.join(globalSkillDir, 'SKILL.md'),
      `---\nname: dual-scope-skill\ndescription: test\n---\n${SKILL_MD_BODY}`,
      'utf-8'
    )
    const globalManifestPath = path.join(homeDir, '.skillsmith', 'manifest.json')
    await new ManifestManager(globalManifestPath).save({
      version: '1.0.0',
      installedSkills: {
        'dual-scope-skill': {
          id: 'owner/dual-scope-skill',
          name: 'dual-scope-skill',
          version: '1.0.0',
          source: 'github:owner/dual-scope-skill',
          installPath: globalSkillDir,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      },
    })

    const { createToolContext } = await import('../../src/context.js')
    const context = createToolContext({
      dbPath: ':memory:',
      apiClientConfig: { offlineMode: true },
    })

    const { uninstallSkill } = await import('../../src/tools/uninstall.js')
    const result = await uninstallSkill(
      {
        skillName: 'dual-scope-skill',
        force: true,
        scope: 'workspace',
        cwd: workspaceDir,
      },
      context
    )

    expect(result.success).toBe(true)
    expect(await pathExists(workspaceSkillDir)).toBe(false)
    // The global copy of the SAME name survives, completely untouched.
    expect(await pathExists(globalSkillDir)).toBe(true)
  })

  it('scope: "global" (the default) removes only the global copy, leaving an identically-named workspace copy untouched', async () => {
    vi.resetModules()

    const { ManifestManager } = await import('@skillsmith/core')

    const workspaceSkillDir = path.join(workspaceDir, '.claude', 'skills', 'dual-scope-skill-2')
    await mkdir(workspaceSkillDir, { recursive: true })
    await writeFile(
      path.join(workspaceSkillDir, 'SKILL.md'),
      `---\nname: dual-scope-skill-2\ndescription: test\n---\n${SKILL_MD_BODY}`,
      'utf-8'
    )
    const workspaceManifestPath = path.join(workspaceDir, '.skillsmith', 'manifest.json')
    await new ManifestManager(workspaceManifestPath).save({
      version: '1.0.0',
      installedSkills: {
        'dual-scope-skill-2': {
          id: 'owner/dual-scope-skill-2',
          name: 'dual-scope-skill-2',
          version: '1.0.0',
          source: 'github:owner/dual-scope-skill-2',
          installPath: workspaceSkillDir,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      },
    })

    const globalSkillDir = path.join(homeDir, '.claude', 'skills', 'dual-scope-skill-2')
    await mkdir(globalSkillDir, { recursive: true })
    await writeFile(
      path.join(globalSkillDir, 'SKILL.md'),
      `---\nname: dual-scope-skill-2\ndescription: test\n---\n${SKILL_MD_BODY}`,
      'utf-8'
    )
    const globalManifestPath = path.join(homeDir, '.skillsmith', 'manifest.json')
    await new ManifestManager(globalManifestPath).save({
      version: '1.0.0',
      installedSkills: {
        'dual-scope-skill-2': {
          id: 'owner/dual-scope-skill-2',
          name: 'dual-scope-skill-2',
          version: '1.0.0',
          source: 'github:owner/dual-scope-skill-2',
          installPath: globalSkillDir,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      },
    })

    const { createToolContext } = await import('../../src/context.js')
    const context = createToolContext({
      dbPath: ':memory:',
      apiClientConfig: { offlineMode: true },
    })

    const { uninstallSkill } = await import('../../src/tools/uninstall.js')
    // No `scope` passed, and `cwd` points at a neutral dir with no workspace
    // marker in its ancestry — the previous, pre-fix default behavior
    // (global-only) must still be exactly what happens for a bare call.
    const result = await uninstallSkill(
      { skillName: 'dual-scope-skill-2', force: true, cwd: neutralCwd },
      context
    )

    expect(result.success).toBe(true)
    expect(await pathExists(globalSkillDir)).toBe(false)
    // The workspace copy of the SAME name survives, completely untouched —
    // a bare uninstall_skill call must never reach into a workspace it was
    // never told about.
    expect(await pathExists(workspaceSkillDir)).toBe(true)
  })

  it("GPT-5.6-Sol PR review round 2: a non-canonical-client, workspace-scoped uninstall does NOT remove a same-named skill's canonical --also-link fan-out destinations", async () => {
    // removeLinks(skillId) reads the GLOBAL ~/.skillsmith/links/manifest.json
    // and matches purely by bare skill name — no scope/client awareness at
    // all (confirmed against packages/core/src/install/fan-out.ts). Calling
    // it unconditionally on every successful uninstall would delete the
    // CANONICAL install's --also-link fan-out destinations whenever an
    // independent, same-named copy under a NON-CANONICAL client is
    // uninstalled (the CLI's own manage.action.ts comment's exact example:
    // `remove foo --client cursor` nuking a canonical foo's fan-out link).
    // The guard is client-only, matching the CLI's own identical condition —
    // confirmed the CLI's `removeSkill()` has this SAME shape (accepts a
    // `scopeTarget` yet still only checks `client === CANONICAL_CLIENT`), so
    // this test targets the scenario the guard actually protects: a
    // DIFFERENT client, not merely a different scope of the canonical
    // client (which neither this fix nor the CLI's own pre-existing guard
    // claims to cover — matching, not exceeding, the CLI's behavior was the
    // explicit instruction).
    vi.resetModules()

    const { ManifestManager } = await import('@skillsmith/core')
    const { getLinkManifestPath, saveManifest: saveLinkManifest } =
      await import('@skillsmith/core/install')

    // Plant the CANONICAL (global, claude-code) install this skill's
    // fan-out link was recorded FROM.
    const canonicalSkillDir = path.join(homeDir, '.claude', 'skills', 'link-guard-skill')
    await mkdir(canonicalSkillDir, { recursive: true })
    await writeFile(
      path.join(canonicalSkillDir, 'SKILL.md'),
      `---\nname: link-guard-skill\ndescription: test\n---\n${SKILL_MD_BODY}`,
      'utf-8'
    )
    const globalManifestPath = path.join(homeDir, '.skillsmith', 'manifest.json')
    await new ManifestManager(globalManifestPath).save({
      version: '1.0.0',
      installedSkills: {
        'link-guard-skill': {
          id: 'owner/link-guard-skill',
          name: 'link-guard-skill',
          version: '1.0.0',
          source: 'github:owner/link-guard-skill',
          installPath: canonicalSkillDir,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      },
    })

    // Plant the canonical install's real --also-link fan-out destination —
    // deliberately `windsurf`, NOT `cursor`, so its path can never collide
    // with the independent `cursor` install below — plus the link record
    // removeLinks() reads.
    const fanOutDestDir = path.join(homeDir, '.codeium', 'windsurf', 'skills', 'link-guard-skill')
    await mkdir(fanOutDestDir, { recursive: true })
    await writeFile(
      path.join(fanOutDestDir, 'SKILL.md'),
      `---\nname: link-guard-skill\ndescription: test\n---\n${SKILL_MD_BODY}`,
      'utf-8'
    )
    await saveLinkManifest({
      version: 1,
      links: [
        {
          skillId: 'link-guard-skill',
          from: canonicalSkillDir,
          to: fanOutDestDir,
          kind: 'copy',
          createdAt: new Date().toISOString(),
        },
      ],
    })
    const linkManifestPath = getLinkManifestPath()

    // Plant an INDEPENDENT install of the SAME skill name under a
    // NON-CANONICAL client (cursor), at WORKSPACE scope — this is the one
    // actually being uninstalled below. Its manifest key includes the
    // `::cursor` suffix per manifestKeyFor()'s (client, name) keying.
    const cursorWorkspaceSkillDir = path.join(workspaceDir, '.cursor', 'skills', 'link-guard-skill')
    await mkdir(cursorWorkspaceSkillDir, { recursive: true })
    await writeFile(
      path.join(cursorWorkspaceSkillDir, 'SKILL.md'),
      `---\nname: link-guard-skill\ndescription: test\n---\n${SKILL_MD_BODY}`,
      'utf-8'
    )
    const workspaceManifestPath = path.join(workspaceDir, '.skillsmith', 'manifest.json')
    await new ManifestManager(workspaceManifestPath).save({
      version: '1.0.0',
      installedSkills: {
        'link-guard-skill::cursor': {
          id: 'owner/link-guard-skill',
          name: 'link-guard-skill',
          version: '1.0.0',
          source: 'github:owner/link-guard-skill',
          installPath: cursorWorkspaceSkillDir,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      },
    })

    const { createToolContext } = await import('../../src/context.js')
    const context = createToolContext({
      dbPath: ':memory:',
      apiClientConfig: { offlineMode: true },
    })

    const { uninstallSkill } = await import('../../src/tools/uninstall.js')
    const result = await uninstallSkill(
      {
        skillName: 'link-guard-skill',
        force: true,
        client: 'cursor',
        scope: 'workspace',
        cwd: workspaceDir,
      },
      context
    )

    expect(result.success).toBe(true)
    expect(await pathExists(cursorWorkspaceSkillDir)).toBe(false)

    // The canonical install and its fan-out destination/record are
    // completely untouched.
    expect(await pathExists(canonicalSkillDir)).toBe(true)
    expect(await pathExists(fanOutDestDir)).toBe(true)
    const linkManifestRaw = await readFile(linkManifestPath, 'utf-8')
    const linkManifest = JSON.parse(linkManifestRaw) as {
      links: Array<{ skillId: string }>
    }
    expect(linkManifest.links.some((l) => l.skillId === 'link-guard-skill')).toBe(true)
  })
})

/**
 * ADR-139 (SMI-6274 Wave 4): tests for the global-vs-workspace install
 * scope resolver.
 *
 * Every scenario builds a REAL directory tree under a temp dir (never the
 * developer's actual $HOME or repo) so `findWorkspaceRoot`'s live
 * `existsSync`/`path.dirname` walk is exercised exactly as it runs in
 * production — mocking `existsSync` with path-string matching would be
 * fragile for a recursive ancestor walk with this many boundary shapes
 * (worktree/submodule/monorepo/symlink-depth). `homeDirOverride` is the
 * module's own test seam (mirrors `agent-home-relocate.ts`'s `homeDir`
 * override elsewhere in this package) — production callers never pass it;
 * the resolver otherwise always sources home via the real `os.homedir()`.
 *
 * Tests 1 and 2 are the specific regression pair for ADR-139 point 4's
 * termination-before-candidacy bug (caught only in cross-model review — an
 * earlier draft checked candidacy before termination, which collapsed
 * global and workspace scope for the `agents` client). Both MUST fail
 * against that wrong ordering.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  InvalidScopeValueError,
  UnsatisfiableWorkspaceScopeError,
  findWorkspaceRoot,
  parseInstallScope,
  resolveScopedSkillsDir,
  resolveSkillScope,
} from './workspace-scope.js'
import { CLIENT_NATIVE_PATHS } from './paths.js'
import { ManifestManager } from '../services/skill-manifest.js'
import { manifestKeyFor } from '../services/skill-installation.helpers.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'skillsmith-workspace-scope-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** Build `<tmpRoot>/<...segments>` as a real directory and return its path. */
function dir(...segments: string[]): string {
  const p = join(tmpRoot, ...segments)
  mkdirSync(p, { recursive: true })
  return p
}

/** Mark `p` as a git root: `.git` as a real DIRECTORY (plain repo). */
function gitDir(p: string): void {
  mkdirSync(join(p, '.git'), { recursive: true })
}

/** Mark `p` as a worktree/submodule: `.git` as a FILE (gitlink pointer). */
function gitFile(p: string): void {
  writeFileSync(join(p, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n')
}

describe('findWorkspaceRoot — boundary and stop-condition (ADR-139 point 4)', () => {
  it('1. cwd = ~/.agents/skills resolves to global, not workspace (regression pair 1/2)', () => {
    // The pathological case: the walk starts INSIDE a directory whose own
    // name matches the `agents` client's workspace marker segments, and
    // that directory sits directly under home ($HOME/.agents/skills is
    // exactly CLIENT_NATIVE_PATHS.agents). Under the buggy
    // candidacy-before-termination ordering, the walk would test
    // `$HOME/.agents/skills` for a marker BEFORE applying "stop at home"
    // and wrongly return $HOME as a workspace root.
    const home = dir('home')
    const cwd = dir('home', '.agents', 'skills')

    const result = findWorkspaceRoot(cwd, 'agents', { homeDirOverride: home })

    expect(result).toBeNull()
  })

  it('2. a real repository beneath $HOME still resolves workspace correctly (regression pair 2/2)', () => {
    // Confirms the fix for test 1 did not over-correct into breaking the
    // ordinary case: a genuine repo living under $HOME must still resolve.
    const home = dir('home')
    const repoRoot = dir('home', 'projects', 'foo')
    gitDir(repoRoot)
    const cwd = dir('home', 'projects', 'foo', 'src', 'deep')

    const result = findWorkspaceRoot(cwd, 'agents', { homeDirOverride: home })

    expect(result).toEqual({ root: repoRoot, via: 'vcs' })
  })

  it('3. a marker above a VCS root is not honored', () => {
    const home = dir('home')
    // A stray marker one level above the actual repo root.
    mkdirSync(join(tmpRoot, 'projects', '.agents', 'skills'), { recursive: true })
    const repoRoot = dir('projects', 'foo')
    gitDir(repoRoot)
    const cwd = dir('projects', 'foo', 'src')

    const result = findWorkspaceRoot(cwd, 'agents', { homeDirOverride: home })

    expect(result).toEqual({ root: repoRoot, via: 'vcs' })
    expect(result?.root).not.toBe(join(tmpRoot, 'projects'))
  })

  it('4. a git worktree (.git as a file) is its own workspace root', () => {
    const home = dir('home')
    const worktreeRoot = dir('repo', '.worktrees', 'feature-x')
    gitFile(worktreeRoot)
    const cwd = dir('repo', '.worktrees', 'feature-x', 'packages', 'core')

    const result = findWorkspaceRoot(cwd, 'claude-code', { homeDirOverride: home })

    expect(result).toEqual({ root: worktreeRoot, via: 'vcs' })
  })

  it('5. a submodule (.git as a gitlink file) resolves to the submodule root, not the superproject', () => {
    const home = dir('home')
    gitDir(dir('repo')) // superproject
    const submoduleRoot = dir('repo', 'docs', 'internal')
    gitFile(submoduleRoot)
    const cwd = dir('repo', 'docs', 'internal', 'adr')

    const result = findWorkspaceRoot(cwd, 'claude-code', { homeDirOverride: home })

    expect(result).toEqual({ root: submoduleRoot, via: 'vcs' })
  })

  it('6a. a monorepo subpackage with no marker resolves to the monorepo root', () => {
    const home = dir('home')
    const monorepoRoot = dir('monorepo')
    gitDir(monorepoRoot)
    const cwd = dir('monorepo', 'packages', 'website', 'src')

    const result = findWorkspaceRoot(cwd, 'cursor', { homeDirOverride: home })

    expect(result).toEqual({ root: monorepoRoot, via: 'vcs' })
  })

  it('6b. a monorepo subpackage WITH its own marker resolves to the subpackage', () => {
    const home = dir('home')
    const monorepoRoot = dir('monorepo')
    gitDir(monorepoRoot)
    const subpackage = dir('monorepo', 'packages', 'website')
    mkdirSync(join(subpackage, '.cursor', 'skills'), { recursive: true })
    const cwd = dir('monorepo', 'packages', 'website', 'src')

    const result = findWorkspaceRoot(cwd, 'cursor', { homeDirOverride: home })

    expect(result).toEqual({ root: subpackage, via: 'marker' })
  })

  it('7. outside any workspace (no marker, no .git anywhere) resolves to null — no error, no warning', () => {
    const home = dir('home')
    const cwd = dir('tools', 'scratch')

    const result = findWorkspaceRoot(cwd, 'claude-code', { homeDirOverride: home })

    expect(result).toBeNull()
  })

  it('8. pathological depth terminates at the 64-level cap rather than hanging', () => {
    const home = dir('home')
    // A synthetic path far deeper than the 64-level cap, none of whose
    // segments exist on disk or contain a marker/.git — path.dirname()
    // operates on the string, so real directories need not exist for the
    // walk to proceed.
    const deepSegments = Array.from({ length: 100 }, (_, i) => `level-${i}`)
    const cwd = join(tmpRoot, 'deep', ...deepSegments)

    const result = findWorkspaceRoot(cwd, 'claude-code', { homeDirOverride: home })

    expect(result).toBeNull()
  })
})

describe('resolveSkillScope — scope semantics (ADR-139 points 2, 5, 6; SMI-5894 regression class)', () => {
  it('9. the same skill can exist under both scopes for one client; each resolves independently', () => {
    const home = dir('home')
    const repoRoot = dir('repo')
    gitDir(repoRoot)
    mkdirSync(join(repoRoot, '.claude', 'skills'), { recursive: true })
    const cwd = repoRoot

    const globalResult = resolveSkillScope({
      client: 'claude-code',
      cwd,
      explicitScope: 'global',
      homeDirOverride: home,
    })
    const workspaceResult = resolveSkillScope({
      client: 'claude-code',
      cwd,
      explicitScope: 'workspace',
      homeDirOverride: home,
    })

    expect(globalResult.scope).toBe('global')
    expect(globalResult.dir).toBe(CLIENT_NATIVE_PATHS['claude-code'])
    expect(workspaceResult.scope).toBe('workspace')
    expect(workspaceResult.dir).toBe(join(repoRoot, '.claude', 'skills'))
    expect(globalResult.dir).not.toBe(workspaceResult.dir)
  })

  it('10. --scope workspace for a client with null workspace segments is a hard error, no write', () => {
    const home = dir('home')
    const cwd = dir('anywhere')

    expect(() =>
      resolveSkillScope({
        client: 'copilot',
        cwd,
        explicitScope: 'workspace',
        homeDirOverride: home,
      })
    ).toThrow(UnsatisfiableWorkspaceScopeError)
  })

  it('11. --scope workspace from outside any workspace is a hard error, no directory created', () => {
    const home = dir('home')
    const cwd = dir('tools', 'scratch')

    expect(() =>
      resolveSkillScope({
        client: 'claude-code',
        cwd,
        explicitScope: 'workspace',
        homeDirOverride: home,
      })
    ).toThrow(UnsatisfiableWorkspaceScopeError)
  })

  it('12. bare resolution with no marker present resolves to global, creating no workspace directory anywhere', () => {
    // No flag, no env, and `configDefaultScope: null` means "no config
    // default configured" WITHOUT touching the real ~/.skillsmith/config.json
    // — this genuinely exercises rank 4 (auto-detect: a .git root exists but
    // no .claude/skills marker does, so it doesn't match) falling through to
    // rank 5 (global), not a config default short-circuiting straight to it.
    const home = dir('home')
    const repoRoot = dir('repo')
    gitDir(repoRoot)
    const cwd = repoRoot

    const result = resolveSkillScope({
      client: 'claude-code',
      cwd,
      envScope: '',
      configDefaultScope: null,
      homeDirOverride: home,
    })

    expect(result).toEqual({
      scope: 'global',
      dir: CLIENT_NATIVE_PATHS['claude-code'],
      created: false,
    })
    expect(existsSync(join(repoRoot, '.claude', 'skills'))).toBe(false)
  })

  it('13. --scope workspace with no marker present creates the directory at the resolved root', () => {
    const home = dir('home')
    const repoRoot = dir('repo')
    gitDir(repoRoot)
    const cwd = repoRoot
    const expectedDir = join(repoRoot, '.claude', 'skills')

    const result = resolveSkillScope({
      client: 'claude-code',
      cwd,
      explicitScope: 'workspace',
      homeDirOverride: home,
    })

    expect(result.created).toBe(true)
    expect(result.dir).toBe(expectedDir)
    expect(existsSync(expectedDir)).toBe(true)
  })

  it('14. precedence: each rank overrides every rank below it', () => {
    const home = dir('home')
    const repoRoot = dir('repo')
    gitDir(repoRoot)
    mkdirSync(join(repoRoot, '.claude', 'skills'), { recursive: true })
    const cwd = repoRoot

    // Rank 3 (config default) is honored when neither flag nor env is set.
    const configOnly = resolveSkillScope({
      client: 'claude-code',
      cwd,
      envScope: '',
      configDefaultScope: 'workspace',
      homeDirOverride: home,
    })
    expect(configOnly.scope).toBe('workspace')

    // Rank 2 (env var) overrides rank 3 (config default).
    const envOverridesConfig = resolveSkillScope({
      client: 'claude-code',
      cwd,
      envScope: 'global',
      configDefaultScope: 'workspace',
      homeDirOverride: home,
    })
    expect(envOverridesConfig.scope).toBe('global')

    // Rank 1 (explicit flag) overrides rank 2 (env var).
    const flagOverridesEnv = resolveSkillScope({
      client: 'claude-code',
      cwd,
      explicitScope: 'global',
      envScope: 'workspace',
      homeDirOverride: home,
    })
    expect(flagOverridesEnv.scope).toBe('global')

    // SKILLSMITH_SCOPE is honored when no flag is passed...
    const envHonoredAlone = resolveSkillScope({
      client: 'claude-code',
      cwd,
      envScope: 'workspace',
      homeDirOverride: home,
    })
    expect(envHonoredAlone.scope).toBe('workspace')

    // ...and ignored when a flag IS passed.
    const envIgnoredWithFlag = resolveSkillScope({
      client: 'claude-code',
      cwd,
      explicitScope: 'global',
      envScope: 'workspace',
      homeDirOverride: home,
    })
    expect(envIgnoredWithFlag.scope).toBe('global')
  })
})

describe('parseInstallScope', () => {
  it('returns undefined for absent/empty values', () => {
    expect(parseInstallScope(undefined)).toBeUndefined()
    expect(parseInstallScope(null)).toBeUndefined()
    expect(parseInstallScope('')).toBeUndefined()
  })

  it('parses valid values', () => {
    expect(parseInstallScope('global')).toBe('global')
    expect(parseInstallScope('workspace')).toBe('workspace')
  })

  it('throws InvalidScopeValueError for anything else', () => {
    expect(() => parseInstallScope('bogus')).toThrow(InvalidScopeValueError)
  })
})

describe('resolveScopedSkillsDir — manifest path selection (ADR-139 point 1)', () => {
  it('resolves the workspace-local manifest path for workspace scope', () => {
    const home = dir('home')
    const repoRoot = dir('repo')
    gitDir(repoRoot)
    const globalManifestPath = join(home, '.skillsmith', 'manifest.json')

    const result = resolveScopedSkillsDir({
      client: 'claude-code',
      cwd: repoRoot,
      explicitScope: 'workspace',
      homeDirOverride: home,
      globalManifestPath,
    })

    expect(result.manifestPath).toBe(join(repoRoot, '.skillsmith', 'manifest.json'))
    expect(result.manifestPath).not.toBe(globalManifestPath)
  })

  it('resolves the global manifest path unchanged for global scope', () => {
    const home = dir('home')
    const globalManifestPath = join(home, '.skillsmith', 'manifest.json')

    const result = resolveScopedSkillsDir({
      client: 'claude-code',
      cwd: dir('anywhere'),
      explicitScope: 'global',
      homeDirOverride: home,
      globalManifestPath,
    })

    expect(result.manifestPath).toBe(globalManifestPath)
  })
})

describe('16. a workspace-scoped install writes only the workspace manifest (ADR-139 point 1)', () => {
  it('leaves the global manifest and manifestKeyFor() output byte-identical before and after', async () => {
    const home = dir('home')
    const repoRoot = dir('repo')
    gitDir(repoRoot)
    const globalManifestPath = join(home, '.skillsmith', 'manifest.json')

    // Seed the global manifest with a pre-existing entry, exactly as a real
    // prior global install would have left it.
    const globalManifest = new ManifestManager(globalManifestPath)
    await globalManifest.save({
      version: '1.0.0',
      installedSkills: {
        [manifestKeyFor('pre-existing', 'claude-code')]: {
          id: 'someone/pre-existing',
          name: 'pre-existing',
          version: '1.0.0',
          source: 'https://github.com/someone/pre-existing',
          installPath: join(CLIENT_NATIVE_PATHS['claude-code'], 'pre-existing'),
          installedAt: '2026-01-01T00:00:00.000Z',
          lastUpdated: '2026-01-01T00:00:00.000Z',
        },
      },
    })
    const globalManifestBefore = await globalManifest.load()

    // Resolve workspace scope and write ONLY to the workspace manifest —
    // this is what SkillInstallationService does once it's constructed
    // with resolveScopedSkillsDir()'s output (install.ts/manage.action.ts
    // wiring); exercised directly here against ManifestManager to isolate
    // the manifest-routing claim from the full registry-fetch install path.
    const target = resolveScopedSkillsDir({
      client: 'claude-code',
      cwd: repoRoot,
      explicitScope: 'workspace',
      homeDirOverride: home,
      globalManifestPath,
    })
    expect(target.manifestPath).not.toBe(globalManifestPath)

    const workspaceManifest = new ManifestManager(target.manifestPath)
    await workspaceManifest.save({
      version: '1.0.0',
      installedSkills: {
        [manifestKeyFor('workspace-skill', 'claude-code')]: {
          id: 'someone/workspace-skill',
          name: 'workspace-skill',
          version: '1.0.0',
          source: 'https://github.com/someone/workspace-skill',
          installPath: join(target.dir, 'workspace-skill'),
          installedAt: '2026-08-29T00:00:00.000Z',
          lastUpdated: '2026-08-29T00:00:00.000Z',
        },
      },
    })

    const globalManifestAfter = await globalManifest.load()
    expect(globalManifestAfter).toEqual(globalManifestBefore)

    const workspaceManifestLoaded = await workspaceManifest.load()
    expect(Object.keys(workspaceManifestLoaded.installedSkills)).toEqual([
      manifestKeyFor('workspace-skill', 'claude-code'),
    ])
  })
})

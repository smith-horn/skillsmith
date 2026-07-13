/**
 * Post-write validation + git commit helpers extracted from prepare-release.ts (SMI-4783).
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import { ROOT_DIR, readPackageVersion, readVersionConstant } from './version-utils.js'
import { type BumpPlan } from './release-collision.js'

export function validatePostWrite(plans: BumpPlan[]): string[] {
  const errors: string[] = []
  for (const plan of plans) {
    const { spec, newVersion } = plan
    const actual = readPackageVersion(spec.packageJsonPath)
    if (actual !== newVersion) {
      errors.push(`${spec.name}: package.json has ${actual}, expected ${newVersion}`)
    }
    if (spec.versionConstFile && spec.versionConstPattern) {
      const constVer = readVersionConstant(spec.versionConstFile, spec.versionConstPattern)
      if (constVer !== newVersion) {
        errors.push(`${spec.name}: version constant has ${constVer}, expected ${newVersion}`)
      }
    }
    if (spec.serverJsonPath) {
      const fullPath = join(ROOT_DIR, spec.serverJsonPath)
      const server = JSON.parse(readFileSync(fullPath, 'utf-8'))
      if (server.version !== newVersion) {
        errors.push(
          `${spec.name}: server.json version has ${server.version}, expected ${newVersion}`
        )
      }
      if (server.packages?.[0]?.version !== newVersion) {
        errors.push(
          `${spec.name}: server.json packages[0].version has ${server.packages?.[0]?.version}, expected ${newVersion}`
        )
      }
    }
  }
  return errors
}

export function getCurrentBranch(): string {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd: ROOT_DIR,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

/**
 * SMI-4775: regenerate package-lock.json after dep-range bumps so the published
 * release ships a lockfile that matches the bumped `^X.Y.Z` ranges in
 * package.json. `--ignore-scripts` skips native postinstall (better-sqlite3,
 * onnxruntime-node) which the host doesn't need rebuilt for a lockfile-only pass.
 */
export function regenerateLockfile(): void {
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  })
}

/**
 * SMI-5672: the single shared source of truth for "every file this release run
 * touched", consumed by BOTH `createCommit`'s `git add` (below) and
 * `prepare-release.ts`'s Step 10 (--no-commit preview) / Step 11 (real-commit
 * confirmation) console output. Collapsing what were two independently
 * hand-maintained file lists onto one function is the core fix for SMI-5672:
 * they can never again silently drift. (The original bug: the files written by
 * `updateWorkspaceDependencies` were reported as successful to the console but
 * omitted from `git add`, because `createCommit` had no knowledge of that
 * returned list and hand-built its own.)
 *
 * Ordering (stable, tested): per-plan derived files — package.json, version
 * constant, server.json, CHANGELOG.md — first, then `extraFiles` (e.g. the
 * workspace dep-range writes returned by `updateWorkspaceDependencies`), then
 * `package-lock.json` when `includeLockfile`. The list is de-duplicated with
 * first-occurrence order preserved, then filtered to files that exist on disk
 * (the same `existsSync` filter `createCommit` applied before this extraction)
 * so both consumers receive an identical, accurate, file-exists-checked list.
 *
 * `noChangelog` omits each plan's CHANGELOG.md entirely — used only by the
 * Step 10 preview so it never claims a changelog was modified when
 * `--no-changelog` was passed. `createCommit` does not pass it: the real
 * `git add` relies on the `existsSync` filter alone (a skipped changelog was
 * never generated, so it won't exist), keeping the preview and the commit in
 * agreement.
 */
export function buildFilesToAdd(
  plans: BumpPlan[],
  options: { includeLockfile?: boolean; extraFiles?: string[]; noChangelog?: boolean } = {}
): string[] {
  const { includeLockfile = false, extraFiles = [], noChangelog = false } = options
  const candidates: string[] = []

  for (const plan of plans) {
    candidates.push(plan.spec.packageJsonPath)
    if (plan.spec.versionConstFile) candidates.push(plan.spec.versionConstFile)
    if (plan.spec.serverJsonPath) candidates.push(plan.spec.serverJsonPath)
    if (!noChangelog) candidates.push(join(plan.spec.dir, 'CHANGELOG.md'))
  }

  // SMI-5672: the CORE_DEPENDENTS special-case that used to live in
  // createCommit (unconditionally staging packages/{mcp-server,cli,enterprise}/
  // package.json whenever `core` was in the bump plan) was removed here.
  // `extraFiles` — fed by the caller from updateWorkspaceDependencies's returned
  // `updated` list — now covers the same sibling dep-range files, but only the
  // ones actually written this run. The old unconditional staging both masked
  // this bug for core-only bumps and staged files that weren't changed.
  candidates.push(...extraFiles)

  // SMI-4775: include regenerated package-lock.json when caller opts in.
  if (includeLockfile) {
    candidates.push('package-lock.json')
  }

  // De-duplicate preserving first-occurrence order, then keep only files that
  // exist on disk (behavior ported from createCommit's original filter).
  const deduped = [...new Set(candidates)]
  return deduped.filter((f) => existsSync(join(ROOT_DIR, f)))
}

export function createCommit(
  plans: BumpPlan[],
  includeLockfile = false,
  extraFiles: string[] = []
): void {
  // SMI-5672: git-add list derived from the shared buildFilesToAdd so it can
  // never drift from the console output prepare-release.ts prints.
  const existing = buildFilesToAdd(plans, { includeLockfile, extraFiles })
  execFileSync('git', ['add', ...existing], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  })

  const parts = plans.map((p) => `${p.spec.shortName} ${p.newVersion}`)
  const message = `chore(release): bump ${parts.join(', ')}`

  execFileSync('git', ['commit', '-m', message], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  })
}

/**
 * Post-write validation + git commit helpers extracted from prepare-release.ts (SMI-4783).
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  CORE_DEPENDENTS,
  ROOT_DIR,
  readPackageVersion,
  readVersionConstant,
} from './version-utils.js'
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

export function createCommit(plans: BumpPlan[]): void {
  const filesToAdd: string[] = []

  for (const plan of plans) {
    filesToAdd.push(plan.spec.packageJsonPath)
    if (plan.spec.versionConstFile) filesToAdd.push(plan.spec.versionConstFile)
    if (plan.spec.serverJsonPath) filesToAdd.push(plan.spec.serverJsonPath)
    filesToAdd.push(join(plan.spec.dir, 'CHANGELOG.md'))
  }

  // Add core dependent package.jsons if core was bumped
  if (plans.some((p) => p.spec.shortName === 'core')) {
    for (const dep of CORE_DEPENDENTS) {
      if (existsSync(join(ROOT_DIR, dep))) {
        filesToAdd.push(dep)
      }
    }
  }

  const existing = filesToAdd.filter((f) => existsSync(join(ROOT_DIR, f)))
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

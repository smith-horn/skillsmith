/**
 * @fileoverview `performUninstall` reports only its SECOND manifest update when
 * the manifest lock is lost once.
 * @see SMI-7143: a lost lock reruns the `updateSafely` callback once;
 *   `claimedByAnotherInstall` lives outside it, so the callback resets it.
 *
 * Real caller, real manifest file. The first locked read of the manifest (the
 * one inside `updateSafely`, while `<manifest>.lock` exists) returns a record
 * that differs from the one just removed, as if another install had claimed the
 * name, and backdates the lock by 26 s so the pre-rename check fails on age.
 * The rerun reads the real file, whose record matches, so the removal completes
 * and no "another install claimed this name" warning may be reported.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const inject = vi.hoisted(() => ({
  target: null as string | null,
  lockedReads: 0,
  /** Given what the first locked read saw, returns what that read hands back. */
  onFirstLockedRead: null as ((seen: string) => string) | null,
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const { existsSync } = await import('node:fs')
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args)
    if (
      inject.target !== null &&
      String(args[0]) === inject.target &&
      existsSync(`${inject.target}.lock`)
    ) {
      inject.lockedReads += 1
      if (inject.lockedReads === 1 && inject.onFirstLockedRead) {
        return inject.onFirstLockedRead(String(result)) as typeof result
      }
    }
    return result
  }) as typeof actual.readFile
  return { ...actual, readFile, default: { ...actual, readFile } }
})

import { performUninstall } from '../../../src/services/skill-installation.uninstall.js'
import { ManifestManager } from '../../../src/services/skill-manifest.js'
import type { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'

const CLAIMED = 'Another install claimed this name'

let root = ''
let skillsDir = ''
let installPath = ''
let manifestPath = ''

function recordFor(version: string): Record<string, unknown> {
  return {
    id: 'acme/foo',
    name: 'foo',
    version,
    source: 'https://github.com/acme/foo',
    installPath,
    installedAt: '2024-01-01T00:00:00.000Z',
    lastUpdated: '2024-01-01T00:00:00.000Z',
  }
}

function manifestText(version: string): string {
  return JSON.stringify({ version: '1.0.0', installedSkills: { foo: recordFor(version) } })
}

function backdateLock(): void {
  const past = new Date(Date.now() - 26_000)
  fs.utimesSync(`${manifestPath}.lock`, past, past)
}

async function uninstall(): ReturnType<typeof performUninstall> {
  return performUninstall({
    skillName: 'foo',
    force: true,
    skillsDir,
    manifest: new ManifestManager(manifestPath),
    skillDependencyRepo: { clearAll: () => undefined } as unknown as SkillDependencyRepository,
    onProgress: () => undefined,
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-retry-'))
  skillsDir = path.join(root, 'skills')
  installPath = path.join(skillsDir, 'foo')
  manifestPath = path.join(root, 'manifest.json')
  fs.mkdirSync(installPath, { recursive: true })
  fs.writeFileSync(path.join(installPath, 'SKILL.md'), '---\nname: foo\n---\nbody')
  fs.writeFileSync(manifestPath, manifestText('1.0.0'))
  inject.target = manifestPath
  inject.lockedReads = 0
  inject.onFirstLockedRead = null
})

afterEach(() => {
  inject.target = null
  inject.onFirstLockedRead = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('performUninstall after one lost manifest lock (SMI-7143)', () => {
  it('POSITIVE CONTROL: a record another install claimed IS reported, and left in place', async () => {
    // Same claim as below, but the lock is not lost, so there is no rerun to clear it.
    inject.onFirstLockedRead = () => manifestText('2.0.0')

    const result = await uninstall()

    expect(inject.lockedReads).toBe(1)
    expect(result.success).toBe(true)
    expect(result.warning ?? '').toContain(CLAIMED)
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      installedSkills: Record<string, { version: string }>
    }
    expect(saved.installedSkills['foo']?.version).toBe('2.0.0')
  })

  it('does not report a claim seen only by the lost run', async () => {
    inject.onFirstLockedRead = () => {
      backdateLock()
      return manifestText('2.0.0')
    }

    const result = await uninstall()

    expect(inject.lockedReads).toBe(2)
    expect(result.success).toBe(true)
    expect(result.warning ?? '').not.toContain(CLAIMED)
    expect(fs.existsSync(installPath)).toBe(false)
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      installedSkills: Record<string, unknown>
    }
    expect(saved.installedSkills['foo']).toBeUndefined()
  })
})

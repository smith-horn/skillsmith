/**
 * @fileoverview mcp-server's `updateManifestSafely` runs core's shared locked
 * update, so a lost lock is caught before the rename and the update reruns
 * from the load instead of saving over another writer's change.
 * @see SMI-7143 (retro finding 3): nothing else pins this writer to
 *   `runManifestUpdate`; a plain `withFileLock` + `saveManifest` still writes
 *   the same bytes and passes every other test.
 *
 * Real writer, real manifest (the sandboxed HOME). During the FIRST read of the
 * manifest made while the lock is held, another writer's change lands in the
 * file and the lock is backdated by 26 s, as an older Skillsmith's steal would
 * leave it. The update must be rerun from that new manifest, so both changes
 * survive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'

const inject = vi.hoisted(() => ({
  target: null as string | null,
  lockedReads: 0,
  afterFirstLockedRead: null as (() => void) | null,
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
      if (inject.lockedReads === 1 && inject.afterFirstLockedRead) inject.afterFirstLockedRead()
    }
    return result
  }) as typeof actual.readFile
  return { ...actual, readFile, default: { ...actual, readFile } }
})

import { SKILLSMITH_DIR, MANIFEST_PATH } from './install.types.js'
import type { SkillManifest, SkillManifestEntry } from './install.types.js'
import { updateManifestSafely } from './install.helpers.manifest.js'

function entry(name: string): SkillManifestEntry {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    id: `author/${name}`,
    name,
    version: '1.0.0',
    source: `github:author/${name}`,
    installPath: `/sandbox/skills/${name}`,
    installedAt: at,
    lastUpdated: at,
  }
}

function writeManifest(names: string[]): void {
  const manifest: SkillManifest = {
    version: '1.0.0',
    installedSkills: Object.fromEntries(names.map((n) => [n, entry(n)])),
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8')
}

function savedNames(): string[] {
  const saved = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as SkillManifest
  return Object.keys(saved.installedSkills).sort()
}

const addMine = (m: SkillManifest): SkillManifest => ({
  ...m,
  installedSkills: { ...m.installedSkills, mine: entry('mine') },
})

beforeEach(() => {
  expect(MANIFEST_PATH).toContain('skillsmith-vitest-home-')
  fs.mkdirSync(SKILLSMITH_DIR, { recursive: true })
  fs.rmSync(`${MANIFEST_PATH}.lock`, { force: true })
  writeManifest(['existing'])
  inject.target = MANIFEST_PATH
  inject.lockedReads = 0
  inject.afterFirstLockedRead = null
})

afterEach(() => {
  inject.target = null
  inject.afterFirstLockedRead = null
  fs.rmSync(MANIFEST_PATH, { force: true })
  fs.rmSync(`${MANIFEST_PATH}.lock`, { force: true })
})

describe('updateManifestSafely after one lost manifest lock (SMI-7143)', () => {
  it('POSITIVE CONTROL: without a lost lock, one locked read and the change is saved', async () => {
    await updateManifestSafely(addMine)

    expect(inject.lockedReads).toBe(1)
    expect(savedNames()).toEqual(['existing', 'mine'])
  })

  it("does not save over another writer's change: it reruns from the load and both survive", async () => {
    inject.afterFirstLockedRead = () => {
      writeManifest(['existing', 'theirs'])
      const past = new Date(Date.now() - 26_000)
      fs.utimesSync(`${MANIFEST_PATH}.lock`, past, past)
    }

    await updateManifestSafely(addMine)

    expect(inject.lockedReads).toBe(2)
    expect(savedNames()).toEqual(['existing', 'mine', 'theirs'])
  })
})

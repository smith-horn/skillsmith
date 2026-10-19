/**
 * @fileoverview `backfillManifest({ apply: true })` reports only its SECOND run
 * when the manifest lock is lost once.
 * @see SMI-7143: a lost lock reruns the `updateSafely` callback once; the
 *   callback fills `written`/`skipped`, which live outside it, so it resets them.
 *
 * Real caller, real manifest file. The lost lock is forced by backdating
 * `<manifest>.lock` by 26 s during the FIRST read of the manifest that happens
 * while the lock is held (the lock file exists), which makes the pre-rename
 * check fail on age. `lockedReads` must be exactly 2, which proves the retry
 * fired and fired once.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const inject = vi.hoisted(() => ({
  target: null as string | null,
  lockedReads: 0,
  /** Runs right AFTER the first locked read; the read itself returns what it saw. */
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

import { backfillManifest } from '../../src/provenance/backfill.js'
import type { RecoveryReport, SkillRecoveryResult } from '../../src/provenance/types.js'

const NOW = '2026-06-25T00:00:00.000Z'

let root = ''
let manifestPath = ''
let skillDir = ''

function backdateLock(): void {
  const past = new Date(Date.now() - 26_000)
  fs.utimesSync(`${manifestPath}.lock`, past, past)
}

function entryFor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme/gitskill',
    name: 'gitskill',
    version: '1.0.0',
    source: 'https://github.com/acme/gitrepo',
    installPath: skillDir,
    installedAt: '2024-01-01T00:00:00.000Z',
    lastUpdated: '2024-01-01T00:00:00.000Z',
    ...over,
  }
}

function writeManifest(entries: Record<string, unknown>): void {
  fs.writeFileSync(manifestPath, JSON.stringify({ version: '1.0.0', installedSkills: entries }))
}

/** One qualifying skill ('gitskill') and one that never qualifies ('nope'). */
function report(): RecoveryReport {
  const qualifying: SkillRecoveryResult = {
    skillName: 'gitskill',
    installPath: skillDir,
    recoveredSource: { owner: 'acme', repo: 'gitrepo', url: 'https://github.com/acme/gitrepo' },
    registryId: null,
    method: 'git-remote',
    confidence: 'exact',
    candidates: [],
    status: 'recovered',
  }
  const unqualified: SkillRecoveryResult = {
    skillName: 'nope',
    installPath: path.join(root, 'nope'),
    recoveredSource: null,
    registryId: null,
    method: null,
    confidence: 'unknown',
    candidates: [],
    status: 'unknown',
  }
  return {
    skills: [qualifying, unqualified],
    summary: { total: 2, recovered: 1, already_tracked: 0, unknown: 1, skipped_backup: 0 },
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-bf-retry-'))
  manifestPath = path.join(root, 'manifest.json')
  skillDir = path.join(root, 'gitskill')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: x\n---\nbody')
  inject.target = manifestPath
  inject.lockedReads = 0
  inject.afterFirstLockedRead = null
})

afterEach(() => {
  inject.target = null
  inject.afterFirstLockedRead = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('backfillManifest after one lost manifest lock (SMI-7143)', () => {
  it('POSITIVE CONTROL: without a lost lock, one locked read and one write', async () => {
    writeManifest({})
    const outcome = await backfillManifest(report(), { manifestPath, apply: true, now: NOW })
    expect(inject.lockedReads).toBe(1)
    expect(outcome.written).toEqual(['gitskill'])
    expect(outcome.skipped).toEqual(['nope'])
  })

  it('reports the written skill once, not once per run', async () => {
    writeManifest({})
    inject.afterFirstLockedRead = backdateLock

    const outcome = await backfillManifest(report(), { manifestPath, apply: true, now: NOW })

    expect(inject.lockedReads).toBe(2)
    expect(outcome.written).toEqual(['gitskill'])
    expect(outcome.skipped).toEqual(['nope'])
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      installedSkills: Record<string, unknown>
    }
    expect(Object.keys(saved.installedSkills)).toEqual(['gitskill'])
  })

  it('drops a write from the lost run when the entry became healthy before the rerun', async () => {
    writeManifest({ gitskill: entryFor({ source: '' }) })
    inject.afterFirstLockedRead = () => {
      backdateLock()
      writeManifest({ gitskill: entryFor() })
    }

    const outcome = await backfillManifest(report(), { manifestPath, apply: true, now: NOW })

    expect(inject.lockedReads).toBe(2)
    expect(outcome.written).toEqual([])
    expect(outcome.skipped).toEqual(['nope', 'gitskill'])
  })

  it('drops a skip from the lost run when the entry became unhealthy before the rerun', async () => {
    writeManifest({ gitskill: entryFor() })
    inject.afterFirstLockedRead = () => {
      backdateLock()
      writeManifest({ gitskill: entryFor({ source: '' }) })
    }

    const outcome = await backfillManifest(report(), { manifestPath, apply: true, now: NOW })

    expect(inject.lockedReads).toBe(2)
    expect(outcome.written).toEqual(['gitskill'])
    expect(outcome.skipped).toEqual(['nope'])
  })
})

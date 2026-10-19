/**
 * @fileoverview T-S (backfill): `backfillManifest({ apply: true })` must leave
 * an unreadable or corrupt manifest byte-identical.
 * @see SMI-6358 fail-closed reads; acceptance test T-S in
 *   docs/internal/implementation/update-safety-and-source-resolution.md
 *
 * Real writer, real manifest file: `backfillManifest` -> `ManifestManager`
 * `.updateSafely` -> `withFileLock` -> `loadManifestForWrite`. Each case has a
 * qualifying (exact-confidence) recovery result, so the run reaches the write
 * rather than returning early on "dry-run or nothing qualified" (line ~296 of
 * backfill.ts). The positive control proves that: the same setup against a
 * valid manifest DOES change the file's bytes.
 *
 * Tests run as root, so `chmod 0o000` would not deny the read. EACCES is
 * injected at `fs/promises.readFile` for exactly the manifest path; every other
 * path (SKILL.md, the lock file) passes through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const inject = vi.hoisted(() => ({
  target: null as string | null,
  eacces: false,
  seen: 0,
  injected: 0,
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    if (inject.target !== null && String(args[0]) === inject.target) {
      inject.seen += 1
      if (inject.eacces) {
        inject.injected += 1
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(args[0])}'`), {
          code: 'EACCES',
          errno: -13,
          syscall: 'open',
          path: String(args[0]),
        })
      }
    }
    return actual.readFile(...args)
  }) as typeof actual.readFile
  return { ...actual, readFile, default: { ...actual, readFile } }
})

import { backfillManifest } from '../../src/provenance/backfill.js'
import type { RecoveryReport, SkillRecoveryResult } from '../../src/provenance/types.js'

const NOW = '2026-06-25T00:00:00.000Z'
const CORRUPT_TEXT = '{"version":"1.0.0","installedSkills":{"already-here":{"id":"acme/alr'

let root = ''
let manifestPath = ''
let skillDir = ''

function qualifyingReport(): RecoveryReport {
  const result: SkillRecoveryResult = {
    skillName: 'gitskill',
    installPath: skillDir,
    recoveredSource: { owner: 'acme', repo: 'gitrepo', url: 'https://github.com/acme/gitrepo' },
    registryId: null,
    method: 'git-remote',
    confidence: 'exact',
    candidates: [],
    status: 'recovered',
  }
  return {
    skills: [result],
    summary: { total: 1, recovered: 1, already_tracked: 0, unknown: 0, skipped_backup: 0 },
  }
}

function validManifestText(): string {
  return JSON.stringify(
    {
      version: '1.0.0',
      installedSkills: {
        'already-here': {
          id: 'acme/already-here',
          name: 'already-here',
          version: '1.0.0',
          source: 'https://github.com/acme/already-here',
          installPath: '/sandbox/skills/already-here',
          installedAt: '2024-01-01T00:00:00.000Z',
          lastUpdated: '2024-01-01T00:00:00.000Z',
        },
      },
    },
    null,
    2
  )
}

function seed(text: string): Buffer {
  fs.writeFileSync(manifestPath, text)
  return fs.readFileSync(manifestPath)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-bf-failclosed-'))
  manifestPath = path.join(root, 'manifest.json')
  skillDir = path.join(root, 'gitskill')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: x\n---\nbody')
  inject.target = manifestPath
  inject.eacces = false
  inject.seen = 0
  inject.injected = 0
})

afterEach(() => {
  inject.target = null
  inject.eacces = false
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('T-S: backfillManifest({ apply: true }) leaves a bad manifest byte-identical (SMI-6358)', () => {
  it('POSITIVE CONTROL: with a valid manifest and a qualifying entry, apply DOES rewrite the file', async () => {
    const before = seed(validManifestText())

    const outcome = await backfillManifest(qualifyingReport(), {
      manifestPath,
      apply: true,
      now: NOW,
    })

    expect(outcome.written).toEqual(['gitskill'])
    const after = fs.readFileSync(manifestPath)
    expect(after.equals(before)).toBe(false)
    const parsed = JSON.parse(after.toString('utf-8')) as {
      installedSkills: Record<string, unknown>
    }
    expect(Object.keys(parsed.installedSkills).sort()).toEqual(['already-here', 'gitskill'])
    expect(inject.seen).toBeGreaterThan(0)
    expect(inject.injected).toBe(0)
  })

  it('EACCES on reading the manifest: apply refuses and the file is byte-identical', async () => {
    const before = seed(validManifestText())
    inject.eacces = true

    const settled = await backfillManifest(qualifyingReport(), {
      manifestPath,
      apply: true,
      now: NOW,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    )

    expect(inject.injected).toBeGreaterThan(0)
    // Bytes first: a writer that saved after a failed load fails HERE.
    expect(fs.readFileSync(manifestPath).equals(before)).toBe(true)
    expect(settled).toMatchObject({
      ok: false,
      error: { name: 'ManifestUnwritableError', state: 'unreadable' },
    })
  })

  it('corrupt JSON in the manifest: apply refuses and the file is byte-identical', async () => {
    const before = seed(CORRUPT_TEXT)

    const settled = await backfillManifest(qualifyingReport(), {
      manifestPath,
      apply: true,
      now: NOW,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    )

    // Bytes first: a writer that saved after a failed load fails HERE.
    expect(fs.readFileSync(manifestPath).equals(before)).toBe(true)
    expect(settled).toMatchObject({
      ok: false,
      error: { name: 'ManifestUnwritableError', state: 'corrupt' },
    })
  })
})

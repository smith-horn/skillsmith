/**
 * @fileoverview T-S (MCP conflict install): the install conflict path must
 * leave an unreadable or corrupt manifest byte-identical.
 * @see SMI-6358 fail-closed reads; acceptance test T-S in
 *   docs/internal/implementation/update-safety-and-source-resolution.md
 *
 * `checkForConflicts` only READS the manifest object it is handed. The writer
 * on this path is `handleMergeAction`'s conflicting-merge branch, which writes
 * through the real `updateManifestSafely` (install.helpers.manifest.ts) ->
 * `withFileLock` -> core `loadManifestForWrite`. Nothing on that path is
 * mocked: the original content, the backup, the SKILL.md and the manifest are
 * all real files in the $HOME sandbox. The only seam is an errno injector on
 * `fs/promises.readFile` for exactly the manifest path (tests run as root, so
 * `chmod 0o000` would not deny the read).
 *
 * `handleMergeAction` does side-effects BEFORE the manifest write (backup,
 * conflict-marked SKILL.md, stored original). Those are not under test here;
 * only the manifest's bytes are.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

import { handleMergeAction } from './install.conflict.js'
import { storeOriginal, getBackupsDir, hashContent } from './install.conflict-helpers.js'
import { MANIFEST_PATH, type SkillManifest } from './install.types.js'

const SKILL = 'fail-closed-skill'
const ORIGINAL = 'line one\nORIGINAL middle\nline three\n'
const LOCAL = 'line one\nLOCAL middle\nline three\n'
const UPSTREAM = 'line one\nUPSTREAM middle\nline three\n'

const CORRUPT_TEXT =
  '{"version":"1.0.0","installedSkills":{"fail-closed-skill":{"id":"acme/fail-clo'

function validManifest(): SkillManifest {
  return {
    version: '1.0.0',
    installedSkills: {
      [SKILL]: {
        id: `acme/${SKILL}`,
        name: SKILL,
        version: '1.0.0',
        source: `github:acme/${SKILL}`,
        installPath: '/sandbox/skills/placeholder',
        installedAt: '2024-01-01T00:00:00.000Z',
        lastUpdated: '2024-01-01T00:00:00.000Z',
        originalContentHash: hashContent(ORIGINAL),
      },
    },
  } as SkillManifest
}

function seed(text: string): Buffer {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
  writeFileSync(MANIFEST_PATH, text)
  return readFileSync(MANIFEST_PATH)
}

describe('T-S: MCP conflict install leaves a bad manifest byte-identical (SMI-6358)', () => {
  let installDir = ''
  let manifestObj: SkillManifest

  beforeAll(() => {
    expect(MANIFEST_PATH.startsWith(process.env['HOME'] ?? '/nonexistent')).toBe(true)
    expect(MANIFEST_PATH).toContain('skillsmith-vitest-home-')
  })

  beforeEach(async () => {
    inject.target = MANIFEST_PATH
    inject.eacces = false
    inject.seen = 0
    inject.injected = 0
    manifestObj = validManifest()
    // Real files that drive handleMergeAction into its CONFLICTING-merge branch
    // (the only branch that writes the manifest).
    installDir = mkdtempSync(join(tmpdir(), 'skillsmith-conflict-install-'))
    writeFileSync(join(installDir, 'SKILL.md'), LOCAL)
    await storeOriginal(SKILL, ORIGINAL, { version: '1.0.0' })
  })

  afterEach(() => {
    inject.target = null
    inject.eacces = false
    rmSync(installDir, { recursive: true, force: true })
    rmSync(join(getBackupsDir(), SKILL), { recursive: true, force: true })
    for (const p of [MANIFEST_PATH, `${MANIFEST_PATH}.lock`]) {
      if (existsSync(p)) rmSync(p, { force: true })
    }
  })

  function merge() {
    return handleMergeAction(
      SKILL,
      installDir,
      UPSTREAM,
      manifestObj,
      'acme',
      SKILL,
      `acme/${SKILL}`,
      'claude-code'
    )
  }

  it('POSITIVE CONTROL: with a valid manifest, a conflicting merge DOES rewrite the file', async () => {
    const before = seed(JSON.stringify(validManifest(), null, 2))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let result
    try {
      result = await merge()
    } finally {
      warn.mockRestore()
    }

    // It really took the conflicting-merge branch (not the no-original fallback).
    expect(result.earlyReturn?.mergeResult?.success).toBe(false)
    const after = readFileSync(MANIFEST_PATH)
    expect(after.equals(before)).toBe(false)
    const parsed = JSON.parse(after.toString('utf-8')) as SkillManifest
    expect(parsed.installedSkills[SKILL]?.originalContentHash).toBe(hashContent(UPSTREAM))
    expect(inject.seen).toBeGreaterThan(0)
    expect(inject.injected).toBe(0)
  })

  it('EACCES on reading the manifest: the merge write refuses and the file is byte-identical', async () => {
    const before = seed(JSON.stringify(validManifest(), null, 2))
    inject.eacces = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let settled
    try {
      settled = await merge().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      )
    } finally {
      warn.mockRestore()
    }

    expect(inject.injected).toBeGreaterThan(0)
    // Bytes first: a writer that saved after a failed load fails HERE.
    expect(readFileSync(MANIFEST_PATH).equals(before)).toBe(true)
    expect(settled).toMatchObject({ ok: false, error: { name: 'ManifestUnwritableError' } })
  })

  it('corrupt JSON in the manifest: the merge write refuses and the file is byte-identical', async () => {
    const before = seed(CORRUPT_TEXT)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let settled
    try {
      settled = await merge().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      )
    } finally {
      warn.mockRestore()
    }

    // Bytes first: a writer that saved after a failed load fails HERE.
    expect(readFileSync(MANIFEST_PATH).equals(before)).toBe(true)
    expect(settled).toMatchObject({ ok: false, error: { name: 'ManifestUnwritableError' } })
  })
})

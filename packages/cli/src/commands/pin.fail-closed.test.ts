/**
 * @fileoverview T-S (pin): `skillsmith pin` must leave an unreadable or corrupt
 * manifest byte-identical.
 * @see SMI-6358 fail-closed reads; acceptance test T-S in
 *   docs/internal/implementation/update-safety-and-source-resolution.md
 *
 * Real writer, real manifest file. Nothing on the write path is mocked:
 * `createPinCommand` -> `pinAction` -> `loadManifest` (cli utils) ->
 * `updateManifestEntry` -> core `ManifestManager.updateSafely` -> core
 * `loadManifestForWrite`. The only seams are (a) `requireTier`, which is a
 * licence check unrelated to the manifest, and (b) an errno / byte injector on
 * `fs/promises.readFile` for exactly the manifest path. Tests run as root in
 * the container and in CI, so `chmod 0o000` would not deny a read; injecting
 * the errno is the only way to produce EACCES there.
 *
 * Two layers protect pin, and both are covered:
 *   - Outer: `loadManifest()` in cli utils is deliberately lenient (returns an
 *     empty manifest on ANY error), so pin exits early with "not found in
 *     manifest" before it ever reaches the writer. That already satisfies T-S.
 *   - Inner: `updateManifestEntry` -> `loadManifestForWrite` throws on a bad
 *     read. The outer layer masks it for a file that is bad from the start, so
 *     the "inner layer" block lets the FIRST read succeed and breaks the SECOND
 *     (a file that goes bad between pin's peek and its locked write). Without
 *     that block, removing the inner guard would leave this file green.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Read injector. vi.hoisted so the vi.mock factory below can see it.
// ---------------------------------------------------------------------------
const inject = vi.hoisted(() => ({
  target: null as string | null,
  mode: 'off' as 'off' | 'eacces' | 'garbage',
  /** Number of reads of `target` that pass through untouched before injecting. */
  passFirst: 0,
  seen: 0,
  injected: 0,
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    if (inject.target !== null && String(args[0]) === inject.target) {
      inject.seen += 1
      if (inject.mode !== 'off' && inject.seen > inject.passFirst) {
        inject.injected += 1
        if (inject.mode === 'garbage') return '{"version":"1.0.0","installedSkills":{"x":'
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

vi.mock('../utils/require-tier.js', () => ({
  requireTier: vi.fn().mockResolvedValue(undefined),
}))

import { createPinCommand } from './pin.js'
import { MANIFEST_PATH } from '../utils/manifest.js'

// The $HOME sandbox (vitest.setup.ts) must be in force before any hook runs. A
// failed check inside beforeAll/beforeEach still lets afterEach run, and
// afterEach deletes the manifest; a throw here fails collection instead.
if (
  !MANIFEST_PATH.includes('skillsmith-vitest-home-') ||
  !MANIFEST_PATH.startsWith(process.env['HOME'] ?? '/nonexistent')
) {
  throw new Error(`Refusing to run: ${MANIFEST_PATH} is not inside the vitest HOME sandbox`)
}

const FULL_HASH = 'a3f7b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1'

function validManifestText(): string {
  return JSON.stringify(
    {
      version: '1.0.0',
      installedSkills: {
        'commit-helper': {
          id: 'anthropic/commit-helper',
          name: 'commit-helper',
          version: '1.0.0',
          source: 'https://github.com/anthropic/commit-helper',
          installPath: '/sandbox/skills/commit-helper',
          installedAt: '2024-01-01T00:00:00.000Z',
          lastUpdated: '2024-01-01T00:00:00.000Z',
          contentHash: FULL_HASH,
          originalContentHash: FULL_HASH,
        },
        'other-skill': {
          id: 'acme/other-skill',
          name: 'other-skill',
          version: '2.0.0',
          source: 'https://github.com/acme/other-skill',
          installPath: '/sandbox/skills/other-skill',
          installedAt: '2024-02-01T00:00:00.000Z',
          lastUpdated: '2024-02-01T00:00:00.000Z',
        },
      },
    },
    null,
    2
  )
}

const CORRUPT_TEXT =
  '{"version":"1.0.0","installedSkills":{"commit-helper":{"id":"anthropic/commit-hel'

async function runPin(): Promise<{ exitCode: number | null; out: string }> {
  const lines: string[] = []
  let exitCode: number | null = null
  const sinks = (['log', 'error', 'warn'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a) => {
      lines.push(a.join(' '))
    })
  )
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    exitCode = typeof code === 'number' ? code : null
    throw new Error(`process.exit(${code})`)
  })
  try {
    await createPinCommand().parseAsync(['node', 'test', 'commit-helper'])
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.startsWith('process.exit')) throw e
  } finally {
    sinks.forEach((s) => s.mockRestore())
    exitSpy.mockRestore()
  }
  return { exitCode, out: lines.join('\n') }
}

function seed(text: string): Buffer {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
  writeFileSync(MANIFEST_PATH, text)
  return readFileSync(MANIFEST_PATH)
}

describe('T-S: skillsmith pin leaves a bad manifest byte-identical (SMI-6358)', () => {
  beforeEach(() => {
    inject.target = MANIFEST_PATH
    inject.mode = 'off'
    inject.passFirst = 0
    inject.seen = 0
    inject.injected = 0
  })

  afterEach(() => {
    inject.target = null
    inject.mode = 'off'
    for (const p of [MANIFEST_PATH, `${MANIFEST_PATH}.lock`]) {
      if (existsSync(p)) rmSync(p, { force: true })
    }
  })

  it('POSITIVE CONTROL: with a valid manifest, pin DOES rewrite the file', async () => {
    const before = seed(validManifestText())

    const { exitCode, out } = await runPin()

    expect(exitCode).toBeNull()
    expect(out).toContain('Pinned commit-helper')
    const after = readFileSync(MANIFEST_PATH)
    expect(after.equals(before)).toBe(false)
    const parsed = JSON.parse(after.toString('utf-8')) as {
      installedSkills: Record<string, { pinnedVersion?: string }>
    }
    expect(parsed.installedSkills['commit-helper']?.pinnedVersion).toBe(FULL_HASH.slice(0, 8))
    // The injector was armed but off: it saw reads and injected nothing.
    expect(inject.seen).toBeGreaterThan(0)
    expect(inject.injected).toBe(0)
  })

  it('EACCES on reading the manifest: pin fails and the file is byte-identical', async () => {
    const before = seed(validManifestText())
    inject.mode = 'eacces'

    const { exitCode, out } = await runPin()

    // The injection really fired on the manifest path (never-ran guard).
    expect(inject.injected).toBeGreaterThan(0)
    // Bytes first: a writer that saved after a failed load fails HERE.
    expect(readFileSync(MANIFEST_PATH).equals(before)).toBe(true)
    expect(exitCode).toBe(1)
    expect(out).not.toContain('Pinned commit-helper')
  })

  it('corrupt JSON in the manifest: pin fails and the file is byte-identical', async () => {
    const before = seed(CORRUPT_TEXT)

    const { exitCode, out } = await runPin()

    expect(readFileSync(MANIFEST_PATH).equals(before)).toBe(true)
    expect(exitCode).toBe(1)
    expect(out).not.toContain('Pinned commit-helper')
  })

  describe("inner layer (file goes bad AFTER pin's lenient peek, before its locked write)", () => {
    it('EACCES on the locked read: updateManifestEntry refuses and the file is byte-identical', async () => {
      const before = seed(validManifestText())
      inject.mode = 'eacces'
      inject.passFirst = 1 // pin's own loadManifest() peek succeeds

      const { exitCode, out } = await runPin()

      expect(inject.seen).toBeGreaterThanOrEqual(2)
      expect(inject.injected).toBeGreaterThan(0)
      expect(readFileSync(MANIFEST_PATH).equals(before)).toBe(true)
      expect(exitCode).toBe(1)
      expect(out).toContain('EACCES')
      expect(out).not.toContain('Pinned commit-helper')
    })

    it('corrupt JSON on the locked read: updateManifestEntry refuses and the file is byte-identical', async () => {
      const before = seed(validManifestText())
      inject.mode = 'garbage'
      inject.passFirst = 1

      const { exitCode, out } = await runPin()

      expect(inject.seen).toBeGreaterThanOrEqual(2)
      expect(inject.injected).toBeGreaterThan(0)
      expect(readFileSync(MANIFEST_PATH).equals(before)).toBe(true)
      expect(exitCode).toBe(1)
      expect(out).not.toContain('Pinned commit-helper')
    })
  })
})

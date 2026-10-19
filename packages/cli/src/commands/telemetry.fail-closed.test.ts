/**
 * @fileoverview T-S (telemetry enable): `skillsmith telemetry enable` must leave
 * an unreadable or corrupt manifest byte-identical.
 * @see SMI-6358 fail-closed reads; acceptance test T-S in
 *   docs/internal/implementation/update-safety-and-source-resolution.md
 *
 * Real writer, real manifest file. `runEnable` peeks with the lenient cli
 * `loadManifest()` (which returns an empty, telemetry-disabled manifest on ANY
 * error), so on a bad file it proceeds to `updateManifestEntry` ->
 * core `ManifestManager.updateSafely` -> `loadManifestForWrite`, which must
 * refuse. That refusal is the guard under test; unlike `pin`, nothing earlier
 * masks it.
 *
 * Tests run as root, so `chmod 0o000` would not deny the read. EACCES is
 * injected at `fs/promises.readFile` for exactly the manifest path; every other
 * path passes through. The injection counter is asserted so a seam that never
 * fired cannot pass silently.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

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

import { runEnable, telemetryEnableAction } from './telemetry.action.js'
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
        },
      },
      telemetry: { enabled: false },
    },
    null,
    2
  )
}

const CORRUPT_TEXT =
  '{"version":"1.0.0","installedSkills":{"commit-helper":{"id":"anthropic/commit-hel'

function seed(text: string): Buffer {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
  writeFileSync(MANIFEST_PATH, text)
  return readFileSync(MANIFEST_PATH)
}

/** Run the wrapped CLI action with console + process.exit captured. */
async function runAction(): Promise<{ exitCode: number | null; out: string }> {
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
    await telemetryEnableAction()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.startsWith('process.exit')) throw e
  } finally {
    sinks.forEach((s) => s.mockRestore())
    exitSpy.mockRestore()
  }
  return { exitCode, out: lines.join('\n') }
}

describe('T-S: skillsmith telemetry enable leaves a bad manifest byte-identical (SMI-6358)', () => {
  beforeEach(() => {
    inject.target = MANIFEST_PATH
    inject.eacces = false
    inject.seen = 0
    inject.injected = 0
  })

  afterEach(() => {
    inject.target = null
    inject.eacces = false
    for (const p of [MANIFEST_PATH, `${MANIFEST_PATH}.lock`]) {
      if (existsSync(p)) rmSync(p, { force: true })
    }
  })

  it('POSITIVE CONTROL: with a valid manifest, enable DOES rewrite the file', async () => {
    const before = seed(validManifestText())
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await runEnable()
    } finally {
      logSpy.mockRestore()
    }

    const after = readFileSync(MANIFEST_PATH)
    expect(after.equals(before)).toBe(false)
    const parsed = JSON.parse(after.toString('utf-8')) as {
      installedSkills: Record<string, unknown>
      telemetry: { enabled: boolean; anonymousId?: string }
    }
    expect(parsed.telemetry.enabled).toBe(true)
    expect(parsed.telemetry.anonymousId).toMatch(/^[0-9a-f]{64}$/)
    // The pre-existing entry survived the rewrite.
    expect(Object.keys(parsed.installedSkills)).toEqual(['commit-helper'])
    expect(inject.seen).toBeGreaterThan(0)
    expect(inject.injected).toBe(0)
  })

  it('EACCES on reading the manifest: enable refuses and the file is byte-identical', async () => {
    const before = seed(validManifestText())
    inject.eacces = true

    const settled = await runEnable().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    )

    // Never-ran guard: the injection fired on the manifest path, at least once
    // for the lenient peek and once for the locked read.
    expect(inject.injected).toBeGreaterThanOrEqual(2)
    // Bytes first: a writer that saved after a failed load fails HERE.
    expect(readFileSync(MANIFEST_PATH).equals(before)).toBe(true)
    expect(settled).toMatchObject({ ok: false, error: { name: 'ManifestUnwritableError' } })
  })

  it('corrupt JSON in the manifest: enable refuses and the file is byte-identical', async () => {
    const before = seed(CORRUPT_TEXT)

    const settled = await runEnable().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    )

    // Bytes first: a writer that saved after a failed load fails HERE.
    expect(readFileSync(MANIFEST_PATH).equals(before)).toBe(true)
    expect(settled).toMatchObject({ ok: false, error: { name: 'ManifestUnwritableError' } })
  })

  it('the CLI action reports failure (exit 1, no "Telemetry enabled.") for both states', async () => {
    for (const state of ['eacces', 'corrupt'] as const) {
      const before = seed(state === 'corrupt' ? CORRUPT_TEXT : validManifestText())
      inject.eacces = state === 'eacces'
      inject.injected = 0

      const { exitCode, out } = await runAction()

      expect(exitCode, state).toBe(1)
      expect(out, state).not.toContain('Telemetry enabled.')
      if (state === 'eacces') expect(inject.injected).toBeGreaterThan(0)
      expect(readFileSync(MANIFEST_PATH).equals(before), state).toBe(true)
    }
  })
})

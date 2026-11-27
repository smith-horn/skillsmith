/**
 * SMI-7271: the WASM read-only remedy follows how the native driver failed.
 *
 * The CLI pins better-sqlite3 13.0.3, which ships prebuilt binaries and has no
 * install script, so "rebuild it / reinstall with install scripts enabled" does
 * nothing for a CLI install that skipped the optional dependency. The remedy is
 * therefore chosen from the measured load failure, not from which package
 * bundled core.
 *
 * The error shapes in the classification table were measured in the dev
 * container against better-sqlite3 11.10.0 and 13.0.3 (absent package, corrupt
 * binary, no prebuilt binary for the platform, missing build dir, missing
 * `bindings` dependency); the first line of each message is copied verbatim.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeLoadFailureKind } from '../../src/db/drivers/betterSqlite3Driver.js'

const failure = vi.hoisted(() => ({
  kind: undefined as NativeLoadFailureKind | undefined,
}))

vi.mock('../../src/db/drivers/betterSqlite3Driver.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/db/drivers/betterSqlite3Driver.js')>()
  return { ...actual, getBetterSqlite3FailureKind: () => failure.kind }
})

import { classifyNativeLoadFailure } from '../../src/db/drivers/betterSqlite3Driver.js'
import { wasmOpenNotice, wasmReadOnlyError } from '../../src/db/wasm-read-only.js'

afterEach(() => {
  failure.kind = undefined
  vi.unstubAllEnvs()
})

function loadError(message: string, code?: string): Error {
  const error = new Error(message) as Error & { code?: string }
  if (code !== undefined) error.code = code
  return error
}

describe('SMI-7271: classifyNativeLoadFailure', () => {
  const cases: Array<[string, Error | string, NativeLoadFailureKind]> = [
    [
      'package absent (--omit=optional)',
      loadError(
        "Cannot find module 'better-sqlite3'\nRequire stack:\n- /x/probe.js",
        'MODULE_NOT_FOUND'
      ),
      'not-installed',
    ],
    [
      '13.x with no prebuilt binary for the platform',
      loadError(
        "Cannot find module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
        'MODULE_NOT_FOUND'
      ),
      'no-prebuilt',
    ],
    [
      'the 13.x fallback path without a code',
      loadError("Cannot find module '/x/build/Release/better_sqlite3.node'"),
      'load-failed',
    ],
    [
      'missing bindings dependency',
      loadError(
        "Cannot find module 'bindings'\nRequire stack:\n- /x/lib/database.js",
        'MODULE_NOT_FOUND'
      ),
      'load-failed',
    ],
    [
      'corrupt binary',
      loadError('/x/better_sqlite3.node: file too short', 'ERR_DLOPEN_FAILED'),
      'load-failed',
    ],
    [
      'ABI mismatch',
      loadError(
        "The module '/x/better_sqlite3.node' was compiled against a different Node.js version " +
          'using NODE_MODULE_VERSION 115.',
        'ERR_DLOPEN_FAILED'
      ),
      'load-failed',
    ],
    [
      'missing build dir (11.x/12.x bindings)',
      loadError('Could not locate the bindings file. Tried:\n → /x/build/better_sqlite3.node'),
      'load-failed',
    ],
    // The package name alone is not enough: Node always sets the code.
    ['same text, no code', loadError("Cannot find module 'better-sqlite3'"), 'load-failed'],
    ['a non-Error throw', "Cannot find module 'better-sqlite3'", 'load-failed'],
  ]

  it.each(cases)('%s', (_label, error, expected) => {
    expect(classifyNativeLoadFailure(error)).toBe(expected)
  })
})

describe('SMI-7271: the remedy names the fix for the measured failure', () => {
  const path = '/home/u/.skillsmith/skills.db'
  const surfaces = [
    ['existing-file notice', () => wasmOpenNotice(path, 'existing')],
    ['first-run notice', () => wasmOpenNotice(path, 'first-run')],
    ['write refusal', () => wasmReadOnlyError(path).message],
  ] as const

  describe.each(surfaces)('%s', (_label, render) => {
    it('package not installed: reinstall with optional dependencies, never a rebuild', () => {
      failure.kind = 'not-installed'
      const text = render()
      expect(text).toContain('better-sqlite3 is not installed')
      expect(text).toContain('without --omit=optional')
      expect(text).not.toContain('npm rebuild')
      expect(text).not.toContain('install scripts')
    })

    it('package present but failed to load: rebuild or reinstall with install scripts', () => {
      failure.kind = 'load-failed'
      const text = render()
      expect(text).toContain('npm rebuild better-sqlite3')
      expect(text).toContain('install scripts enabled')
      expect(text).toContain('SKILLSMITH_DEBUG=1')
      expect(text).not.toContain('--omit=optional')
    })

    it('no prebuilt binary for the platform: names it and the supported ones, never a rebuild', () => {
      failure.kind = 'no-prebuilt'
      const text = render()
      expect(text).toContain(`for this platform (${process.platform}-${process.arch})`)
      expect(text).toContain('darwin, linux, linuxmusl and win32, on x64 or arm64')
      expect(text).toContain('reads but cannot save')
      expect(text).toContain('SKILLSMITH_DEBUG=1')
      expect(text).not.toContain('npm rebuild')
      expect(text).not.toContain('install scripts')
      expect(text).not.toContain('--omit=optional')
    })

    it('load never attempted: one text that covers both installs', () => {
      failure.kind = undefined
      const text = render()
      expect(text).toContain('optional dependencies')
      expect(text).toContain('install scripts enabled')
      expect(text).toContain('npm rebuild better-sqlite3')
    })

    it('SKILLSMITH_FORCE_WASM: names the variable, whatever the load failure', () => {
      vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
      failure.kind = 'not-installed'
      const text = render()
      expect(text).toContain('Unset SKILLSMITH_FORCE_WASM')
      expect(text).not.toContain('--omit=optional')
      expect(text).not.toContain('npm rebuild')
    })
  })
})

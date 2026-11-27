/**
 * SMI-7271: `isBetterSqlite3Available` records the kind of a load failure, and
 * clears it on a successful load, so the WASM notice picks the right remedy.
 *
 * The driver loads better-sqlite3 through `createRequire`, which `vi.mock` does
 * not intercept, so this spies on Node's own `Module._load` for the one
 * request and throws the error Node throws for an absent package.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import Module from 'node:module'
import {
  getBetterSqlite3FailureKind,
  isBetterSqlite3Available,
} from '../../src/db/drivers/betterSqlite3Driver.js'
import { wasmOpenNotice } from '../../src/db/wasm-read-only.js'

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown
const moduleWithLoad = Module as unknown as { _load: Loader }

afterEach(() => {
  vi.restoreAllMocks()
})

function failLoad(error: Error): void {
  const real = moduleWithLoad._load
  vi.spyOn(moduleWithLoad, '_load').mockImplementation(function (
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean
  ) {
    if (request === 'better-sqlite3') throw error
    return real.call(this, request, parent, isMain)
  })
}

function nodeError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('SMI-7271: the recorded load-failure kind', () => {
  it('an absent package records not-installed; a later successful load clears it', () => {
    failLoad(
      nodeError("Cannot find module 'better-sqlite3'\nRequire stack:\n- /x", 'MODULE_NOT_FOUND')
    )
    expect(isBetterSqlite3Available()).toBe(false)
    expect(getBetterSqlite3FailureKind()).toBe('not-installed')

    vi.restoreAllMocks()
    // The dev container has a working native driver: the load succeeds.
    expect(isBetterSqlite3Available()).toBe(true)
    expect(getBetterSqlite3FailureKind()).toBeUndefined()
  })

  it('13.x with no prebuilt binary records no-prebuilt, and the notice names the platform', () => {
    // The error better-sqlite3 13.0.3 threw in the container with its prebuilds removed.
    failLoad(
      nodeError(
        "Cannot find module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
        'MODULE_NOT_FOUND'
      )
    )
    expect(isBetterSqlite3Available()).toBe(false)
    expect(getBetterSqlite3FailureKind()).toBe('no-prebuilt')
    const notice = wasmOpenNotice('/home/u/.skillsmith/skills.db', 'existing')
    expect(notice).toContain(`(${process.platform}-${process.arch})`)
    expect(notice).not.toContain('npm rebuild')
  })

  it('a binary that fails to load records load-failed', () => {
    failLoad(nodeError('/x/better_sqlite3.node: file too short', 'ERR_DLOPEN_FAILED'))
    expect(isBetterSqlite3Available()).toBe(false)
    expect(getBetterSqlite3FailureKind()).toBe('load-failed')
  })
})

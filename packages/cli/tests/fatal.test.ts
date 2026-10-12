/**
 * @fileoverview The CLI's last-resort error renderer.
 * @see SMI-6961 review finding F6.
 *
 * The defect: `program.parse()` does not await an async action's promise, so a
 * rejection escaped to Node, which printed the raw message plus a stack. That
 * route never reached `sanitizeError`, so a corrupt database on
 * `skillsmith search` printed `/Users/<name>/.skillsmith/skills.db` verbatim —
 * the exact disclosure `sanitize.ts` exists to prevent. It became reachable
 * when SMI-6961 stopped the opener swallowing corruption refusals.
 *
 * These assert the PROPERTY that makes the fix correct — the absolute path is
 * gone and the tilde form is present — rather than the exact string a correct
 * implementation happens to emit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renderFatal, installFatalHandler } from '../src/utils/fatal.js'

const DB_PATH = join(homedir(), '.skillsmith', 'skills.db')

describe('SMI-6961 F6: renderFatal sanitizes an escaped error', () => {
  it('replaces the absolute home path with ~', () => {
    const rendered = renderFatal(new Error(`The local database at ${DB_PATH} is corrupt`))

    // The absence assertion, and its paired presence assertion from the SAME
    // execution — without the second, a renderer that returned '' would pass.
    expect(rendered).not.toContain(homedir())
    expect(rendered).toContain('~/.skillsmith/skills.db')
  })

  it('drops the stack', () => {
    // A stack is the wrong thing to show for an expected-but-fatal condition,
    // and it carries paths the sanitizer does not reach.
    const error = new Error('boom')
    expect(error.stack).toBeTruthy()
    expect(renderFatal(error)).not.toContain('at ')
  })

  it('handles a non-Error rejection without throwing', () => {
    // `unhandledRejection` can carry any value, including a string or null.
    expect(() => renderFatal('a bare string')).not.toThrow()
    expect(() => renderFatal(null)).not.toThrow()
    expect(() => renderFatal(undefined)).not.toThrow()
  })

  it('the home-path matcher discriminates — known-positive and known-negative', () => {
    // Guards against the whole suite being vacuous: if `homedir()` returned ''
    // then `not.toContain('')` would fail, and if the matcher were wrong the
    // first test would pass for any input.
    expect(homedir()).not.toBe('')
    expect(`a ${homedir()} b`).toContain(homedir())
    expect('~/.skillsmith/skills.db').not.toContain(homedir())
  })
})

describe('SMI-6961 F6: installFatalHandler routes a rejection through the renderer', () => {
  const installed: Array<(error: unknown) => void> = []
  const originalExitCode = process.exitCode

  afterEach(() => {
    for (const handler of installed) {
      process.off('unhandledRejection', handler)
      process.off('uncaughtException', handler)
    }
    installed.length = 0
    process.exitCode = originalExitCode
  })

  it('writes the sanitized text and sets exit code 1', () => {
    const write = vi.fn()
    const handler = installFatalHandler(write)
    installed.push(handler)

    handler(new Error(`The local database at ${DB_PATH} is corrupt and cannot be read`))

    expect(write).toHaveBeenCalledTimes(1)
    const written = write.mock.calls[0]?.[0] as string
    expect(written).not.toContain(homedir())
    expect(written).toContain('~/.skillsmith/skills.db')
    expect(written.endsWith('\n')).toBe(true)
    expect(process.exitCode).toBe(1)
  })

  it('registers for BOTH unhandledRejection and uncaughtException', () => {
    // `parseAsync` makes a rejected action an unhandledRejection, but a sync
    // throw outside any action is an uncaughtException. Both must be sanitized;
    // asserting only one would leave the other leaking.
    const before = {
      rejection: process.listenerCount('unhandledRejection'),
      exception: process.listenerCount('uncaughtException'),
    }
    const handler = installFatalHandler(vi.fn())
    installed.push(handler)

    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection + 1)
    expect(process.listenerCount('uncaughtException')).toBe(before.exception + 1)
  })

  it('does not set an exit code until the handler actually fires — the control', () => {
    // Without this, a handler that set exitCode = 1 at INSTALL time would
    // satisfy the arm above while breaking every successful command.
    process.exitCode = 0
    const handler = installFatalHandler(vi.fn())
    installed.push(handler)

    expect(process.exitCode).toBe(0)
  })
})

/**
 * SMI-7271: `nativeDriverAdvice()` describes the better-sqlite3 that its OWN
 * module would load, not whatever `process.cwd()` resolves to. In the CLI's
 * bundle those differ (the bundle carries its own copy), and a cwd-based
 * lookup would describe some other package entirely.
 *
 * The advice kind alone cannot tell the two apart here: both packages this
 * monorepo resolves build from source, so both say `rebuild`. So this pins
 * the identity of the manifest the advice read, against a control proving the
 * two resolution bases really do reach different packages.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nativeDriverAdvice } from '../../src/db/drivers/native-driver-advice.js'

const MODULE_URL = new URL('../../src/db/drivers/native-driver-advice.ts', import.meta.url)

describe('SMI-7271: nativeDriverAdvice resolves from its own module', () => {
  it('reads the manifest its module resolves, not the one cwd resolves', () => {
    const expected = createRequire(MODULE_URL).resolve('better-sqlite3/package.json')
    const cwdResolved = createRequire(join(process.cwd(), 'noop.js')).resolve(
      'better-sqlite3/package.json'
    )
    // Control: if both bases reach the same package, this test cannot tell a
    // cwd-based lookup from the right one, so it must fail rather than pass.
    expect(cwdResolved).not.toBe(expected)

    const advice = nativeDriverAdvice()
    expect(advice.kind).not.toBe('not-installed')
    expect('manifest' in advice ? advice.manifest : undefined).toBe(expected)
  })
})

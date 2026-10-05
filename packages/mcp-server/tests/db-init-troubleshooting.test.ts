/**
 * @fileoverview The MCP server's database-init troubleshooting block.
 * @see SMI-6991, found in the post-merge retro of SMI-6961 (PR #3008).
 *
 * The defect: the init catch printed one fixed block for every failure, ending
 * with *"Set SKILLSMITH_FORCE_WASM=true to use the WASM SQLite fallback"*. That
 * is advice about driver **availability**. After SMI-6961 both drivers refuse
 * the same corrupt file, so for a corruption refusal it is a dead end — and it
 * only ever appeared to help because the WASM driver destroyed the file.
 *
 * This is the npx path, where WASM is already the default driver, so the user
 * was being told to switch to the driver they were already using.
 */
import { describe, it, expect } from 'vitest'
import { CorruptDatabaseError } from '@skillsmith/core'
import { troubleshootingFor, formatDbInitFailure } from '../src/db-init-troubleshooting.js'

const FORCE_WASM = 'SKILLSMITH_FORCE_WASM'

function refusal(): CorruptDatabaseError {
  return new CorruptDatabaseError({
    message: '[Skillsmith] The local database at /tmp/x/skills.db is corrupt and cannot be read: v',
    path: '/tmp/x/skills.db',
    verdict: 'v',
    remedyKind: 'replace',
  })
}

describe('SMI-6991: a corruption refusal is not followed by driver-switch advice', () => {
  it('omits the troubleshooting block entirely for a corruption refusal', () => {
    // Absence assertion, with its paired presence assertion in the control
    // below — on its own, a function that returned null for everything would
    // satisfy this.
    expect(troubleshootingFor(refusal())).toBeNull()
  })

  it('still offers availability advice for every OTHER failure — the control', () => {
    // This is what makes the arm above meaningful. It also pins the thing the
    // block is actually for: a driver that will not load.
    const generic = troubleshootingFor(new Error('Cannot find module better_sqlite3.node'))
    expect(generic).not.toBeNull()
    expect(generic).toContain(FORCE_WASM)
  })

  it('never emits the FORCE_WASM line in a rendered refusal, but does otherwise', () => {
    // Asserted on the RENDERED text, because that is what a user reads. A
    // caller mishandling the null case would print the literal "null" here.
    const onRefusal = formatDbInitFailure('detail', refusal())
    expect(onRefusal).not.toContain(FORCE_WASM)
    expect(onRefusal).not.toContain('null')
    expect(onRefusal).not.toContain('Troubleshooting:')
    expect(onRefusal).toContain('detail')

    const onOther = formatDbInitFailure('detail', new Error('ABI mismatch'))
    expect(onOther).toContain(FORCE_WASM)
    expect(onOther).toContain('Troubleshooting:')
  })

  it('discriminates on code, not on message text or identity', () => {
    // A plain Error carrying the refusal's own words must NOT be treated as a
    // refusal — matching on prose is what ADR-175 retired. And a structurally
    // identical object from a duplicate copy of @skillsmith/core would fail an
    // `instanceof` check, which is why the predicate reads `code`.
    const lookalike = new Error(
      '[Skillsmith] The local database at /tmp/x/skills.db is corrupt and cannot be read: v'
    )
    expect(troubleshootingFor(lookalike)).not.toBeNull()

    const duck = Object.assign(new Error('corrupt'), { code: 'SKILLSMITH_DB_CORRUPT' })
    expect(troubleshootingFor(duck)).toBeNull()
  })

  it('tolerates a non-Error without throwing', () => {
    expect(() => troubleshootingFor('a string')).not.toThrow()
    expect(() => troubleshootingFor(null)).not.toThrow()
    expect(troubleshootingFor(undefined)).not.toBeNull()
  })
})

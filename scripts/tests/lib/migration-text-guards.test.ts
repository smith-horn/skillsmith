/**
 * @fileoverview SMI-6690 — direct tests for `readMigrationText`'s git-crypt lock contract.
 *
 * `scripts/tests/lib/migration-text-guards.ts` is shared by four files and owns the
 * SMI-5984 three-way lock contract, but had no tests of its own — its behaviour was
 * exercised only incidentally, through consumer suites that each assert something else.
 * This file tests the contract directly, against fixtures it builds itself, so every arm
 * runs whichever lock state this checkout happens to be in.
 *
 * The contract, and why the third arm matters: an UNDECLARED lock must throw. Reporting
 * "locked" there converts a real unlock failure into a clean scan over unreadable files —
 * a pass that means nothing, which is the defect class SMI-6690 exists to remove.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMigrationText } from './migration-text-guards.ts'

// "\x00GITCRYPT" — the 9-byte magic header git-crypt writes ahead of ciphertext.
const MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])
const ENV_VAR = 'SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED'
const FILE = '20260101000000_fixture.sql'
const PLAINTEXT = '-- plaintext fixture\nSELECT 1;\n'

// Directories `fixtureDir` creates below, removed in `afterEach` rather than left on disk (SMI-6690
// finding F7) — one per call, unbounded over time otherwise.
const tempDirs: string[] = []

function fixtureDir(contents: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'smi6690-guards-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, FILE), contents)
  return dir
}

/** Restores the caller's own env either way, so these never leak into sibling suites. */
function withExpectLocked<T>(declared: boolean, fn: () => T): T {
  const prior = process.env[ENV_VAR]
  if (declared) process.env[ENV_VAR] = '1'
  else delete process.env[ENV_VAR]
  try {
    return fn()
  } finally {
    if (prior === undefined) delete process.env[ENV_VAR]
    else process.env[ENV_VAR] = prior
  }
}

describe('SMI-5984 — readMigrationText resolves all three git-crypt lock states', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('unlocked: returns the file text verbatim', () => {
    const dir = fixtureDir(PLAINTEXT)
    expect(withExpectLocked(false, () => readMigrationText(FILE, dir))).toBe(PLAINTEXT)
  })

  it('locked AND declared: returns null, so a caller can stand down cleanly', () => {
    const dir = fixtureDir(Buffer.concat([MAGIC, Buffer.from('ciphertext')]))
    expect(withExpectLocked(true, () => readMigrationText(FILE, dir))).toBeNull()
  })

  it('locked but UNDECLARED: throws rather than returning null', () => {
    const dir = fixtureDir(Buffer.concat([MAGIC, Buffer.from('ciphertext')]))
    // Mutation-tested: collapsing the contract to two-way (undeclared lock returns null)
    // fails this assertion and only this one, so it constrains the behaviour rather than
    // merely exercising it (SMI-6690).
    expect(() => withExpectLocked(false, () => readMigrationText(FILE, dir))).toThrow(
      /git-crypt-locked/
    )
  })

  it('a genuinely missing file throws ENOENT — it is never reported as locked', () => {
    const dir = fixtureDir(PLAINTEXT)
    let code: string | undefined
    try {
      withExpectLocked(true, () => readMigrationText('does-not-exist.sql', dir))
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code
    }
    // Declared-locked is set above precisely so a "locked" misread would return null and
    // leave `code` undefined — this distinguishes absent from encrypted.
    expect(code).toBe('ENOENT')
  })

  // THE NEXT TWO PIN THE WIDTH OF THE MAGIC, and without them the suite cannot (SMI-6690).
  // Every other fixture here is either NUL-prefixed AND genuinely ciphertext, or not NUL-prefixed
  // at all — so a guard checking only `raw[0] === 0x00` instead of all nine bytes passes all of
  // them. Measured: that exact one-byte mutation passed the whole 67-test suite. The consequence
  // is the invisible-success shape this module exists to remove — a binary or NUL-prefixed
  // PLAINTEXT migration would read as ciphertext and, on a declared-locked run, return null: a
  // clean stand-down over a readable file. Declared-locked is set in both, so a misread returns
  // null rather than throwing, and the assertion sees it.
  it('a NUL-prefixed file that is NOT git-crypt ciphertext is read, not reported as locked', () => {
    const body = Buffer.concat([Buffer.from([0x00]), Buffer.from('not git-crypt\n')])
    const dir = fixtureDir(body)
    expect(withExpectLocked(true, () => readMigrationText(FILE, dir))).toBe(body.toString('utf8'))
  })

  it('a near-miss magic is read, not reported as locked', () => {
    // "\x00GITCRYPX" — right length, right shape, final byte wrong. Pins the boundary the case
    // above leaves open: a prefix-length check that stops short would still accept this.
    const dir = fixtureDir(Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x58]))
    expect(withExpectLocked(true, () => readMigrationText(FILE, dir))).not.toBeNull()
  })
})

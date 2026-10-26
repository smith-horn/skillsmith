/**
 * audit-standards.mjs AUDIT_SUMMARY_FILE (SMI-7174): the CI report takes its counts from
 * this file, never from log text. These run the real full audit on this checkout.
 *
 * T4  the file's counts equal the Summary block the same run printed (this also pins
 *     the four Summary literals the parsing below relies on).
 * T5  with the variable unset, nothing is written, here or in the cwd.
 *
 * The audit runs from the repo root, not a temp dir: in an empty directory it crashes
 * long before its Summary (measured, SMI-7164), which would make T5 pass vacuously. So
 * each run also asserts it reached the Summary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtureTempDir } from './_lib/git-fixture-env'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const AUDIT = join(ROOT, 'scripts', 'audit-standards.mjs')

const runAudit = (env: Record<string, string>) => {
  const e: Record<string, string | undefined> = {
    ...process.env,
    GITHUB_BASE_REF: '',
    GITHUB_HEAD_REF: '',
    PR_BODY: '',
    ...env,
  }
  if (!('AUDIT_SUMMARY_FILE' in env)) delete e.AUDIT_SUMMARY_FILE
  return spawnSync('node', [AUDIT], { cwd: ROOT, env: e, encoding: 'utf8' }).stdout
}
// The printed Summary block, colour codes stripped.
const printed = (out: string) => {
  // eslint-disable-next-line no-control-regex -- strips the audit's own ANSI colour codes
  const plain = out.replace(/\u001b\[[0-9;]*m/g, '')
  const num = (label: string) => {
    const m = plain.match(new RegExp(`^${label}:\\s+(\\d+)%?\\s*$`, 'm'))
    return m ? Number(m[1]) : null
  }
  return {
    passed: num('Passed'),
    warnings: num('Warnings'),
    failed: num('Failed'),
    score: num('Compliance Score'),
  }
}

let dir = ''
let withFile = ''
let withoutFile = ''
const STRAY = join(ROOT, 'audit-summary.json')
beforeAll(() => {
  dir = makeFixtureTempDir('smi7174-summary-')
  rmSync(STRAY, { force: true })
  withFile = runAudit({ AUDIT_SUMMARY_FILE: join(dir, 'counts.json') })
  withoutFile = runAudit({})
}, 240_000)
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  rmSync(STRAY, { force: true })
})

describe('audit-standards AUDIT_SUMMARY_FILE', () => {
  it('T4: writes counts equal to the Summary it printed', () => {
    const want = printed(withFile)
    expect(want.passed, withFile.slice(-1500)).not.toBeNull()
    expect(want.score).not.toBeNull()
    const got = JSON.parse(readFileSync(join(dir, 'counts.json'), 'utf8'))
    expect(got).toEqual(want)
  })

  it('T5: writes nothing when the variable is unset', () => {
    expect(printed(withoutFile).passed, 'the run must reach its Summary').not.toBeNull()
    expect(existsSync(STRAY)).toBe(false)
    expect(existsSync(join(dir, 'audit-summary.json'))).toBe(false)
  })
})

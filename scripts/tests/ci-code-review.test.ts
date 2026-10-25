/**
 * scripts/ci-code-review.sh (SMI-7174): the Quality Checks audit step runs through this
 * script, so its exit code is a REQUIRED check's verdict. These run the real script with
 * a fake `npm` on PATH that prints real ANSI-coloured audit output.
 *
 * T1  the audit's exit code is the script's exit code (0 and 1).
 * T2  PR-description text echoed into the log (all four summary fields, plus a mid-line
 *     score) can't change or corrupt the report's counts.
 * T3  no counts file (the audit ended before its Summary) gives summary_found: false and
 *     summary: null, even when near-format lines are in the log.
 * T10 an invalid counts file is not trusted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtureTempDir } from './_lib/git-fixture-env'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', 'ci-code-review.sh')

// Prints what audit-standards.mjs prints at the end, with its real colour codes.
const FAKE_NPM = `#!/bin/bash
[ -n "$FAKE_EXTRA" ] && printf '%s\\n' "$FAKE_EXTRA"
if [ -z "$FAKE_NO_SUMMARY" ]; then
  printf '\\033[1m📊 Summary\\033[0m\\n\\n\\033[32mPassed:\\033[0m   93\\n\\033[33mWarnings:\\033[0m 15\\n\\033[31mFailed:\\033[0m   1\\n\\nCompliance Score: \\033[32m85%%\\033[0m\\n'
fi
[ -n "$FAKE_COUNTS" ] && [ -n "$AUDIT_SUMMARY_FILE" ] && printf '%s' "$FAKE_COUNTS" > "$AUDIT_SUMMARY_FILE"
exit "\${FAKE_EXIT:-0}"
`
const AUDIT_COUNTS = { passed: 93, warnings: 15, failed: 1, score: 85 }

let dir = ''
let n = 0
beforeAll(() => {
  dir = makeFixtureTempDir('smi7174-ccr-')
  writeFileSync(join(dir, 'npm'), FAKE_NPM, { mode: 0o755 })
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

type Report = {
  exit_code: number
  status: string
  summary_found: boolean
  summary: typeof AUDIT_COUNTS | null
  output: string
}
const run = (env: Record<string, string>) => {
  const out = join(dir, `report-${n++}.json`)
  const r = spawnSync('bash', [SCRIPT, out], {
    cwd: dir,
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, HOME: dir, CI: 'true', ...env },
    encoding: 'utf8',
  })
  const text = readFileSync(out, 'utf8')
  return { status: r.status, text, report: JSON.parse(text) as Report }
}
const counts = JSON.stringify(AUDIT_COUNTS)

describe('ci-code-review.sh', () => {
  it.each([0, 1])('T1: exits with the audit exit code (%i) and records it', (code) => {
    const r = run({ FAKE_EXIT: String(code), FAKE_COUNTS: counts })
    expect(r.status).toBe(code)
    expect(r.report.exit_code).toBe(code)
    expect(r.report.status).toBe(code === 0 ? 'passed' : 'failed')
  })

  it('T2: PR-description lines in the log do not reach the counts', () => {
    const r = run({
      FAKE_EXIT: '0',
      FAKE_COUNTS: counts,
      FAKE_EXTRA: [
        'Passed: 5',
        'Warnings: 2',
        'Failed: 7',
        'Compliance Score: 1%',
        'We kept the Compliance Score: 90% target',
      ].join('\n'),
    })
    expect(r.status).toBe(0)
    expect(r.report.summary_found).toBe(true)
    expect(r.report.summary).toEqual(AUDIT_COUNTS)
    expect(r.report.output).toContain('We kept the Compliance Score: 90% target')
  })

  it('T3: no counts file gives summary_found false and summary null, not zeros', () => {
    const r = run({
      FAKE_EXIT: '1',
      FAKE_NO_SUMMARY: '1',
      FAKE_EXTRA: ['Passed: 5 of 10', 'Passed:   5', 'Failed:   0'].join('\n'),
    })
    expect(r.status).toBe(1)
    expect(r.report.summary_found).toBe(false)
    expect(r.report.summary).toBeNull()
  })

  it('T10: a counts file of the wrong shape is not trusted', () => {
    const r = run({ FAKE_EXIT: '0', FAKE_COUNTS: '{"passed":93}' })
    expect(r.report.summary_found).toBe(false)
    expect(r.report.summary).toBeNull()
  })
})

/**
 * SMI-5513: Tests for scripts/lib/check-native-modules.sh — the container
 * native-binding health preflight.
 *
 * Driven via the SKILLSMITH_NATIVE_CHECK_TEST seam so the container probe is
 * deterministic without a real Docker container. Per the "never skipIf(inDocker)"
 * lesson (SMI-5426), this runs inside CI's in-Docker vitest and must exercise
 * the branching logic rather than no-op there.
 *
 * Cases:
 *   opt-out:      SKILLSMITH_SKIP_NATIVE_CHECK=1 wins even with a failing seam.
 *   healthy:      seam=ok → exit 0, silent.
 *   broken:       seam=fail → exit 1, actionable remedy (restart dev +
 *                 regen-lockfile + scoped opt-out), and does NOT advertise the
 *                 blanket `--no-verify` footgun (SMI-5344 consistency).
 *   source guard: no line runs `npm install` / a real `docker exec` outside a
 *                 comment/printf (READ-ONLY P-5 discipline).
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'lib', 'check-native-modules.sh')

function run(env: Record<string, string> = {}): { status: number; output: string } {
  const r = spawnSync('sh', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return { status: r.status ?? 1, output: (r.stdout ?? '') + (r.stderr ?? '') }
}

describe('check-native-modules.sh (SMI-5513)', () => {
  it('opt-out: SKILLSMITH_SKIP_NATIVE_CHECK=1 wins even over a failing seam', () => {
    const r = run({ SKILLSMITH_SKIP_NATIVE_CHECK: '1', SKILLSMITH_NATIVE_CHECK_TEST: 'fail' })
    expect(r.status).toBe(0)
    expect(r.output).toBe('')
  })

  it('healthy probe (seam=ok) exits 0 silently', () => {
    const r = run({ SKILLSMITH_NATIVE_CHECK_TEST: 'ok' })
    expect(r.status).toBe(0)
    expect(r.output).toBe('')
  })

  it('broken probe (seam=fail) exits 1 with the actionable remedy', () => {
    const r = run({ SKILLSMITH_NATIVE_CHECK_TEST: 'fail' })
    expect(r.status).toBe(1)
    expect(r.output).toMatch(/restart dev/)
    expect(r.output).toMatch(/regen-lockfile/)
    expect(r.output).toMatch(/SKILLSMITH_SKIP_NATIVE_CHECK/)
    // SMI-5344: an environmental guard must not advertise the blanket
    // `git push --no-verify` footgun — only the scoped opt-out.
    expect(r.output).not.toMatch(/--no-verify/)
  })

  it('READ-ONLY: no mutating command outside comments/printf/test-seam', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    const offenders = src.split('\n').filter((line) => {
      const t = line.trim()
      if (t.startsWith('#')) return false
      if (/^\s*printf\b/.test(line)) return false
      // The probe is a read-only `run_cmd node -e "...createDatabaseSync(':memory:')..."`
      // (opens an in-memory DB; touches nothing on disk) — allowed.
      if (/run_cmd node -e/.test(line)) return false
      return /npm\s+(install|ci|rebuild)\b|docker\s+exec\b/.test(line)
    })
    expect(offenders).toEqual([])
  })
})

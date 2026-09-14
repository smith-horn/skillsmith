/**
 * SMI-6606 / SMI-6614 (ADR-158) — tests for
 * scripts/lib/print-deps-refresh-advice.sh (T-D in the plan doc).
 *
 * Output-only script (POSIX sh) — no docker/git/npm invoked. Pins:
 *   - the numbered steps appear in order (0 through 6)
 *   - the closing "Scripted, locked version tracked in SMI-6627" line
 *   - no line matches a bare `npm install` (the trap this plan removes)
 *   - no line is a bare `docker compose --profile dev up -d` (SMI-4298) —
 *     the step-0 recreate command legitimately carries `--force-recreate
 *     dev`, which is NOT the bare form.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'lib', 'print-deps-refresh-advice.sh')

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', timeout: 10_000 })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('scripts/lib/print-deps-refresh-advice.sh', () => {
  it('requires the main-checkout path argument', () => {
    const r = run([])
    expect(r.status).not.toBe(0)
  })

  it('prints the numbered steps 0-6 in order', () => {
    const r = run(['/tmp/fake-main'])
    expect(r.status).toBe(0)
    const indices = [0, 1, 2, 3, 4, 5, 6].map((n) => r.stdout.indexOf(`${n}. `))
    for (const idx of indices) expect(idx).toBeGreaterThanOrEqual(0)
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1])
    }
  })

  it('closes with the SMI-6627 line', () => {
    const r = run(['/tmp/fake-main'])
    expect(r.stdout).toContain('Scripted, locked version tracked in SMI-6627.')
  })

  it('never prints a bare `npm install` line', () => {
    const r = run(['/tmp/fake-main'])
    expect(r.stdout).not.toMatch(/^\s*npm install\s*$/m)
    expect(r.stdout).not.toContain('npm install')
  })

  it('never prints a bare `docker compose --profile dev up -d` line (SMI-4298)', () => {
    const r = run(['/tmp/fake-main'])
    const lines = r.stdout.split('\n').map((l) => l.trim())
    expect(lines).not.toContain('docker compose --profile dev up -d')
    // The step-0 recreate line legitimately exists, but must carry
    // --force-recreate dev, never the bare form.
    const composeLine = lines.find((l) => l.includes('docker compose --profile dev up -d'))
    expect(composeLine).toBeDefined()
    expect(composeLine).toContain('--force-recreate dev')
  })

  it('names the given main-checkout path in every scripted step', () => {
    const r = run(['/my/main/checkout'])
    expect(r.stdout).toContain('cd "/my/main/checkout" && ./scripts/regen-lockfile.sh')
    expect(r.stdout).toContain('cd "/my/main/checkout" && ./scripts/repair-worktrees.sh')
  })
})

/**
 * SMI-7121: the busy-window CLI, driven through a child process.
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '../../indexer/backfill-busy-window.ts')

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  out: string
}

function runCli(env: Record<string, string>, useOutputFile = true): Promise<CliResult> {
  const dir = mkdtempSync(join(tmpdir(), 'busy-window-cli-'))
  const outFile = join(dir, 'github_output')
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', script], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...(useOutputFile ? { GITHUB_OUTPUT: outFile } : {}),
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => {
      let out = ''
      try {
        out = readFileSync(outFile, 'utf8')
      } catch {
        /* no output file written */
      }
      rmSync(dir, { recursive: true, force: true })
      resolve({ code, stdout, stderr, out })
    })
  })
}

describe('backfill-busy-window CLI', () => {
  it('open time: writes window_open=true and next_window_utc=now to GITHUB_OUTPUT', async () => {
    const r = await runCli({ BACKFILL_BUSY_HOURS: ' 12 13 ', NOW_UTC: '2026-10-16T10:00:00Z' })
    expect(r.code, r.stderr).toBe(0)
    expect(r.out).toBe('window_open=true\nnext_window_utc=2026-10-16T10:00:00.000Z\n')
  })

  it('closed time: writes window_open=false and the next open minute', async () => {
    const r = await runCli({ BACKFILL_BUSY_HOURS: ' 12 13 ', NOW_UTC: '2026-10-16T12:30:00Z' })
    expect(r.code, r.stderr).toBe(0)
    expect(r.out).toBe('window_open=false\nnext_window_utc=2026-10-16T14:00:00.000Z\n')
  })

  it('without GITHUB_OUTPUT it writes the same lines to stdout', async () => {
    const r = await runCli({ NOW_UTC: '2026-10-16T12:30:00Z' }, false)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toBe('window_open=false\nnext_window_utc=2026-10-16T15:00:00.000Z\n')
  })

  it('malformed BACKFILL_BUSY_HOURS exits 1 with busy_window_error and writes nothing', async () => {
    const r = await runCli({ BACKFILL_BUSY_HOURS: '1 1', NOW_UTC: '2026-10-16T12:30:00Z' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('"event":"busy_window_error"')
    expect(r.out).toBe('')
  })

  it('an invalid NOW_UTC exits 1 with busy_window_error', async () => {
    const r = await runCli({ NOW_UTC: 'not-a-date' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('busy_window_error')
    expect(r.stderr).toContain('NOW_UTC')
    expect(r.out).toBe('')
  })
})

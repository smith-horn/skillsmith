/**
 * SMI-4764 Wave 0 — Tests for signature emission in eval-runner.ts.
 *
 * Strategy: end-to-end real-mode requires the search/rerank/memory adapters
 * which aren't reachable from a unit test. We instead exercise the
 * signature-emission helper indirectly via:
 *   1. Source-level invariants (guards against accidental removal of the
 *      Wave 0 wiring during refactors).
 *   2. Format invariants (sha256 shape, FIFO trim semantics, validator-
 *      parseable line shape) — these mirror the logic inside
 *      emitBaselineSignature so the contract that the validator depends on
 *      is testable independent of the I/O.
 *
 * Wave 4's forced-regression smoke covers the producer end-to-end.
 *
 * SMI-5708 Item #4 adds direct coverage for `writeFileAtomicSync` (exercised
 * against sandbox paths -- safe to call for real) and for
 * `emitBaselineSignature`'s return value on a forced failure. The latter
 * calls the REAL `emitBaselineSignature`, whose `.signatures.log` path
 * (`SIGNATURES_LOG_PATH`) is a hardcoded, non-injectable path inside this
 * package's real, committed `eval/` directory -- NOT parameterized by any
 * test, by design (see corpus-stats.test.ts's own header comment on why it
 * mocks this function out entirely instead of calling it directly). To
 * safely test the FAILURE path without ever performing a real write to that
 * committed file, `node:fs`'s `writeFileSync` is wrapped (via
 * `importOriginal`, not replaced) so a specific test can arm exactly as many
 * one-shot throws as `emitBaselineSignature` is expected to attempt writes,
 * guaranteeing no real disk write reaches the committed file in that test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { writeFileAtomicSync, emitBaselineSignature } from '../../eval/eval-runner-signatures.js'

// Wraps (not replaces) writeFileSync/renameSync/unlinkSync so every sandbox
// fixture write and the real writeFileAtomicSync path keep working
// unmodified; only specific tests below arm one-shot (or explicitly-counted)
// throws via `mockImplementationOnce`, which revert to the real
// implementation automatically once consumed.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  }
})

const __dirname = dirname(fileURLToPath(import.meta.url))
// resolve: tests/eval -> tests -> doc-retrieval-mcp -> packages -> repo
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
// SMI-5708 Item #3: updateBaseline() (the actual emitBaselineSignature call
// site) moved from eval-runner.ts into eval-runner-baseline.ts to keep the
// parent file under the 500-line gate -- mirrors this same file's own
// SMI-4764 Wave 1 history (signature helpers out of eval-runner.ts into
// eval-runner-signatures.ts). eval-runner.ts still re-exports updateBaseline
// so `../../eval/eval-runner.js` imports are unaffected.
const EVAL_RUNNER_BASELINE = join(
  REPO_ROOT,
  'packages',
  'doc-retrieval-mcp',
  'eval',
  'eval-runner-baseline.ts'
)
const EVAL_SIGNATURES = join(
  REPO_ROOT,
  'packages',
  'doc-retrieval-mcp',
  'eval',
  'eval-runner-signatures.ts'
)

function shaOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

interface Sandbox {
  dir: string
}

let sandboxes: Sandbox[] = []

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'eval-sig-test-'))
  sandboxes.push({ dir })
  return { dir }
}

beforeEach(() => {
  sandboxes = []
})

afterEach(() => {
  for (const s of sandboxes) {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

describe('SMI-4764 Wave 0: signature emission invariants', () => {
  it('produces a sha256 of the expected hex shape', () => {
    const baselineContent = '{"prior":0.4,"current":0.42}\n'
    const expectedSha = shaOf(baselineContent)
    expect(expectedSha).toMatch(/^[a-f0-9]{64}$/)
  })

  it('per-developer marker filename uses the 8-char baseline sha prefix', () => {
    const baselineContent = '{"current":0.42}\n'
    const sha = shaOf(baselineContent)
    const shortSha = sha.slice(0, 8)
    expect(shortSha).toHaveLength(8)
    // Filename convention: <short>.sig
    expect(`${shortSha}.sig`).toMatch(/^[a-f0-9]{8}\.sig$/)
  })

  it('eval-runner-signatures.ts contains the signature-emission wiring', () => {
    // Guard against accidental removal of the Wave 0 wiring during refactors.
    // SMI-4764 Wave 1: helpers moved out of eval-runner.ts into
    // eval-runner-signatures.ts to keep the parent file under the 500-line gate.
    const sigSrc = readFileSync(EVAL_SIGNATURES, 'utf8')
    expect(sigSrc).toContain('emitBaselineSignature')
    expect(sigSrc).toContain('.signatures.log')
    expect(sigSrc).toContain('.skillsmith')
    expect(sigSrc).toContain('eval-signatures')
    expect(sigSrc).toContain('SIGNATURE_LOG_MAX_LINES')
    expect(sigSrc).toContain('createHash')
    // updateBaseline() (eval-runner-baseline.ts as of SMI-5708 Item #3) must
    // still import + invoke the helper.
    const runnerBaselineSrc = readFileSync(EVAL_RUNNER_BASELINE, 'utf8')
    expect(runnerBaselineSrc).toContain("from './eval-runner-signatures.js'")
    expect(runnerBaselineSrc).toContain('emitBaselineSignature(serialized)')
  })

  it('FIFO trim retains exactly the last 15 entries (cap matches SIGNATURE_LOG_MAX_LINES)', () => {
    // Mirrors the trim step inside emitBaselineSignature so the cap is
    // testable independent of the I/O.
    const lines: string[] = []
    for (let i = 0; i < 50; i++) lines.push(`line-${i}`)
    const trimmed = lines.slice(-15)
    expect(trimmed.length).toBe(15)
    expect(trimmed[0]).toBe('line-35')
    expect(trimmed[14]).toBe('line-49')
  })

  it('appends new line and trims to last 15 in correct order', () => {
    const seedLines: string[] = []
    for (let i = 0; i < 20; i++) {
      seedLines.push(`${'0'.repeat(64)}\t${new Date(Date.now() - i * 1000).toISOString()}\tabc${i}`)
    }
    const newLine = `${shaOf('x')}\t${new Date().toISOString()}\tdef`
    seedLines.push(newLine)
    const trimmed = seedLines.slice(-15)
    expect(trimmed.length).toBe(15)
    expect(trimmed[trimmed.length - 1]).toBe(newLine)
  })
})

describe('SMI-4764 Wave 0: log file format', () => {
  it('parses the validator-expected format (sha\\ttimestamp\\thead)', () => {
    const sandbox = makeSandbox()
    const logPath = join(sandbox.dir, 'signatures.log')
    const sha = shaOf('{"current":0.5}\n')
    const ts = new Date().toISOString()
    const head = '0123456789abcdef0123456789abcdef01234567'
    const line = `${sha}\t${ts}\t${head}`
    writeFileSync(logPath, line + '\n')

    const raw = readFileSync(logPath, 'utf8')
    const parsedLines = raw.split('\n').filter((l) => l.length > 0)
    expect(parsedLines).toHaveLength(1)
    const [parsedSha, parsedTs, parsedHead] = parsedLines[0].split('\t')
    expect(parsedSha).toBe(sha)
    expect(parsedTs).toBe(ts)
    expect(parsedHead).toBe(head)
    expect(Date.parse(parsedTs)).not.toBeNaN()
  })
})

describe('writeFileAtomicSync (SMI-5708 Item #4)', () => {
  it('writes the exact content and leaves no temp file behind (happy path)', () => {
    const sandbox = makeSandbox()
    const targetPath = join(sandbox.dir, 'out.json')
    const content = '{"a":1}\n'

    writeFileAtomicSync(targetPath, content)

    expect(readFileSync(targetPath, 'utf8')).toBe(content)
    expect(readdirSync(sandbox.dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a failed temp-file write leaves a pre-existing target untouched and no stray temp file', () => {
    const sandbox = makeSandbox()
    const targetPath = join(sandbox.dir, 'out.json')
    writeFileSync(targetPath, 'ORIGINAL\n', 'utf8')

    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('simulated write failure')
    })

    expect(() => writeFileAtomicSync(targetPath, 'NEW\n')).toThrow(/simulated write failure/)
    expect(readFileSync(targetPath, 'utf8')).toBe('ORIGINAL\n')
    expect(readdirSync(sandbox.dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a failed temp-file write when the target does not yet exist creates nothing (no partial first-run file)', () => {
    const sandbox = makeSandbox()
    const targetPath = join(sandbox.dir, 'first-run.json')

    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('simulated write failure')
    })

    expect(() => writeFileAtomicSync(targetPath, 'NEW\n')).toThrow(/simulated write failure/)
    expect(existsSync(targetPath)).toBe(false)
    expect(readdirSync(sandbox.dir)).toEqual([])
  })

  it('a failed rename leaves a pre-existing target untouched and cleans up the temp file', () => {
    const sandbox = makeSandbox()
    const targetPath = join(sandbox.dir, 'out.json')
    writeFileSync(targetPath, 'ORIGINAL\n', 'utf8')

    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('simulated rename failure')
    })

    expect(() => writeFileAtomicSync(targetPath, 'NEW\n')).toThrow(/simulated rename failure/)
    expect(readFileSync(targetPath, 'utf8')).toBe('ORIGINAL\n')
    expect(readdirSync(sandbox.dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a failed rename AND a failed cleanup still surfaces the original rename error (best-effort cleanup never masks it)', () => {
    const sandbox = makeSandbox()
    const targetPath = join(sandbox.dir, 'out.json')

    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('simulated rename failure')
    })
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw new Error('simulated cleanup failure')
    })

    // The rethrown error must be the ORIGINAL rename failure, not the
    // cleanup failure that happened while handling it.
    expect(() => writeFileAtomicSync(targetPath, 'NEW\n')).toThrow(/simulated rename failure/)
  })

  it('temp filenames embed both the pid and a random suffix (collision-resistant across concurrent/crashed runs)', () => {
    // Source-level invariant: guards against a future refactor reverting to
    // a fixed `.tmp` suffix, which could collide with a stale temp file left
    // by a previous crashed run once pids wrap around.
    const sigSrc = readFileSync(EVAL_SIGNATURES, 'utf8')
    expect(sigSrc).toContain('process.pid')
    expect(sigSrc).toContain('randomBytes')
  })
})

describe('emitBaselineSignature return value (SMI-5708 Item #4)', () => {
  it('returns false and warns on stderr when the shared .signatures.log write fails -- non-fatal, and without ever touching the real committed file', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // Two one-shot throws: emitBaselineSignature attempts exactly two writes
    // (the shared .signatures.log, then the per-developer marker). Queuing
    // exactly this many throws guarantees neither real write ever lands on
    // disk in this test, then reverts to the real implementation
    // automatically once both are consumed.
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('simulated disk full (log)')
    })
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('simulated disk full (marker)')
    })

    let result: boolean | undefined
    expect(() => {
      result = emitBaselineSignature('{"current":0.5}\n')
    }).not.toThrow()

    expect(result).toBe(false)
    const warnings = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warnings).toContain('failed to update .signatures.log')

    stderrSpy.mockRestore()
  })
})

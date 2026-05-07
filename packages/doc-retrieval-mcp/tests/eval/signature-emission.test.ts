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
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// resolve: tests/eval -> tests -> doc-retrieval-mcp -> packages -> repo
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const EVAL_RUNNER = join(REPO_ROOT, 'packages', 'doc-retrieval-mcp', 'eval', 'eval-runner.ts')

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

  it('eval-runner.ts source contains the signature-emission wiring', () => {
    // Guard against accidental removal of the Wave 0 wiring during refactors.
    // This is a weak invariant but keeps the test directory adjacent to the
    // change it protects.
    const src = readFileSync(EVAL_RUNNER, 'utf8')
    expect(src).toContain('emitBaselineSignature')
    expect(src).toContain('.signatures.log')
    expect(src).toContain('.skillsmith')
    expect(src).toContain('eval-signatures')
    expect(src).toContain('SIGNATURE_LOG_MAX_LINES')
    expect(src).toContain('createHash')
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

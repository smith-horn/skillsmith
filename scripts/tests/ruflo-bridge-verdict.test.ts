/**
 * SMI-6744 Wave 0: the bridge verdict must fire on the committed degraded
 * capture and stay quiet on a healthy payload -- both arms, plus every
 * outcome that is neither, because a detector that cannot say "I did not
 * evaluate" collapses into one of the two answers it exists to separate.
 *
 * The predicate is derived from @claude-flow/cli's own source (see the
 * detector's header). The last describe block re-reads those source files on
 * any machine that has the tree and fails if the enum drifted; elsewhere it
 * skips with the reason visible, which is the honest never-ran state.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DERIVED_FROM,
  EMBEDDING_BACKENDS,
  EXIT,
  FIELDS_READ,
  bridgeVerdict,
} from '../lib/ruflo-bridge-verdict.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(here, 'fixtures', 'ruflo-bridge-status')
const DEGRADED = path.join(FIXTURE_DIR, 'degraded-2026-09-18T21-16-11Z.json')
const CLI = path.join(here, '..', 'lib', 'ruflo-bridge-verdict.mjs')

type Section = Record<string, unknown>
interface Payload {
  agentdb: Section
  bridge: Section
  intelligence?: Section
}

function load(file: string): Payload {
  return JSON.parse(readFileSync(file, 'utf8')) as Payload
}

/**
 * Synthetic healthy arm: the degraded capture with ONLY the two read fields
 * flipped to the value the implementation emits for real ONNX output. It is
 * labelled synthetic on purpose; the measured healthy captures from the
 * Wave 0 Step 3 scratch build are the `healthy-*.json` files tested below.
 */
function syntheticHealthy(): Payload {
  const p = load(DEGRADED)
  p.agentdb.embeddingBackend = 'onnx'
  p.bridge.embeddingBackend = 'onnx'
  return p
}

function setBackend(p: Payload, value: unknown): Payload {
  p.agentdb.embeddingBackend = value
  p.bridge.embeddingBackend = value
  return p
}

describe('ruflo-bridge-verdict (SMI-6744 Wave 0)', () => {
  it('red arm: fires on the committed degraded capture', () => {
    const r = bridgeVerdict(load(DEGRADED))
    expect(r.verdict).toBe('degraded')
    expect(r.present).toEqual([...FIELDS_READ])
    // The capture says "connected". The verdict must not be swayed by it.
    expect(r.observed['bridge.status']).toBe('connected')
    expect(r.observed['agentdb.totalEntries']).toBe(61271)
  })

  it('green arm: stays quiet on a healthy payload', () => {
    expect(bridgeVerdict(syntheticHealthy()).verdict).toBe('healthy')
  })

  const measuredHealthy = existsSync(FIXTURE_DIR)
    ? readdirSync(FIXTURE_DIR).filter((f) => f.startsWith('healthy-') && f.endsWith('.json'))
    : []
  it.skipIf(measuredHealthy.length === 0)(
    `measured healthy captures verdict healthy (n=${measuredHealthy.length})`,
    () => {
      for (const f of measuredHealthy) {
        expect(bridgeVerdict(load(path.join(FIXTURE_DIR, f))).verdict, f).toBe('healthy')
      }
    }
  )

  it('a probe that did not complete is a third outcome, not a pass', () => {
    const r = bridgeVerdict(setBackend(syntheticHealthy(), 'unknown'))
    expect(r.verdict).toBe('not-evaluated')
    expect(r.reason).toContain('not a clean result')
  })

  it('never reads the derived agentdb.backend label', () => {
    // The label renders 'unknown' as 'sql.js + ONNX'. A verdict that read it
    // would pass a probe that never ran.
    const p = setBackend(syntheticHealthy(), 'unknown')
    p.agentdb.backend = 'sql.js + ONNX'
    expect(bridgeVerdict(p).verdict).toBe('not-evaluated')
    const q = load(DEGRADED)
    q.agentdb.backend = 'sql.js + ONNX'
    expect(bridgeVerdict(q).verdict).toBe('degraded')
  })

  it('bridge.status is context, not evidence', () => {
    const p = syntheticHealthy()
    p.bridge.status = 'not-synced'
    expect(bridgeVerdict(p).verdict).toBe('healthy')
    const q = load(DEGRADED)
    q.bridge.status = 'connected'
    expect(bridgeVerdict(q).verdict).toBe('degraded')
  })

  it('a value outside the enumerated set is unrecognized, never healthy', () => {
    for (const v of ['onnx-v2', 'ONNX', 'ruvector', '']) {
      const r = bridgeVerdict(setBackend(syntheticHealthy(), v))
      expect(r.verdict, JSON.stringify(v)).toBe('unrecognized')
      expect(r.reason).toContain(DERIVED_FROM.version)
    }
  })

  it('a non-string embeddingBackend is malformed', () => {
    for (const v of [true, 1, {}, []]) {
      expect(bridgeVerdict(setBackend(syntheticHealthy(), v)).verdict, typeof v).toBe('malformed')
    }
  })

  it('disagreeing copies of embeddingBackend are malformed', () => {
    const p = syntheticHealthy()
    p.bridge.embeddingBackend = 'mock'
    const r = bridgeVerdict(p)
    expect(r.verdict).toBe('malformed')
    expect(r.reason).toContain('disagrees')
  })

  it('a missing read field is malformed and is named', () => {
    const p = syntheticHealthy()
    delete p.bridge.embeddingBackend
    const r = bridgeVerdict(p)
    expect(r.verdict).toBe('malformed')
    expect(r.missing).toEqual(['bridge.embeddingBackend'])
    expect(r.present).toEqual(['agentdb.embeddingBackend'])
  })

  it('non-object payloads are malformed', () => {
    for (const bad of [null, undefined, 'x', 42, true]) {
      expect(bridgeVerdict(bad).verdict, String(bad)).toBe('malformed')
    }
  })

  it('the enumerated set is exactly the three values the implementation emits', () => {
    const all = [
      ...EMBEDDING_BACKENDS.healthy,
      ...EMBEDDING_BACKENDS.degraded,
      ...EMBEDDING_BACKENDS.notEvaluated,
    ].sort()
    expect(all).toEqual(['mock', 'onnx', 'unknown'])
  })

  describe('CLI exit status is three-way', () => {
    function run(file: string): { status: number; out: string } {
      try {
        const out = execFileSync(process.execPath, [CLI, file], { encoding: 'utf8' })
        return { status: 0, out }
      } catch (err) {
        const e = err as { status?: number; stdout?: string }
        return { status: e.status ?? -1, out: e.stdout ?? '' }
      }
    }

    it('degraded fixture -> exit 1 and the denominator is printed', () => {
      const r = run(DEGRADED)
      expect(r.status).toBe(EXIT.degraded)
      expect(r.out).toContain('read (2/2 present)')
      expect(r.out).toContain('bridge.status is a row-count claim')
    })

    it('unreadable input -> exit 2, distinct from degraded', () => {
      const r = run(path.join(FIXTURE_DIR, 'does-not-exist.json'))
      expect(r.status).toBe(EXIT.unreadable)
      expect(r.out).toContain('unreadable')
    })
  })
})

/**
 * Drift guard. Finds any installed @claude-flow/cli whose version is one the
 * predicate was derived from or verified at, and re-reads the five source
 * literals the header cites. Skips, visibly, when no such tree is present.
 */
describe('predicate source drift (skips when no derived-from tree is installed)', () => {
  const wanted = new Set([DERIVED_FROM.version, ...DERIVED_FROM.alsoVerifiedAt])
  // vitest.setup.ts rewrites $HOME to a temp sandbox before any test runs and
  // exports the real one as SKILLSMITH_TEST_REAL_HOME. This guard only READS
  // the npx cache, so it looks there; a bare homedir() would always be the
  // empty sandbox and the guard would skip on every machine, including the
  // one that has the tree.
  const npxRoot = path.join(process.env.SKILLSMITH_TEST_REAL_HOME ?? homedir(), '.npm', '_npx')
  const trees: Array<{ dir: string; version: string }> = []
  let scanned = 0
  if (existsSync(npxRoot)) {
    for (const hash of readdirSync(npxRoot)) {
      scanned++
      const pkg = path.join(npxRoot, hash, 'node_modules', '@claude-flow', 'cli')
      const pj = path.join(pkg, 'package.json')
      if (!existsSync(pj)) continue
      const version = (JSON.parse(readFileSync(pj, 'utf8')) as { version: string }).version
      if (wanted.has(version)) trees.push({ dir: pkg, version })
    }
  }
  const scope = `searched ${npxRoot}: ${scanned} cache dirs, ${trees.length} at a derived-from version`

  const LITERALS: Array<[string, string]> = [
    ['dist/src/mcp-tools/memory-tools.js', "probe.backend ?? 'unknown'"],
    ['dist/src/mcp-tools/memory-tools.js', "embeddingBackend === 'mock' ? 'sql.js + MOCK"],
    [
      'dist/src/mcp-tools/memory-tools.js',
      "status: agentdbEntries > 0 ? 'connected' : 'not-synced'",
    ],
    ['dist/src/memory/memory-initializer.js', "backend: 'onnx'"],
    ['dist/src/memory/memory-initializer.js', "backend: 'mock'"],
    ['dist/src/memory/memory-bridge.js', "backend: isMock ? 'mock' : 'onnx'"],
  ]

  it.skipIf(trees.length === 0)(
    `the cited literals are present in each derived-from tree (${scope})`,
    () => {
      for (const t of trees) {
        for (const [rel, literal] of LITERALS) {
          const src = readFileSync(path.join(t.dir, rel), 'utf8')
          expect(src.includes(literal), `${t.version} ${rel}: ${literal}`).toBe(true)
        }
        // The enum is closed: every string literal that appears in a
        // `backend:` object-property position in the two files that emit one
        // is 'mock' or 'onnx' (the ternary in memory-bridge.js contributes
        // both). Colon only, on purpose: `backend = 'hybrid'` (a DB-backend
        // option's destructuring default) and `let backend = 'unknown'` are
        // different variables in the same file, and a `[:=]` scan read them
        // as enum members -- measured on both trees before this was narrowed.
        for (const rel of [
          'dist/src/memory/memory-initializer.js',
          'dist/src/memory/memory-bridge.js',
        ]) {
          const src = readFileSync(path.join(t.dir, rel), 'utf8')
          const found = new Set<string>()
          for (const m of src.matchAll(/\bbackend:\s*([^,\n]+)/g)) {
            for (const s of m[1].matchAll(/'([a-z-]+)'/g)) found.add(s[1])
          }
          expect([...found].sort(), `${t.version} ${rel}`).toEqual(['mock', 'onnx'])
        }
      }
    }
  )
})

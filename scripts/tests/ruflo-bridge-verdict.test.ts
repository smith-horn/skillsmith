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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveRealHome } from './_lib/resolve-real-home.js'
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
const HEALTHY = path.join(FIXTURE_DIR, 'healthy-2026-09-18T21-40-02Z.json')
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

  it('every committed healthy capture verdicts healthy, and at least one exists', () => {
    // Not skipIf: the captures are in git, so an empty list can only mean a
    // rename or deletion, and that must fail, not skip.
    const measuredHealthy = readdirSync(FIXTURE_DIR).filter(
      (f) => f.startsWith('healthy-') && f.endsWith('.json')
    )
    expect(measuredHealthy.length, 'committed healthy captures').toBeGreaterThan(0)
    for (const f of measuredHealthy) {
      expect(bridgeVerdict(load(path.join(FIXTURE_DIR, f))).verdict, f).toBe('healthy')
    }
  })

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
    // `direct` execs the file itself, so the shebang and the executable bit
    // are load-bearing; without it, `node <file>` would pass with neither.
    function run(
      file: string,
      cli: string = CLI,
      direct: boolean = false
    ): { status: number; out: string } {
      try {
        const out = direct
          ? execFileSync(cli, [file], { encoding: 'utf8' })
          : execFileSync(process.execPath, [cli, file], { encoding: 'utf8' })
        return { status: 0, out }
      } catch (err) {
        const e = err as { status?: number; stdout?: string }
        return { status: e.status ?? -1, out: e.stdout ?? '' }
      }
    }

    it('healthy fixture -> exit 0 and says so', () => {
      const r = run(HEALTHY)
      expect(r.status).toBe(EXIT.healthy)
      expect(r.out).toContain('ruflo-bridge-verdict: healthy')
    })

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

    it('executed directly through a symlink, the degraded fixture still exits 1 with output', () => {
      // npm bin entries and ~/bin shims are symlinks, executed directly. The
      // first main-guard compared import.meta.url (resolved) with argv[1]
      // (invoked), which differ through a link -- measured: exit 0, zero
      // bytes, for a degraded payload. Exit 0 is the healthy verdict. Direct
      // exec (not `node <link>`) also makes the shebang and the executable
      // bit part of what this test constrains.
      const dir = mkdtempSync(path.join(tmpdir(), 'ruflo-bridge-verdict-link-'))
      try {
        const link = path.join(dir, 'verdict-link.mjs')
        symlinkSync(CLI, link)
        const r = run(DEGRADED, link, true)
        expect(r.status).toBe(EXIT.degraded)
        expect(r.out.length, 'stdout bytes through the symlink').toBeGreaterThan(0)
        expect(r.out).toContain('ruflo-bridge-verdict: degraded')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
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
  // resolveRealHome, not `?? homedir()`: an empty or whitespace value would
  // make this path RELATIVE and the guard would skip forever while printing
  // a root that reads as absolute. scripts/tests/_lib/resolve-real-home.ts
  // pins that exact bug.
  const npxRoot = path.join(
    resolveRealHome(process.env.SKILLSMITH_TEST_REAL_HOME, homedir),
    '.npm',
    '_npx'
  )
  const trees: Array<{ dir: string; version: string }> = []
  // Three counts, because "0 at a derived-from version" has two causes that
  // must render differently: ruflo was never cached here (withCli = 0), or
  // it was and every cached version is one this predicate was not read at
  // (withCli > 0). A truncated package.json from an interrupted npx counts
  // as unreadable rather than crashing collection.
  let cacheDirs = 0
  let withCli = 0
  let unreadable = 0
  // The scan itself is guarded too: an unreadable _npx (EACCES) at module
  // evaluation would otherwise fail collection and take every test in this
  // file with it, including the degraded red arm. Four states: absent (no
  // .npm, or .npm with no _npx), unreachable (the target cannot be stat'ed
  // for a reason other than ENOENT -- .npm at mode 000, HOME at mode 000, a
  // file where a directory belongs), present, unscannable (_npx itself
  // cannot be listed). Stat the TARGET, not its parent: POSIX stat() needs
  // search permission on the path PREFIX only, so stat'ing `.npm` succeeds
  // at mode 000 and the EACCES surfaces one level down inside
  // existsSync('.npm/_npx'), which swallows it and returns false. Measured:
  // the parent-stat form rendered (absent) over a real cached tree hidden
  // behind an unreadable .npm -- the conflation it claimed to remove, and a
  // red arm that had been declared as passing without its output ever
  // being read past the column where the state token sat.
  let root: 'present' | 'absent' | 'unreachable' | 'unscannable' = 'absent'
  let reachable = false
  try {
    statSync(npxRoot)
    reachable = true
    root = 'present'
  } catch (err) {
    root = (err as { code?: string }).code === 'ENOENT' ? 'absent' : 'unreachable'
  }
  if (reachable) {
    try {
      for (const hash of readdirSync(npxRoot)) {
        cacheDirs++
        const pkg = path.join(npxRoot, hash, 'node_modules', '@claude-flow', 'cli')
        const pj = path.join(pkg, 'package.json')
        if (!existsSync(pj)) continue
        try {
          const version = (JSON.parse(readFileSync(pj, 'utf8')) as { version: string }).version
          withCli++
          if (wanted.has(version)) trees.push({ dir: pkg, version })
        } catch {
          unreadable++
        }
      }
    } catch {
      root = 'unscannable'
    }
  }
  const scope =
    `searched ${npxRoot} (${root}): ${cacheDirs} cache dirs, ${withCli} with @claude-flow/cli, ` +
    `${trees.length} at a derived-from version, ${unreadable} unreadable`

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
        for (const [rel, expectedSites] of [
          ['dist/src/memory/memory-initializer.js', 2],
          ['dist/src/memory/memory-bridge.js', 1],
        ] as const) {
          const src = readFileSync(path.join(t.dir, rel), 'utf8')
          const found = new Set<string>()
          // Sites are found over the WHOLE source, so a second `backend:` on
          // the same physical line is seen (a per-line scan measured silent
          // on that shape), with an optional quoted key and a spaced colon.
          // Each value is bounded at the first `,`, `;`, `}`, `)` or `]` at
          // brace/paren depth 0, across newlines: a ternary arm or a call
          // argument on a continuation line is read, and a comma inside a
          // call is not a terminator. Two earlier line-bounded scans each
          // measured vacuous on a shape the previous one had not tested.
          // The per-file site count is pinned EXACTLY (2 and 1 at 3.14.2 and
          // 3.42.4): a site upstream removes, or moves to object shorthand
          // where the value is a variable, fails loudly instead of shrinking
          // the set quietly. A site with no literal at all is incomplete.
          let sites = 0
          let incomplete = 0
          // The lookbehind also excludes `.`, so `x ? obj.backend : y` (a
          // member access before a ternary colon) is not read as a site.
          for (const m of src.matchAll(/(?<![A-Za-z0-9_$.])["']?backend["']?\s*:\s*/g)) {
            sites++
            const start = (m.index ?? 0) + m[0].length
            let depth = 0
            let quote: string | null = null
            let end = start
            for (; end < src.length; end++) {
              const ch = src[end]
              // A quoted span is opaque: a `,` or `}` inside 'a,b' must not
              // end the value (measured: without this, a quoted separator
              // placed after both members bounded the value early and the
              // set passed while missing them).
              if (quote !== null) {
                if (ch === '\\') end++
                else if (ch === quote) quote = null
                continue
              }
              if (ch === "'" || ch === '"' || ch === '`') quote = ch
              else if (ch === '(' || ch === '{' || ch === '[') depth++
              else if (ch === ')' || ch === '}' || ch === ']') {
                if (depth === 0) break
                depth--
              } else if ((ch === ',' || ch === ';') && depth === 0) break
            }
            let n = 0
            for (const s of src.slice(start, end).matchAll(/'([a-z-]+)'/g)) {
              found.add(s[1])
              n++
            }
            if (n === 0) incomplete++
          }
          expect(sites, `${t.version} ${rel}: backend: sites`).toBe(expectedSites)
          expect([...found].sort(), `${t.version} ${rel}`).toEqual(['mock', 'onnx'])
          expect(incomplete, `${t.version} ${rel}: backend: sites with no literal`).toBe(0)
        }
      }
    }
  )
})

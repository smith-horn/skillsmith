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
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveRealHome } from './_lib/resolve-real-home.js'
import { probePath, type Probe } from './_lib/probe-path.js'
import { resolveDriftGuardOutcome, scanBackendSites } from './ruflo-bridge-verdict.helpers.js'
import {
  DERIVED_FROM,
  EMBEDDING_BACKENDS,
  EXIT,
  FIELDS_READ,
  FIELD_EMBEDDING_TOKEN,
  bridgeVerdict,
  exitCodeFor,
} from '../lib/ruflo-bridge-verdict.mjs'

// SMI-6772 F3: named, with the aggregate stated where it is defined -- 8
// call sites (one `it` calls run() 4 times), so a reader is never left to
// compute the worst case by hand. vitest's own testTimeout does not bound a
// sync exec (measured: a 500ms testTimeout let a 3s sleep run to
// completion), so this is the only budget that actually applies.
const EXEC_BUDGET_MS = 30_000 // block worst case: 8 x 30s = 240s

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
 * Synthetic healthy arm: the degraded capture with the two read fields, AND
 * bridge.embedding's own backend=X token, flipped to the value the
 * implementation emits for real ONNX output. It is labelled synthetic on
 * purpose; the measured healthy captures from the Wave 0 Step 3 scratch
 * build are the `healthy-*.json` files tested below.
 *
 * SMI-6772 F5: the original version of this function flipped ONLY the two
 * embeddingBackend fields and left `bridge.embedding` reading "... (384-dim,
 * backend=mock)" -- internally CONTRADICTORY (two fields say onnx, a third
 * says mock in the same object) and, before the FIELD_EMBEDDING_TOKEN
 * cross-check existed, silently accepted as 'healthy'. This function must
 * produce a payload that is genuinely self-consistent, not merely one whose
 * two READ fields happen to agree.
 */
function syntheticHealthy(): Payload {
  const p = load(DEGRADED)
  p.agentdb.embeddingBackend = 'onnx'
  p.bridge.embeddingBackend = 'onnx'
  const embedding = p.bridge.embedding
  if (typeof embedding === 'string') {
    p.bridge.embedding = embedding.replace(/backend=mock/, 'backend=onnx')
  }
  return p
}

function setBackend(p: Payload, value: unknown): Payload {
  p.agentdb.embeddingBackend = value
  p.bridge.embeddingBackend = value
  // Keep bridge.embedding's own backend=X token in sync too (SMI-6772 F5):
  // setBackend() sets arbitrary test values on the two READ fields to
  // exercise not-evaluated/unrecognized/disagreement, none of which is
  // about the embedding-token cross-check -- leaving that token at
  // whatever syntheticHealthy() set ("backend=onnx") would trip the NEW
  // cross-check for a reason unrelated to what each call site actually
  // tests. Only meaningful for a string value: setBackend's non-string
  // call sites (true, 1, {}, []) already hit the typeof guard before the
  // cross-check ever runs, so bridge.embedding staying stale there is
  // harmless. The character class matches EMBEDDING_TOKEN_RE's own (case
  // preserved, unlike that regex's matching, which is case-insensitive).
  if (typeof value === 'string' && typeof p.bridge.embedding === 'string') {
    p.bridge.embedding = p.bridge.embedding.replace(/backend=[a-zA-Z0-9._-]*/, `backend=${value}`)
  }
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

  describe('fixture provenance schema (SMI-6772 F10, partial)', () => {
    // F10 asked for two things: (1) validate the `_provenance` schema
    // instead of trusting only the filename prefix, and (2) keep raw
    // stdout/stderr and an installed-package manifest as SEPARATE artifacts
    // with hashes. Only (1) is implemented here -- (2) would require
    // re-running the original 2026-09-18 scratch-build captures that
    // produced these fixtures to obtain real raw output and a real package
    // manifest; fabricating either now would be fictitious provenance data,
    // which defeats the point of provenance. Recorded, not silently
    // dropped: see this file's own migration report for the follow-up.
    function assertProvenanceShape(raw: unknown, label: string): void {
      const envelope = raw as { _provenance?: Record<string, unknown> }
      const prov = envelope._provenance
      expect(prov, `${label}: _provenance present`).toBeTypeOf('object')
      expect(typeof prov?.captured, `${label}: _provenance.captured is a string`).toBe('string')
      expect(
        Number.isNaN(Date.parse(String(prov?.captured))),
        `${label}: _provenance.captured parses as a date`
      ).toBe(false)
      expect(typeof prov?.tool, `${label}: _provenance.tool is a string`).toBe('string')
      expect(typeof prov?.note, `${label}: _provenance.note is a string`).toBe('string')
    }

    it('the committed degraded capture has a well-formed provenance envelope', () => {
      assertProvenanceShape(JSON.parse(readFileSync(DEGRADED, 'utf8')), 'degraded fixture')
    })

    it('every committed healthy capture has a well-formed provenance envelope', () => {
      const measuredHealthy = readdirSync(FIXTURE_DIR).filter(
        (f) => f.startsWith('healthy-') && f.endsWith('.json')
      )
      for (const f of measuredHealthy) {
        assertProvenanceShape(JSON.parse(readFileSync(path.join(FIXTURE_DIR, f), 'utf8')), f)
      }
    })
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

  describe('bridge.embedding cross-check (SMI-6772 F5)', () => {
    it('FIRST TEST: flipping only embeddingBackend, leaving bridge.embedding saying backend=mock, must not be healthy', () => {
      // This is the exact shape the finding reports: syntheticHealthy()'s
      // ORIGINAL body, reproduced inline (not via the now-fixed helper) so
      // this test still pins the bug even if syntheticHealthy() changes
      // again later.
      const p = load(DEGRADED)
      p.agentdb.embeddingBackend = 'onnx'
      p.bridge.embeddingBackend = 'onnx'
      // bridge.embedding is deliberately left untouched: still "... backend=mock".
      const r = bridgeVerdict(p)
      expect(r.verdict).not.toBe('healthy')
      expect(r.verdict).toBe('malformed')
      expect(r.reason).toContain('backend=mock')
      expect(r.reason).toContain('contradicting')
      expect(r.observed[FIELD_EMBEDDING_TOKEN]).toContain('backend=mock')
    })

    it('the synthetic healthy fixture is now genuinely self-consistent', () => {
      const p = syntheticHealthy()
      expect(p.bridge.embedding).toContain('backend=onnx')
      expect(p.bridge.embedding).not.toContain('backend=mock')
      expect(bridgeVerdict(p).verdict).toBe('healthy')
    })

    it('a missing bridge.embedding does not change the verdict -- never a primary source of truth', () => {
      const p = syntheticHealthy()
      delete p.bridge.embedding
      expect(bridgeVerdict(p).verdict).toBe('healthy')
    })

    it('a non-string bridge.embedding does not crash and does not change the verdict', () => {
      const p = syntheticHealthy()
      p.bridge.embedding = 12345
      expect(() => bridgeVerdict(p)).not.toThrow()
      expect(bridgeVerdict(p).verdict).toBe('healthy')
    })

    it('two contradicting backend= tokens in one string are malformed, whichever comes first', () => {
      // Governance on B1.2: a non-global match read only the FIRST token, so
      // "backend=onnx ... backend=mock" agreed with embeddingBackend=onnx and
      // verdicted healthy. Both orders must be rejected.
      const p = syntheticHealthy()
      p.bridge.embedding = 'all-MiniLM-L6-v2 (384-dim, backend=onnx) fallback backend=mock'
      const r = bridgeVerdict(p)
      expect(r.verdict).toBe('malformed')
      expect(r.reason).toContain('2 distinct backend= tokens')
      const q = syntheticHealthy()
      q.bridge.embedding = 'backend=mock then backend=onnx'
      expect(bridgeVerdict(q).verdict).toBe('malformed')
      // The same token repeated is not a contradiction.
      const same = syntheticHealthy()
      same.bridge.embedding = 'backend=onnx (backend=onnx)'
      expect(bridgeVerdict(same).verdict).toBe('healthy')
    })

    it('a bridge.embedding string with no backend= token does not change the verdict', () => {
      const p = syntheticHealthy()
      p.bridge.embedding = 'all-MiniLM-L6-v2 (384-dim)'
      expect(bridgeVerdict(p).verdict).toBe('healthy')
    })

    it('never reads agentdb.backend for this cross-check either', () => {
      // agentdb.backend stays unread by documented design (it renders
      // 'unknown' as 'sql.js + ONNX'); only bridge.embedding is cross-checked.
      const p = syntheticHealthy()
      p.agentdb.backend = 'this string is not read at all'
      expect(bridgeVerdict(p).verdict).toBe('healthy')
    })
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

  describe('own-data-property reads (SMI-6772 F6)', () => {
    it('an inherited (prototype) embeddingBackend is not read, not even as evidence of presence', () => {
      const p = syntheticHealthy()
      delete p.agentdb.embeddingBackend
      Object.setPrototypeOf(p.agentdb, { embeddingBackend: 'onnx' })
      const r = bridgeVerdict(p)
      expect(r.verdict).toBe('malformed')
      expect(r.missing).toContain('agentdb.embeddingBackend')
    })

    it('a throwing getter for embeddingBackend is never invoked -- get() reads own DATA properties only', () => {
      const p = syntheticHealthy()
      delete p.agentdb.embeddingBackend
      Object.defineProperty(p.agentdb, 'embeddingBackend', {
        get(): string {
          throw new Error('should never be invoked')
        },
        enumerable: true,
        configurable: true,
      })
      expect(() => bridgeVerdict(p)).not.toThrow()
      expect(bridgeVerdict(p).verdict).toBe('malformed')
    })

    it('a boxed String object for embeddingBackend is malformed, never unwrapped to its primitive', () => {
      const p = syntheticHealthy()
      // Deliberately a boxed String (not a primitive), to pin that it is
      // never unwrapped before the type check.
      const boxed = new String('onnx')
      p.agentdb.embeddingBackend = boxed as unknown as string
      p.bridge.embeddingBackend = boxed as unknown as string
      expect(bridgeVerdict(p).verdict).toBe('malformed')
    })
  })

  describe('exitCodeFor table seam (SMI-6772 F1)', () => {
    it('an inherited (prototype) NUMERIC property on a custom table is never used -- own keys only', () => {
      expect(exitCodeFor('stale', Object.create({ stale: 2 })), 'inherited numeric').toBeNull()
    })

    it('an own numeric property on a custom table IS used -- the seam works both ways', () => {
      expect(exitCodeFor('stale', { stale: 3 })).toBe(3)
    })

    it('the default table is still EXIT when none is supplied', () => {
      expect(exitCodeFor('healthy')).toBe(EXIT.healthy)
    })
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
    // `file` accepts more than one positional (SMI-6772 F9's own regression
    // lock passes two) -- every existing call site below passes a single
    // string, unaffected by the array branch.
    function run(
      file: string | string[],
      cli: string = CLI,
      direct: boolean = false
    ): { status: number; out: string } {
      const args = Array.isArray(file) ? file : [file]
      try {
        // A sync exec is not interrupted by vitest's testTimeout (measured:
        // a 500 ms testTimeout let a 3 s sleep run to completion), so the
        // budget lives on the call (SMI-6772 F3: EXEC_BUDGET_MS, module
        // level). On timeout `status` is null -> -1 below -> every
        // toBe(EXIT.x) fails loudly.
        const out = direct
          ? execFileSync(cli, args, { encoding: 'utf8', timeout: EXEC_BUDGET_MS })
          : execFileSync(process.execPath, [cli, ...args], {
              encoding: 'utf8',
              timeout: EXEC_BUDGET_MS,
            })
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

    it('every verdict the detector can return maps to a numeric exit; prototype keys and unknown names map to null', () => {
      // The verdict list is DERIVED from the detector's own source via
      // `/verdict: '([^']+)'/g` -- narrow about what that spelling actually
      // covers (SMI-6772 F2): it sees only a single-quoted string literal
      // directly after a `verdict:` key, so `verdict: VERDICT_STALE`, a
      // ternary (`verdict: cond ? 'stale' : 'x'` reads only the FIRST
      // literal), and the `{ ...base, verdict }` shorthand are all
      // invisible to it, and a docblock EXAMPLE spelled the same way would
      // inject a phantom member. It is right about today's five verdicts by
      // construction (every real return site is spelled exactly this way),
      // not by being a general-purpose extractor. `EXIT[x]` for an unnamed
      // verdict is undefined and process.exit(undefined) is exit 0;
      // Object.freeze leaves inherited keys, so `EXIT['constructor']` is a
      // function and process.exit(<function>) is exit 1 -- both measured.
      // exitCodeFor answers own-key-and-number, or null, and the guard in
      // main() is reachable only through it; an inline guard measured
      // unreachable (every returned verdict is an own key), so deleting it
      // left the suite green.
      const src = readFileSync(CLI, 'utf8')
      const verdicts = [...new Set([...src.matchAll(/verdict: '([^']+)'/g)].map((m) => m[1]))]
      expect(verdicts.length, 'derivation returned nothing; the regex is stale').toBeGreaterThan(0)
      expect(verdicts).toEqual(
        expect.arrayContaining([
          'healthy',
          'degraded',
          'not-evaluated',
          'malformed',
          'unrecognized',
        ])
      )
      for (const v of [...verdicts, 'unreadable']) {
        expect(exitCodeFor(v), v).toBeTypeOf('number')
      }
      for (const v of ['not-evaluated', 'malformed', 'unrecognized', 'unreadable']) {
        expect(exitCodeFor(v), v).toBe(2)
      }
      for (const v of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'nope', '']) {
        expect(exitCodeFor(v), v).toBeNull()
      }
      // SMI-6772 F2 reverse-direction assertion: the forward direction above
      // only ever asked "does every derived verdict have an EXIT entry" --
      // nothing asserted the reverse, so a return site deleted from the
      // source while its EXIT key stayed behind would pass silently forever.
      // 'unreadable' is EXIT's one key with no `verdict:`-shaped return site
      // (it is a CLI-only outcome -- a file that could not even be parsed),
      // so it is the one deliberate exception.
      expect(Object.keys(EXIT).filter((k) => !verdicts.includes(k) && k !== 'unreadable')).toEqual(
        []
      )
    })

    it('the three non-verdict outcomes reach the CLI as exit 2, each naming itself and its denominator', () => {
      // Written to a temp dir so each payload is a real file the CLI reads,
      // not a mutation of a committed fixture.
      const dir = mkdtempSync(path.join(tmpdir(), 'ruflo bridge verdict ü-'))
      try {
        const write = (name: string, payload: unknown): string => {
          const p = path.join(dir, name)
          writeFileSync(p, JSON.stringify(payload))
          return p
        }
        const ne = run(write('not-evaluated.json', setBackend(syntheticHealthy(), 'unknown')))
        expect(ne.status).toBe(EXIT['not-evaluated'])
        expect(ne.out).toContain('ruflo-bridge-verdict: not-evaluated')

        const empty = run(write('empty.json', {}))
        expect(empty.status).toBe(EXIT.malformed)
        expect(empty.out).toContain('ruflo-bridge-verdict: malformed')
        expect(empty.out).toContain('read (0/2 present)')

        const half = syntheticHealthy()
        delete half.bridge.embeddingBackend
        const one = run(write('one-field.json', half))
        expect(one.status).toBe(EXIT.malformed)
        expect(one.out).toContain('read (1/2 present)')

        const unk = run(write('unrecognized.json', setBackend(syntheticHealthy(), 'onnx-v2')))
        expect(unk.status).toBe(EXIT.unrecognized)
        expect(unk.out).toContain('ruflo-bridge-verdict: unrecognized')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('extra CLI positional arguments are a usage error, exit 2, not the last path silently picked (SMI-6772 F9/M5)', () => {
      // M5's surviving mutation (argv.at(-1) instead of argv[2]) would
      // silently read HEALTHY here and exit 0 -- the usage check below runs
      // BEFORE any path is selected, so which of the two paths a mutated
      // selector would have picked is moot.
      const r = run([DEGRADED, HEALTHY])
      expect(r.status).toBe(2)
      expect(r.out).toContain('usage')
    })

    it('executed directly through a symlink in a percent-encoded directory, the degraded fixture still exits 1 with output', () => {
      // npm bin entries and ~/bin shims are symlinks, executed directly. The
      // first main-guard compared import.meta.url (resolved) with argv[1]
      // (invoked), which differ through a link -- measured: exit 0, zero
      // bytes, for a degraded payload. Exit 0 is the healthy verdict. Direct
      // exec (not `node <link>`) also makes the shebang and the executable
      // bit part of what this test constrains. The directory name carries a
      // space and a non-ASCII char on purpose: import.meta.url is then
      // percent-encoded, and a guard that compares an undecoded pathname
      // measured exit 0 with no output from such a directory (SMI-6767's
      // dominant spelling). tmpdir() is outside the vitest $HOME sandbox.
      const dir = mkdtempSync(path.join(tmpdir(), 'ruflo bridge verdict ü-'))
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
 * predicate was derived from or verified at, and re-reads the six source
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
  // ONE classifier for every path the scan touches (SMI-6771: shared with
  // every other existsSync-based present/absent gate in this test tree via
  // ./_lib/probe-path.js). Four rounds of review found the same conflation
  // at successive levels -- _npx, then its parent, then each cache entry's
  // package.json -- because each level had its own existsSync, and
  // existsSync returns false whenever it cannot STAT, so an unreadable path
  // reads as "not there". POSIX stat() needs search permission on the
  // PREFIX only, so stat'ing the target itself is what separates the cases:
  // ENOENT is absent; any other error (EACCES on the path or on HOME,
  // ENOTDIR on a file where a directory belongs) is unreachable, and the
  // cache may well be there. The one classifier is used for the root and
  // for each entry, so there is no fourth special case to add later.
  // Counts, because "0 at a derived-from version" has several causes that
  // must render differently: ruflo was never cached here (withCli = 0); it
  // was, and every cached version is one this predicate was not read at
  // (withCli > 0); an entry's package.json was unreadable (truncated by an
  // interrupted npx -- unreadable) or could not be reached at all (mode
  // bits -- unreachable). None of them crashes collection.
  let cacheDirs = 0
  let withCli = 0
  let unreadable = 0
  let unreachable = 0
  let root: Probe | 'unscannable' = probePath(npxRoot)
  if (root === 'present') {
    try {
      for (const hash of readdirSync(npxRoot)) {
        cacheDirs++
        const pkg = path.join(npxRoot, hash, 'node_modules', '@claude-flow', 'cli')
        const pj = path.join(pkg, 'package.json')
        const state = probePath(pj)
        if (state === 'absent') continue
        if (state === 'unreachable') {
          unreachable++
          continue
        }
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
    `${trees.length} at a derived-from version, ${unreadable} unreadable, ${unreachable} unreachable`

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

  // SMI-6772 F7: `it.skipIf(trees.length === 0)` treated a genuinely absent
  // npx cache (legitimate skip) the same as a PRESENT cache the scan could
  // not conclude anything about (dangling symlink, malformed/BOM-prefixed
  // JSON, an unscannable root, an unreachable entry) -- both silently
  // rendered as the same skip. resolveDriftGuardOutcome distinguishes them:
  // it still skips only on a genuinely empty/absent cache, and fails,
  // naming why, when the scan itself was incomplete.
  const driftOutcome = resolveDriftGuardOutcome({
    root,
    treesLength: trees.length,
    unreadable,
    unreachable,
  })

  it.skipIf(driftOutcome.skip)(
    `the cited literals are present in each derived-from tree (${scope})`,
    () => {
      if (!driftOutcome.skip && driftOutcome.fail) {
        throw new Error(driftOutcome.fail)
      }
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
        // The per-file site count is pinned EXACTLY (2 and 1 at 3.14.2 and
        // 3.42.4): a site upstream removes, or moves to object shorthand
        // where the value is a variable, fails loudly instead of shrinking
        // the set quietly. scanBackendSites (SMI-6772 F8) additionally sees
        // double-quoted and template-literal values, not single-quote only.
        for (const [rel, expectedSites] of [
          ['dist/src/memory/memory-initializer.js', 2],
          ['dist/src/memory/memory-bridge.js', 1],
        ] as const) {
          const src = readFileSync(path.join(t.dir, rel), 'utf8')
          const scan = scanBackendSites(src)
          expect(scan.sites, `${t.version} ${rel}: backend: sites`).toBe(expectedSites)
          expect(scan.found, `${t.version} ${rel}`).toEqual(['mock', 'onnx'])
          expect(scan.incomplete, `${t.version} ${rel}: backend: sites with no literal`).toBe(0)
        }
      }
    }
  )
})

describe('scanBackendSites (SMI-6772 F8)', () => {
  it('single-quoted literals, matching the original scanner exactly', () => {
    const scan = scanBackendSites("backend: 'onnx',\nbackend: 'mock',")
    expect(scan.sites).toBe(2)
    expect(scan.found).toEqual(['mock', 'onnx'])
    expect(scan.incomplete).toBe(0)
  })

  it('double-quoted and template-literal values are no longer silently dropped', () => {
    // The exact surviving shape the finding names: two single-quoted arms
    // keep the site's own literal count above zero, so a single-quote-only
    // scanner never trips `incomplete` while "gpu" vanishes from `found`.
    const scan = scanBackendSites("backend: a ? 'mock' : b ? 'onnx' : \"gpu\",")
    expect(scan.sites).toBe(1)
    expect(scan.found).toEqual(['gpu', 'mock', 'onnx'])
    expect(scan.incomplete).toBe(0)
  })

  it('a fully-static template literal is recognized too', () => {
    const scan = scanBackendSites('backend: `onnx`,')
    expect(scan.found).toEqual(['onnx'])
    expect(scan.incomplete).toBe(0)
  })

  it('a template literal with interpolation is dynamic, not a literal -- counted incomplete, never miscounted as a match', () => {
    // A lowercase single-letter interpolated identifier on purpose: a
    // widened-but-still-lowercase-only character class mutation (adding
    // '$', '{', '}' to "support template literals") would fully match
    // `${x}` and silently treat this dynamic expression as the literal
    // value "x" -- a mixed-case identifier like `${dynamicValue}` alone
    // does not expose that mutation (the class's own lowercase-only
    // restriction already breaks the match on the capital letter, for an
    // unrelated reason), so both are asserted.
    const dynamic = scanBackendSites('backend: `${dynamicValue}`,')
    expect(dynamic.found).toEqual([])
    expect(dynamic.incomplete).toBe(1)

    const dynamicLowercase = scanBackendSites('backend: `${x}`,')
    expect(dynamicLowercase.found).toEqual([])
    expect(dynamicLowercase.incomplete).toBe(1)
  })

  it('a concatenation-built value is incomplete, never two phantom literals', () => {
    // Governance on B1.2: `'on' + 'nx'` used to scan as found=['nx','on'].
    const scan = scanBackendSites("backend: 'on' + 'nx',")
    expect(scan.found).toEqual([])
    expect(scan.incomplete).toBe(1)
    // A `+` inside a quoted literal is content, not concatenation.
    const quoted = scanBackendSites("backend: 'onnx',\nlabel: 'a+b',")
    expect(quoted.found).toEqual(['onnx'])
    expect(quoted.incomplete).toBe(0)
  })

  it('a backslash-escaped quote inside a literal does not defeat plus-detection', () => {
    // Governance on 8f1e1afbc: hasUnquotedPlus() skips the character after a
    // backslash so an escaped quote does not close the string early. With
    // that skip broken (e.g. comparing against a two-character '\\\\'), the
    // tracker closes the literal at \\' and the trailing `+ 'c'` reads as two
    // static literals ('b', 'c') -- the exact phantom-literal defect this
    // guard exists to reject -- and nothing else in the suite noticed.
    const scan = scanBackendSites("backend: 'a\\'b' + 'c',")
    expect(scan.found).toEqual([])
    expect(scan.incomplete).toBe(1)
  })

  it('an escaped backslash as literal content does not defeat plus-detection either', () => {
    // Governance on 793fe460d: the escaped-quote test above is satisfied by a
    // tracker that closes the string on a backslash (`quote = null`) because
    // the very next character re-opens it; an escaped backslash as content
    // (`'a\\\\'` in source, the value a\\) is the shape that tells the correct
    // skip (`i++`) from that mutation, which reads the trailing `+ 'b'` as a
    // phantom literal 'b'.
    const scan = scanBackendSites("backend: 'a\\\\' + 'b',")
    expect(scan.found).toEqual([])
    expect(scan.incomplete).toBe(1)
  })

  it('a bare identifier with no literal at all is incomplete, not silently skipped', () => {
    const scan = scanBackendSites('backend: someVariable,')
    expect(scan.found).toEqual([])
    expect(scan.incomplete).toBe(1)
  })

  it('sites are found independently across the whole source, not nested inside a prior span', () => {
    const scan = scanBackendSites("backend: 'mock', backend: 'onnx',")
    expect(scan.sites).toBe(2)
    expect(scan.found).toEqual(['mock', 'onnx'])
    expect(scan.incomplete).toBe(0)
  })
})

describe('resolveDriftGuardOutcome (SMI-6772 F7)', () => {
  it('a genuinely absent npx cache is a legitimate skip', () => {
    expect(
      resolveDriftGuardOutcome({ root: 'absent', treesLength: 0, unreadable: 0, unreachable: 0 })
    ).toEqual({ skip: true })
  })

  it('present, fully scanned, zero matching versions is a legitimate skip', () => {
    expect(
      resolveDriftGuardOutcome({ root: 'present', treesLength: 0, unreadable: 0, unreachable: 0 })
    ).toEqual({ skip: true })
  })

  it('present with matching versions never skips and never fails', () => {
    expect(
      resolveDriftGuardOutcome({ root: 'present', treesLength: 1, unreadable: 0, unreachable: 0 })
    ).toEqual({ skip: false, fail: null })
  })

  it('an unscannable root fails loudly rather than skipping', () => {
    const r = resolveDriftGuardOutcome({
      root: 'unscannable',
      treesLength: 0,
      unreadable: 0,
      unreachable: 0,
    })
    expect(r.skip).toBe(false)
    expect(!r.skip && r.fail).toContain('unscannable')
  })

  it('an unreachable root fails loudly rather than skipping', () => {
    const r = resolveDriftGuardOutcome({
      root: 'unreachable',
      treesLength: 0,
      unreadable: 0,
      unreachable: 0,
    })
    expect(r.skip).toBe(false)
    expect(!r.skip && r.fail).toContain('unreachable')
  })

  it('a present cache with an unreadable entry fails loudly even with zero trees found', () => {
    const r = resolveDriftGuardOutcome({
      root: 'present',
      treesLength: 0,
      unreadable: 1,
      unreachable: 0,
    })
    expect(r.skip).toBe(false)
    expect(!r.skip && r.fail).toContain('unreadable=1')
  })

  it('a present cache with an unreachable entry fails loudly even with zero trees found', () => {
    const r = resolveDriftGuardOutcome({
      root: 'present',
      treesLength: 0,
      unreadable: 0,
      unreachable: 1,
    })
    expect(r.skip).toBe(false)
    expect(!r.skip && r.fail).toContain('unreachable=1')
  })
})

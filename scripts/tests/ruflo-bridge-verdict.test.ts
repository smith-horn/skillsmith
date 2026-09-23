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
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

    it('an own value that is not a process exit integer is rejected -- NaN, a fraction, a numeric string, out of range', () => {
      // PR #2900 gate round 1 (PR-16 f): `typeof NaN === 'number'`, so an own
      // key holding NaN passed the type check and reached process.exit.
      // Measured on Node 22: exit(NaN), exit(1.5) and exit(Infinity) throw
      // RangeError and the process ends 1 -- the DEGRADED verdict, with a
      // stack trace where the verdict line should be; exit(256) wraps to 0,
      // the HEALTHY verdict; exit(-1) wraps to 255; exit('3') is accepted as
      // 3. The predicate is now Number.isInteger plus the 0..255 range a
      // status byte can carry, so every shape below is null and main() ends
      // with UNCLASSIFIED_EXIT instead of a coerced or thrown code.
      for (const bad of [NaN, 1.5, '3', -1, 256, Infinity]) {
        expect(exitCodeFor('stale', { stale: bad }), `own value ${String(bad)}`).toBeNull()
      }
      expect(exitCodeFor('stale', { stale: 0 }), 'own value 0 is the floor').toBe(0)
      expect(exitCodeFor('stale', { stale: 255 }), 'own value 255 is the ceiling').toBe(255)
    })
  })

  it('a disagreement between the two backend fields is malformed whatever their types (SMI-6783)', () => {
    // A peer session's mutation: narrowing the disagreement check to
    // `a !== b && typeof a === 'string' && typeof b === 'string'` survived
    // this whole suite, because every disagreement fixture used two
    // strings -- and under it `agentdb='onnx', bridge=5` skips the
    // disagreement branch, clears the string check on `a`, and reads
    // HEALTHY, exit 0. The property is "a disagreement is malformed
    // whatever the types"; each order and a same-type non-string pair are
    // asserted so the narrowing cannot be re-introduced in either half.
    const stringVsNumber = syntheticHealthy()
    stringVsNumber.bridge.embeddingBackend = 5 as unknown as string
    expect(bridgeVerdict(stringVsNumber).verdict, 'agentdb string, bridge number').toBe('malformed')
    const numberVsString = syntheticHealthy()
    numberVsString.agentdb.embeddingBackend = 5 as unknown as string
    expect(bridgeVerdict(numberVsString).verdict, 'agentdb number, bridge string').toBe('malformed')
    const bothNumbers = syntheticHealthy()
    bothNumbers.agentdb.embeddingBackend = 5 as unknown as string
    bothNumbers.bridge.embeddingBackend = 5 as unknown as string
    expect(bridgeVerdict(bothNumbers).verdict, 'two equal numbers').toBe('malformed')
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
 * Drift guard. SMI-6744 ADR-170 § 7: the served tree is no longer the host
 * npx cache -- C3 bakes a single pinned @claude-flow/cli into the `ruflo`
 * service image at /opt/ruflo-seed, read-only, inside the container (never
 * the host, never this dev container). This guard has no host-side view of
 * that tree by default, so the covered root is read from
 * SKILLSMITH_RUFLO_SEED_ROOT, defaulting to the container path
 * (/opt/ruflo-seed); on an ordinary host session that path does not exist
 * and the guard SKIPS, visibly, naming the exact path it looked for and
 * why -- the same honest-skip shape the retired npx-cache guard used for
 * "cache never populated". Running this arm for real needs either the
 * `ruflo` service container itself or a copy of its seed mounted at that
 * path; scripts/tests/mcp-ruflo-launcher.test.sh's own container-dependent
 * arms are the closer analogue for CI wiring, not this file.
 */
describe('predicate source drift (skips when the served ruflo seed tree is unreachable)', () => {
  const wanted = new Set([DERIVED_FROM.version, ...DERIVED_FROM.alsoVerifiedAt])
  const seedRoot = process.env.SKILLSMITH_RUFLO_SEED_ROOT ?? '/opt/ruflo-seed'
  const pkg = path.join(seedRoot, 'node_modules', '@claude-flow', 'cli')
  const pj = path.join(pkg, 'package.json')

  const trees: Array<{ dir: string; version: string }> = []
  // ONE classifier for the single path this scan touches (SMI-6771: shared
  // with every other existsSync-based present/absent gate in this test tree
  // via ./_lib/probe-path.js) -- ENOENT is absent; any other stat() error
  // (EACCES, ENOTDIR on an ancestor) is unreachable, and the tree may well
  // be there. withCli/unreadable/unreachable are still counted (not just
  // booleans) so the printed `scope` string distinguishes "no seed reached
  // at all" from "a seed was reached but its package.json was unreadable"
  // from "reached, readable, just not a derived-from version" -- the same
  // three-way distinction SMI-6772 F7 required of the old multi-entry scan,
  // now over a single candidate instead of a directory listing.
  let withCli = 0
  let unreadable = 0
  let unreachable = 0
  const root: Probe | 'unscannable' = probePath(pj)
  if (root === 'present') {
    try {
      const version = (JSON.parse(readFileSync(pj, 'utf8')) as { version: string }).version
      withCli = 1
      if (wanted.has(version)) trees.push({ dir: pkg, version })
    } catch {
      unreadable = 1
    }
  } else if (root === 'unreachable') {
    unreachable = 1
  }
  const scope =
    `checked ${pj} (${root}): ${withCli} with @claude-flow/cli, ` +
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
    // Governance on 243912894 (F-B): a string closes only on its OWN quote
    // type; a foreign quote inside it is content. Under the old character
    // class a walker closing on ANY quote (`isQuote(s[i])` for
    // `s[i] === quote`) yielded the phantom label found=['o']; under the
    // positional grammar the leaked `nnx` fails the shape and the site
    // reads computed, so found=[] no longer tells the two apart. The third
    // assertion does: with a recognised arm FIRST, the pristine walker
    // keeps 'mock' beside the unrecognised region, and the broken one
    // loses it to the computed path.
    expect(scanBackendSites(`backend: "o'nnx",`).found).toEqual([])
    expect(scanBackendSites(`backend: 'a"b',`).found).toEqual([])
    const mixedAfterArm = scanBackendSites(`backend: a ? 'mock' : "o'nnx",`)
    expect(mixedAfterArm.found).toEqual(['mock'])
    expect(mixedAfterArm.incomplete).toBe(1)
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
    // Governance on 8f1e1afbc. The concatenation path must still win when
    // the first operand carries an escaped quote. (The backslash skip itself
    // is pinned by the escaped-quote-as-content test below, whose found=[]
    // a walker without the skip cannot produce.)
    const scan = scanBackendSites("backend: 'a\\'b' + 'c',")
    expect(scan.found).toEqual([])
    expect(scan.incomplete).toBe(1)
  })

  it('an escaped backslash as literal content does not defeat plus-detection either', () => {
    // Governance on 793fe460d: a tracker that closes the string ON a
    // backslash (`quote = null`) re-opens it on the next character for an
    // escaped quote, but not for an escaped backslash (`'a\\\\'` in source,
    // the value a\\) -- there the trailing `+ 'b'` is read inside a string
    // and the site is not seen as concatenation.
    const scan = scanBackendSites("backend: 'a\\\\' + 'b',")
    expect(scan.found).toEqual([])
    expect(scan.incomplete).toBe(1)
  })

  it('an escaped same-type quote as literal content, with no concatenation, is not a phantom literal -- all three quote styles', () => {
    // Governance on f8134e340: the literal regex ran over the RAW span text, so
    // `'a\'b'` (the value a'b) matched at the escaped quote and yielded a
    // phantom found=['b'] with incomplete=0 -- and nothing in the suite
    // noticed, because every earlier escaped-quote case carried a trailing
    // `+` that routed the site through the concatenation path before the
    // regex ran. Literals are now extracted by the same escape-aware walker
    // that finds computed syntax, and a quoted region whose content is not
    // [a-z-]+ marks the site incomplete. The third shape per quote style is
    // the pin for the backslash skip (governance on 8edd4fcef: the
    // two-escaped-quotes shape stopped pinning it once the computed-syntax
    // rule landed, because a walker that does NOT skip the character after
    // a backslash leaks the second backslash into the unquoted text, which
    // reads as computed and lands on the right verdict for the wrong
    // reason). With the escaped arm FIRST, that walker closes the string at
    // the escaped quote, re-opens it at the real closing quote, and from
    // there every quote is read with flipped parity: 'mock' becomes
    // unquoted text and vanishes from `found`. Only the escaped-first order
    // exposes that; escaped-last (the mixed-arm test below) recognises
    // 'mock' before the parity flips.
    for (const q of ["'", '"', '`']) {
      const single = scanBackendSites(`backend: ${q}a\\${q}b${q},`)
      expect(single.found, `${q} single escaped quote`).toEqual([])
      expect(single.incomplete, `${q} single escaped quote`).toBe(1)
      const doubled = scanBackendSites(`backend: ${q}a\\${q}b\\${q}c${q},`)
      expect(doubled.found, `${q} two escaped quotes`).toEqual([])
      expect(doubled.incomplete, `${q} two escaped quotes`).toBe(1)
      const escapedFirst = scanBackendSites(`backend: a ? ${q}x\\${q}y${q} : ${q}mock${q},`)
      expect(escapedFirst.found, `${q} escaped arm before a recognised one`).toEqual(['mock'])
      expect(escapedFirst.incomplete, `${q} escaped arm before a recognised one`).toBe(1)
    }
  })

  it('a quoted region the scanner cannot classify marks the site incomplete even beside a recognised arm', () => {
    // The F8 vanishing class in its escape form: with `n === 0` as the only
    // incomplete trigger, `a ? 'mock' : 'x\'y'` reported found=['mock'] with
    // incomplete=0 and the second arm vanished (an upper-case label did the
    // same, for the unrelated reason that it never matched the regex). Any
    // region that is not a static [a-z-]+ literal now counts the site
    // incomplete; the recognised arm stays in `found` so the report still
    // names what it did see.
    const escaped = scanBackendSites("backend: a ? 'mock' : 'x\\'y',")
    expect(escaped.found).toEqual(['mock'])
    expect(escaped.incomplete).toBe(1)
    const upper = scanBackendSites("backend: a ? 'mock' : 'ONNX',")
    expect(upper.found).toEqual(['mock'])
    expect(upper.incomplete).toBe(1)
  })

  it('an unterminated quote at the end of the source is incomplete, never a literal', () => {
    // The span bounder treats quotes as opaque, so a source that ends inside
    // a string (a truncated read) runs the span to the end. The region's
    // content is a clean `onnx`; only its missing closing quote says the
    // read was cut. Pins the `terminated` half of the recognition predicate.
    const scan = scanBackendSites("backend: 'onnx")
    expect(scan.sites).toBe(1)
    expect(scan.found).toEqual([])
    expect(scan.incomplete).toBe(1)
  })

  it('a truncated arm BESIDE a recognised one is incomplete -- pins the unterminated push', () => {
    // Governance on 8edd4fcef (F1). The single-arm case above cannot tell
    // "the unterminated region was pushed and marked unrecognised" from "no
    // region was pushed at all": there `recognised === 0` fires either way.
    // With a recognised arm beside it, dropping the trailing push leaves
    // recognised=1, unrecognised=0, and the truncated arm vanishes at
    // incomplete=0 -- the F8 shape in its truncation form.
    const beside = scanBackendSites("backend: a ? 'mock' : 'onnx")
    expect(beside.found).toEqual(['mock'])
    expect(beside.incomplete).toBe(1)
  })

  it('an empty string literal is not a static enum label -- pins the class quantifier', () => {
    // Governance on 8edd4fcef (F2). `''` is a TERMINATED region whose content
    // is the empty string. Under `[a-z-]*` it is recognised, lands in `found`
    // as '', and satisfies `recognised > 0`, so a site that is entirely an
    // empty label reads incomplete=0. The `+` quantifier is the only thing
    // rejecting it.
    const alone = scanBackendSites("backend: '',")
    expect(alone.found).toEqual([])
    expect(alone.incomplete).toBe(1)
    const beside = scanBackendSites("backend: a ? '' : 'mock',")
    expect(beside.found).toEqual(['mock'])
    expect(beside.incomplete).toBe(1)
  })

  it('a computed value built by a call, an index or a default is incomplete', () => {
    // Governance on 8edd4fcef (F3). `+` was one instance of "computed", not
    // the rule; each of these reported its operands as static literals at
    // incomplete=0, the B1.2 defect one operator over.
    for (const src of [
      "backend: pick('mock','onnx'),",
      "backend: cfg['mock'],",
      "backend: opts.backend || 'mock',",
      "backend: opts.backend ?? 'mock',",
    ]) {
      const scan = scanBackendSites(src)
      expect(scan.found, src).toEqual([])
      expect(scan.incomplete, src).toBe(1)
    }
  })

  it('an unquoted arm, a literal in condition position, or two adjacent literals is computed -- the grammar sees position, a character class cannot', () => {
    // PR #2900 gate round 3: `x ? 'mock' : y ? 'onnx' : fallback` read as
    // found=['mock','onnx'], incomplete=0 under the character allowlist,
    // because identifier characters must be allowed in condition position
    // and a class cannot tell an arm from a condition. The drift guard's
    // `found` equality AND its `incomplete === 0` both passed on that
    // shape. The grammar is now checked positionally over the span's
    // shape; every row here is rejected by it, and the last three were
    // reachable holes the previous rounds had named (adjacent literals,
    // a numeric condition, a spread).
    for (const src of [
      "backend: x ? 'mock' : y ? 'onnx' : fallback,",
      "backend: x ? 'mock' : fallback,",
      "backend: x === 'a' ? 'mock' : 'onnx',",
      "backend: a ? b : c ? 'mock' : 'onnx',",
      "backend: 'a' ? 'mock' : 'onnx',",
      "backend: { a: 'mock' },",
      "backend: 'onnx' 'mock',",
      "backend: 1.5 ? 'mock' : 'onnx',",
      "backend: ...x ? 'mock' : 'onnx',",
      // Governance on 243912894 (F-A): the decisive shape simulates the
      // real memory-bridge.js site gaining one unquoted arm -- sites, found
      // AND incomplete all sat at their expected values while upstream
      // emitted a third, unnamed backend. And the rest of that family:
      // a member, an optional chain, a number, a keyword in a VALUE position.
      "backend: isMock ? 'mock' : useGpu ? 'onnx' : gpuLabel,",
      "backend: a ? 'mock' : cfg.backend,",
      "backend: a ? 'mock' : a?.b,",
      "backend: a ? 'mock' : 1.5,",
      "backend: a ? 'mock' : null,",
      // Governance on 243912894 (F-C): the grammar is closed -- a negated
      // or compared condition is not an identifier chain.
      "backend: !isMock ? 'mock' : 'onnx',",
      "backend: x === 1 ? 'mock' : 'onnx',",
    ]) {
      const scan = scanBackendSites(src)
      expect(scan.found, src).toEqual([])
      expect(scan.incomplete, src).toBe(1)
    }
  })

  it('a ternary over an identifier, a member or an optional chain is still static -- pins what the grammar allows', () => {
    // The grammar must not swallow the shapes the real upstream trees use:
    // an identifier, a member chain or an optional chain in condition
    // position, literal arms, any whitespace including none (the minified
    // form), and a condition that happens to be spelled like an arm name.
    for (const src of [
      "backend: isMock ? 'mock' : 'onnx',",
      "backend: opts.mode ? 'mock' : 'onnx',",
      "backend: a?.b ? 'mock' : 'onnx',",
      'backend:t?"mock":"onnx"}',
      "backend: fallback ? 'mock' : 'onnx',",
      "backend: isMock\n  ? 'mock'\n  : 'onnx',",
      "backend: $isMock ? 'mock' : 'onnx',",
      "backend: _is_mock ? 'mock' : 'onnx',",
    ]) {
      const scan = scanBackendSites(src)
      expect(scan.found, src).toEqual(['mock', 'onnx'])
      expect(scan.incomplete, src).toBe(0)
    }
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

  it('a `backend:` inside a string, template or comment is not a site -- the colon must be code (SMI-6781)', () => {
    // PR #2900 gate round 4, recorded unfixed under the stopping rule and
    // fixed here under the owner's named exception: BACKEND_SITE_RE ran over
    // raw source, so `const note = "backend: 'mock',"; const x={backend:
    // 'onnx'}` scanned as sites=2, found=['mock','onnx'], incomplete=0 -- a
    // vanished real site could be masked by same-shaped quoted text with
    // every drift-guard assertion green. A content map now marks string and
    // template content and both comment kinds; a match counts only when its
    // colon is code. The colon, not the match start: a string whose CONTENT
    // begins with `backend` starts its match at the string's own opening
    // quote, which is code, and the colon is what tells that case from a
    // quoted key. Not covered, and recorded on SMI-6781 with a verified fix:
    // a string whose content ENDS with `backend`, and a regex literal that
    // carries a quote.
    for (const src of [
      "const note = \"backend: 'mock',\"; const x={backend: 'onnx'}",
      "backend: 'onnx', note: \"backend: 'mock',\",",
      "const note = \"'backend': 'mock',\"; backend: 'onnx',",
      "backend: 'onnx', // backend: 'mock',\nx: 1",
      "// 'backend': 'mock',\nbackend: 'onnx',",
      "/* backend: 'mock', */ backend: 'onnx',",
      "backend: 'onnx', /* 'backend': 'mock' */",
      "label: `backend: 'mock',`, backend: 'onnx',",
      "s: `backend: ${x}`, backend: 'onnx',",
    ]) {
      const scan = scanBackendSites(src)
      expect(scan.sites, src).toBe(1)
      expect(scan.found, src).toEqual(['onnx'])
      expect(scan.incomplete, src).toBe(0)
    }
  })

  it('a quoted key is still a site, and `//` or `/*` inside a string is not a comment', () => {
    // The map's one consulted position is the colon, which is code for a
    // quoted key (`'backend':`) and content for a `backend:` inside a string;
    // string state is consulted before a comment opener, so a URL or a `/*`
    // inside a string starts nothing. (An earlier comment here credited the
    // delimiters staying unmasked; masking them changes no verdict.)
    for (const src of [
      "'backend': 'onnx',",
      '"backend": \'onnx\',',
      "url: 'http://x', backend: 'onnx',",
      "s: 'a/*b', backend: 'onnx',",
      'x="//";backend:\'onnx\',',
      "s: 'it\\'s', backend: 'onnx',",
      "s: 'a\\\\', backend: 'onnx',",
      "a / b; backend: 'onnx',",
    ]) {
      const scan = scanBackendSites(src)
      expect(scan.sites, src).toBe(1)
      expect(scan.found, src).toEqual(['onnx'])
    }
  })

  it('an unclosed block comment masks to the end of the source -- loud, never a phantom site', () => {
    expect(scanBackendSites("/* never closed backend: 'onnx',").sites).toBe(0)
  })

  it('a key that merely ends in `backend` is not a site -- pins the lookbehind behind the exact site count', () => {
    // Governance on 243912894 (F-F): the drift guard pins `sites` exactly,
    // and the negative lookbehind is the only thing keeping `dbBackend:`
    // and `x.backend:` out of that count.
    expect(scanBackendSites("dbBackend: 'mock', a.backend: 'onnx',").sites).toBe(0)
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

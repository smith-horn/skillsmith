/**
 * @fileoverview T-G3 (pure classifier) for the update eligibility gate's
 *   classifier (SMI-6532, A2 step 4).
 * @module @skillsmith/core/services/update-target-gate.purity.test
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.3
 *
 * "Fails if `classifyUpdateTarget` makes any call on a recording fs mock."
 * Each is mocked with a PLAIN OBJECT whose EVERY function export is a
 * recording `vi.fn()`, derived from the real module at mock time rather than
 * hand-listed.
 *
 * Four `vi.mock` specifiers are registered below but only TWO are in force:
 * vitest normalises a bare builtin specifier onto the `node:`-prefixed
 * registry key, so `vi.mock('node:fs', …)` overrides `vi.mock('fs', …)` and a
 * bare `import 'fs'` is served by — and records under — the `node:fs` mock.
 * The bare pair is kept as belt-and-braces against that normalisation
 * changing, not because it currently does anything. This is measured, not
 * assumed: the behavioural control at the foot of this file imports bare and
 * asserts the recorded label carries the `node:` prefix, so the day the
 * normalisation changes, that test says so.
 *
 * An earlier version of this file listed exactly the two methods the
 * classifier's import graph reaches today (`readdir`, `readFile`, via
 * `update-target-gate` -> `.rules` -> `local-skill-scan`'s module-scope
 * `import * as fs`). That enumeration was correct and still carried a defect:
 * a call to any method NOT on the list left no record and no error, so it
 * passed silently, and nothing enforced the standing obligation to revisit
 * the list as the graph grew. Deriving the surface removes both the list and
 * the obligation. Measured: `fs.stat` inside a `try/catch` — unlisted, and so
 * invisible before — now fails both tests.
 *
 * WHY A PLAIN OBJECT, NOT A PROXY (SMI-6841 finding 1 — the prior version of
 * this file used `new Proxy({}, { get })`, whose recorder never actually
 * fired). `new Proxy({}, { get })` has no OWN keys — `Object.keys()` on it
 * returns `[]`, since the Proxy has no `ownKeys` trap of its own and falls
 * back to the empty target — so it declares zero exports to Vitest's ESM
 * mock interop, which refused every named-export access with its own `No
 * "readdir" export is defined on the "fs/promises" mock` before the Proxy's
 * `get` trap ever ran. Measured with controls: a direct call to the mocked
 * `fs/promises` threw exactly that Vitest-native error, never this file's own
 * diagnostic; a real `fs.readdir` call injected into `local-skill-scan.ts`
 * left `recordedCalls` empty under the OLD Proxy mock; the same call with the
 * mock removed entirely returned a real directory entry — so the mock WAS in
 * force, the recorder simply never ran, and `expect(recordedCalls).toEqual([])`
 * could never fail no matter what the code under test did. A plain object
 * literal has real, enumerable own keys, so Vitest's export check passes and
 * a genuine call reaches the `vi.fn()` below, which both records AND throws.
 * This also removes the old Proxy's `then`-special-casing entirely: a plain
 * object with no `then` property of its own is never mistaken by `await` for
 * a thenable, unlike the Proxy this file used to return.
 *
 * T-G3's GUARANTEE, MEASURED RATHER THAN ASSUMED (SMI-6841 finding 2). Finding
 * 2 hypothesized this mechanism — record, then throw — only fails the test
 * when the throw goes UNCAUGHT out of
 * `classifyUpdateTarget`, since `scanLocalSkills` (same module as
 * `isBackupDir`, though not itself in this classifier's reachable graph) is
 * ITSELF a catch-and-continue shape around both `fs.readdir` and
 * `fs.readFile` — a realistic future shape for this gap, not a purely
 * theoretical one, if a rule ever called into it instead of the pure
 * `isBackupDir`. Verified directly (both halves reverted after confirming),
 * once finding 1's Proxy -> plain-object fix was in place: an uncaught
 * `fs.readdir(...)` call added to `isBackupDir` makes this file's first `it`
 * FAIL, as expected; the identical call wrapped in its own `try {} catch {}`
 * ALSO makes it FAIL — not pass, contrary to the hypothesis — because
 * `recordedCalls.push` runs (and is asserted against directly, not inferred
 * from whether the call "succeeded") BEFORE the throw, and a local
 * `try`/`catch` inside the code under test has no way to reach back into this
 * file's module-scope array and undo that push. So catching the exception
 * downstream does not matter: detection was never about the throw reaching
 * this file. The throw's remaining job is to stop the code under test from
 * proceeding on a fake return value.
 *
 * TWO HOLES THAT ARE NOT OBVIOUS, both closed by the recursion in
 * `wrapNamespace` (SMI-6841, governance round 3). `default` and `promises` are
 * OBJECTS, so a naive "wrap the functions, pass everything else through" walk
 * treats them as inert values — while each re-exposes the module's entire real
 * function set under a different access path. Measured against the mock object
 * itself: a namespace call threw and recorded; the same call reached as
 * `import fs from 'node:fs/promises'` did neither, performing real I/O in
 * silence. The default-import style is already live in this package
 * (`analysis/file-streamer.ts:11`), so this was a live hole rather than a
 * theoretical one. Both nested namespaces are now wrapped recursively.
 *
 * The shape to notice: every defect in this mechanism has been an assertion
 * whose SUBJECT was broader than the thing it named. The Proxy recorded
 * nothing; the hand-list recorded only two methods; the derived surface
 * skipped two nested namespaces; the first control set covered three access
 * paths and so covered none of `node:fs`'s own. Every version passed its own
 * suite. Treat a green run here as evidence only about what the control
 * quantifies over — which is why the control below is an invariant rather than
 * a list, and why its expected set is derived from the real module rather than
 * from the mock.
 *
 * What it quantifies over, stated exactly rather than as "everything": every
 * function the real module exposes at ANY key kind, ANY enumerability, own or
 * inherited, at each of three levels — exported by a mocked module, on the
 * `default` and `promises` namespaces those modules re-expose, and owned by one
 * of those functions — with the exception of any key for which the mock already
 * resolves the IDENTICAL function object (`bind`, `apply`, `hasOwnProperty` and
 * the rest of `Function.prototype` / `Object.prototype`), which must be left
 * alone rather than replaced by a throwing spy.
 *
 * ONE DECLARED RESIDUAL: a defect keyed on argument CONTENT rather than arity.
 *
 * There used to be a second, and its history is the most useful thing in this
 * file. The mock re-attached only own, enumerable, string-keyed members, so the
 * four stream constructors' 142 inherited statics were absent from it — meaning
 * a real `fs.ReadStream.from(...)` call in the classifier would have performed
 * I/O in silence, recording nothing and failing nothing.
 *
 * Four consecutive review rounds improved the DESCRIPTION of that hole: a count,
 * then an owner set, then per-owner members, then an injectively-encoded property
 * key with a collision ledger. Each round found the previous round's description
 * too loose and each fix was correct. None of them closed the hole, and the
 * claim "asserted by identity" was false at a new depth after every one.
 *
 * It closed in one predicate: `wrapNamespace` walks the real module reflectively,
 * as the differential does, and wraps everything the mock does not already share.
 * "The same surface" would overstate it in two measured ways: the wrapper READS
 * namespace-level accessors (which is where `default`'s lazily-defined stream
 * constructors come from) while the differential counts and skips them, and the
 * wrapper stays string-keyed at the namespace level for vitest's ESM interop
 * while walking symbols at the member level. The domains overlap on exactly what
 * matters — data-property callables — which is why gaps reach zero.
 * Gaps went 143 -> 0, and with them went the 71-line static table, the key
 * encoder, the collision ledger, its known-positive, and a per-owner sum check —
 * about 130 lines whose entire job was describing functions the mock should have
 * carried. The differential remains, asserting ZERO per path, which is a
 * stronger statement than any characterisation of a non-empty gap set.
 *
 * The lesson is not "the reviews were wrong" — every finding was real. It is that
 * four rounds of increasingly precise description never asked whether the thing
 * being described should exist. Accuracy about a hole is not a guard.
 *
 * Five outcomes, each saying only what it measures — SHARED means the same
 * function object resolved on both sides, not shared provenance; WRAPPED means
 * the mock resolved SOME function, with record-and-throw proven by the `exercise`
 * loop over the REACHABLE surface only, not re-proven here; GAP means the mock
 * resolved nothing, asserted absent; UNSAFE means the lookup threw, kept separate
 * because "unresolvable" is not "absent"; ACCESSOR means a getter or setter-only
 * property, counted and deliberately not invoked by the differential.
 *
 * UNSAFE is asserted zero on every path, and a branch that cannot fire yields
 * that same zero, so a known-positive drives it through the same classifier a
 * throwing lookup would reach.
 *
 * `gaps: 0` is not vacuous, but NOT for the reason an earlier draft of this
 * paragraph gave. It cited the large accessor counts, which prove nothing about
 * the gap domain — accessors are a DIFFERENT population, counted and skipped, so
 * a big accessor surface is compatible with an empty callable one. What actually
 * establishes it is the pair of assertions at the foot of the control:
 * `expectedTotal > 25`, and the exact call and construction totals, which
 * together require a substantial data-property callable domain to have been
 * walked and exercised. A zero over an empty domain would fail those.
 *
 * One asymmetry worth knowing, found by measuring rather than predicted: on the
 * ESM namespace the stream classes are DATA properties, so the walk reaches them
 * directly; on `default` — the CJS `module.exports` — the same classes are lazy
 * GETTERS, so the differential counts them as accessors and declines to invoke
 * them. Same function objects, opposite classification, because the two views
 * define them differently. Their inherited statics USED to count as gaps on the
 * ESM side, which is what the deleted 71-line table enumerated; they are wrapped
 * now, so they are gaps nowhere. The asymmetry survives only in the accessor
 * counts.
 *
 * The literal counts are a Node-shape canary, not a portable invariant: this
 * package supports `>=22.22.0` while CI tracks the moving Node 22 line, so a
 * legitimate Node update can change them and require this fixture updated.
 * That is the intended failure mode. SMI-6841 holds the measured instances and
 * the mutation that killed each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManifestEvidence } from './update-target.evidence.js'
import type { ProbeOk, ProbeOutcome } from './update-target.probe.js'
import type { UpdateTargetPlan } from './update-target-gate.types.js'

const recordedCalls: string[] = []

/**
 * Wrap EVERY function export the real module has, rather than a hand-listed
 * subset.
 *
 * An earlier version listed `['readdir', 'readFile']` — the two methods the
 * classifier's import graph reaches today — and carried an obligation to
 * revisit that list whenever the graph grew. Nothing enforced the obligation,
 * and a call to an undeclared method left no trace and no error: it passed
 * silently, which is the exact shape this whole file exists to detect.
 * Deriving the surface from the module means a method that is added to the
 * graph tomorrow is already covered, with no list to maintain and nothing to
 * forget.
 *
 * `default` and `promises` are NOT passed through, and that is the whole point
 * of the recursion below. Both are objects, so `typeof value !== 'function'`
 * treats them as inert values — but each carries the module's entire REAL
 * function set. Passing them through leaves two silent holes: a call reached
 * as `import fs from 'node:fs/promises'` (the default import) or as
 * `fs.promises.readFile(...)` performs genuine I/O and records nothing, so
 * `expect(recordedCalls).toEqual([])` stays green through exactly the thing it
 * exists to catch. Measured: namespace call throws and records; default-import
 * call did neither. Not hypothetical — the default-import style is already live
 * in this package at `analysis/file-streamer.ts:11`.
 *
 * Everything else non-function (`constants`, `F_OK`, and similar) does pass
 * through: reading a value is not I/O, and replacing it would break importers
 * that only read it.
 *
 * Classes (`Stats`, `Dirent`, `ReadStream`) are functions and so become spies
 * too. An earlier version of this comment said they "become throwing spies,
 * which is stricter than the alternative and fine" — measured, that was wrong
 * in the direction that reads as reassuring. While the spy body was an arrow,
 * `new fs.Stats()` threw V8's own `is not a constructor` TypeError BEFORE the
 * body ran and recorded nothing: containment held, detection did not, so a
 * construction attempt behind a catch-and-continue left the purity verdict
 * green. The body is a `function` expression now, so construction records and
 * throws this file's own diagnostic like any other call, and the control
 * exercises `new` as its own call path.
 */
async function recordingModule(moduleName: string): Promise<Record<string, unknown>> {
  const actual = (await vi.importActual(moduleName)) as Record<string, unknown>
  return wrapNamespace(actual, moduleName)
}

/**
 * One recording spy, labelled by the full access path it sits at.
 *
 * A `function` expression, deliberately NOT an arrow: an arrow is not a
 * constructor, so `new fs.Stats()` threw V8's own `is not a constructor`
 * TypeError and recorded NOTHING (measured). Containment survived, since the
 * TypeError still stops the caller, but detection did not — behind a
 * catch-and-continue the purity verdict stayed green through a live
 * construction attempt. A `function` expression records and throws this file's
 * own diagnostic whether called or constructed.
 */
function makeRecordingSpy(label: string): (...args: unknown[]) => unknown {
  return vi.fn(function (...args: unknown[]) {
    // Render defensively: `String(Object.create(null))` THROWS (measured
    // in-container), and the template literal is evaluated before `push`
    // completes — so an argument that cannot be stringified would make this
    // spy throw WITHOUT recording, losing detection for that call. The
    // diagnostic degrades to an arity instead of taking the recorder down.
    let rendered: string
    try {
      rendered = args.map(String).join(', ')
    } catch {
      rendered = `<${args.length} unrenderable argument(s)>`
    }
    recordedCalls.push(`${label}(${rendered})`)
    throw new Error(
      `classifyUpdateTarget must be pure — ${label}() was called, which ` +
        'means this rule table (or something it imports) did I/O instead of reading ' +
        'already-resolved evidence/probe/plan data (T-G3)'
    )
  })
}

/**
 * Every key the real object exposes — own or inherited, enumerable or not,
 * string or symbol — paired with its value, EXCEPT any key for which `target`
 * already resolves the identical function.
 *
 * That exclusion is the load-bearing part. `Function.prototype` supplies
 * `bind`, `call`, `apply`, `toString`; `Object.prototype` supplies
 * `hasOwnProperty` and friends. The spy and the mock namespace inherit those
 * same function objects, so wrapping them would REPLACE working machinery with
 * throwing spies and break vitest itself rather than guard anything. Excluding
 * "the target already has this exact function" is also precisely the condition
 * under which the differential below reports a GAP — so the mock now closes
 * exactly what that differential would otherwise merely characterise.
 *
 * Accessors are READ, not skipped, because `Object.entries` already invoked
 * every enumerable getter here and that is where `default`'s lazily-defined
 * stream constructors come from; dropping them would narrow the mock. A getter
 * that throws is skipped rather than allowed to fail mock construction.
 */
function reflectiveEntries(
  source: Record<string | symbol, unknown>,
  target: object,
  stringKeysOnly: boolean
): Array<[string | symbol, unknown, PropertyDescriptor | undefined]> {
  // The third element is the REAL OWN DESCRIPTOR when the key is own on `source`,
  // and `undefined` when the key was found further up the prototype chain. Both
  // halves matter: the descriptor carries `enumerable`/`writable`, and the
  // own-versus-inherited distinction decides whether the wrapper may install the
  // member on the mock itself or must put it behind a prototype, because
  // promoting an inherited member to an own one is observable to `Object.hasOwn`,
  // `getOwnPropertyNames` and `Reflect.ownKeys`.
  const entries: Array<[string | symbol, unknown, PropertyDescriptor | undefined]> = []
  const seen = new Set<string | symbol>()
  let depth = 0
  let cur: object | null = source
  while (cur !== null) {
    for (const key of Reflect.ownKeys(cur)) {
      if (seen.has(key)) continue
      seen.add(key)
      // MEASURED EQUIVALENCE AT THE NAMESPACE LEVEL, stated because reverting
      // this walk to `Object.entries` leaves all seven tests green. That is an
      // EQUIVALENT MUTANT, not an uncovered gap: for FUNCTIONS the two walks
      // agree exactly on today's surface (107/107 on `node:fs`, 33/33 on
      // `node:fs/promises`, and the same at every `default`/`promises` view),
      // with `__proto__` the only key reflection adds and it is not callable.
      // Kept anyway, for symmetry with the member walk and because a future
      // non-enumerable function export would then be wrapped automatically
      // rather than surfacing as a differential failure. The member walk is the
      // half that is load-bearing today: reverting THAT one takes gaps 0 -> 143.
      //
      // Vitest's ESM interop reads the mock namespace's own STRING keys to
      // decide which named exports exist, so the namespace level stays
      // string-keyed. A function has no such constraint, and `exists`'s
      // `Symbol(nodejs.util.promisify.custom)` is exactly the callable that
      // needs wrapping — it was the last surviving gap once the others closed.
      if (stringKeysOnly && typeof key !== 'string') continue
      // `__proto__` is an Object.prototype ACCESSOR, so walking to the prototype
      // reaches it where `Object.entries` did not. Reading it yields the
      // prototype object and assigning it would invoke the setter and rewire the
      // mock's prototype chain — measured as the ONLY key the reflective walk
      // adds at the namespace level. It is never a callable, so skipping it
      // costs no coverage and avoids mutating the object being built.
      if (key === '__proto__') continue
      let value: unknown
      try {
        value = source[key]
      } catch {
        continue
      }
      if (
        typeof value === 'function' &&
        (target as Record<string | symbol, unknown>)[key] === value
      )
        continue
      const desc = Object.getOwnPropertyDescriptor(cur, key)
      entries.push([key, value, depth === 0 ? desc : undefined])
    }
    cur = Object.getPrototypeOf(cur)
    depth += 1
  }
  return entries
}

/** Wrap every function on `ns`, recursing into the two nested namespaces that
 * re-expose the same functions under a different access path, and re-attaching
 * every callable a callable exposes at any key kind and any depth. */
function wrapNamespace(ns: Record<string, unknown>, moduleName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of reflectiveEntries(ns, out, true)) {
    const name = key as string
    if (name === 'default' || name === 'promises') {
      out[name] = wrapNamespace(value as Record<string, unknown>, `${moduleName}.${name}`)
      continue
    }
    if (typeof value !== 'function') {
      out[name] = value
      continue
    }
    const spy = makeRecordingSpy(`${moduleName}.${name}`)

    // A CALLABLE CAN OWN A CALLABLE, and `vi.fn()` does not carry it across.
    // `node:fs` exposes exactly two (measured in-container): `realpath.native`
    // and `realpathSync.native`. Without this loop the mock has `realpath` as
    // a spy and no `.native` at all, so a real `fs.realpath.native(...)` call
    // throws a bare TypeError that any catch-and-continue swallows, recording
    // nothing — measured: a live `realpath.native` call added to
    // `classifyUpdateTarget` left all seven tests GREEN.
    //
    // An earlier version of this file NAMED this hole in a comment and left it
    // open, which is worse than not noticing: the note read as diligence while
    // the guarantee one screen above it stayed false.
    //
    // This walk used to be `Object.entries(value)` — own, enumerable, string —
    // which left the four stream constructors' 142 inherited statics unwrapped.
    // Four review rounds then went into characterising that hole with rising
    // precision: a count, then an owner set, then per-owner members, then an
    // injectively-encoded key. All four described the hole; none closed it, and
    // a real `fs.ReadStream.from(...)` call would have done silent I/O
    // throughout. Closing it deletes the characterisation and turns a documented
    // gap into an actual guard, which is what the differential was only ever
    // standing in for.
    // OWN MEMBERS GO ON THE SPY; INHERITED MEMBERS GO BEHIND IT. Two rounds were
    // spent getting this right and each fix was narrower than the problem.
    //
    // Round 8: forcing `enumerable: true` promoted hidden members into
    // `Object.keys`, spread and `Object.assign`. Mirroring enumerability fixed
    // that. Round 9: mirroring enumerability does NOT preserve OWN-ness, and an
    // inherited static installed as a non-enumerable OWN property is still
    // visible to `Object.hasOwn`, `getOwnPropertyNames` and `Reflect.ownKeys`
    // where production has nothing. Code that discovers constructor statics that
    // way and then calls them would make a call under the mock that production
    // never makes — a FALSE purity failure, the mock becoming the defect.
    //
    // So inherited wrapped members are installed on a shadow prototype spliced
    // between the spy and `Function.prototype`. Own-ness is then preserved
    // exactly; lookup DEPTH is not (everything inherited sits at depth 1 rather
    // than at its original depth), which is a deliberate and stated residual —
    // no reachable check in this codebase reads prototype depth, whereas
    // `hasOwnProperty` is ordinary code.
    //
    // `defineProperty` rather than assignment throughout, because
    // `Function.prototype[Symbol.hasInstance]` is non-writable and a plain
    // `spy[key] = …` THROWS for any real function defining its own — measured: it
    // broke mock construction outright, surfacing as vitest's generic "error when
    // mocking a module".
    const shadow: Record<string | symbol, unknown> = Object.create(Function.prototype)
    let shadowUsed = false
    for (const [member, memberValue, ownDesc] of reflectiveEntries(
      value as unknown as Record<string | symbol, unknown>,
      spy,
      false
    )) {
      if (typeof memberValue !== 'function') continue
      const wrapped = makeRecordingSpy(`${moduleName}.${name}.${String(member)}`)
      if (ownDesc !== undefined) {
        // Own on the real function: mirror its descriptor. `writable` is mirrored
        // rather than hardcoded so a non-writable real static does not become
        // assignable on the mock.
        Object.defineProperty(spy, member, {
          value: wrapped,
          writable: ownDesc.writable === true,
          enumerable: ownDesc.enumerable === true,
          configurable: ownDesc.configurable === true,
        })
        continue
      }
      // Inherited on the real function: keep it inherited here too. Left
      // writable and configurable deliberately, NOT mirrored from the defining
      // prototype. The reason first given for that was WRONG, and measured to be
      // wrong rather than argued: `delete spy.from` returns true whether the
      // shadow's property is configurable or not, because deletion targets the
      // receiver's own property and there is none — verified in-container, with a
      // control confirming that deleting an OWN non-configurable property does
      // throw, so the probe could have seen a difference. Configurability here
      // only matters to code reflecting on or mutating the shadow object itself,
      // which nothing does. Left permissive so this synthetic object never
      // refuses an operation the real prototype chain would allow; the asymmetry
      // with the own branch, which mirrors its descriptor exactly, is
      // intentional.
      Object.defineProperty(shadow, member, {
        value: wrapped,
        writable: true,
        enumerable: false,
        configurable: true,
      })
      shadowUsed = true
    }
    if (shadowUsed) Object.setPrototypeOf(spy, shadow)
    out[name] = spy
  }
  return out
}

vi.mock('fs/promises', async () => recordingModule('fs/promises'))
vi.mock('fs', async () => recordingModule('fs'))
vi.mock('node:fs/promises', async () => recordingModule('node:fs/promises'))
vi.mock('node:fs', async () => recordingModule('node:fs'))

beforeEach(() => {
  recordedCalls.length = 0
})
afterEach(() => {
  vi.clearAllMocks()
})

// ── Minimal fixtures, one per ROW_ORDER position ────────────────────────
// Deliberately NOT shared with `update-target-gate.test.ts`'s richer
// builders: this file's only job is "did anything call fs", so its
// fixtures stay maximally minimal rather than realistic — less to read
// when this file's one failure mode fires.

const EVIDENCE: ManifestEvidence = {
  manifestKey: 'foo',
  entry: {
    id: 'o/foo',
    name: 'foo',
    version: '1.0.0',
    source: 'github:o/foo',
    installPath: '/s/foo',
    installedAt: 'x',
    lastUpdated: 'x',
    verifiedAt: 'x',
  },
  canonicalId: 'o/foo',
  source: 'github:o/foo',
  provenance: 'registry',
  pinnedVersion: null,
  updatePolicy: null,
  disqualifiedBy: null,
}
const PROBE_OK: ProbeOk = {
  kind: 'ok',
  gitAncestor: { kind: 'none' },
  skillMdHash: 'h1',
  files: [{ rel: 'SKILL.md', sha256: 'h1' }],
}
const PLAN: UpdateTargetPlan = {
  dirName: 'foo',
  manifestUnreadable: false,
  recoveryRecordUnreadable: false,
  identityMismatch: null,
  fetchOutcome: 'ok',
  writeSet: [{ rel: 'SKILL.md', mode: 'modify' }],
  originalContentHash: 'h1',
  fileHashes: {},
}

const ROW_FIXTURES: Record<
  string,
  { evidence: ManifestEvidence; probe: ProbeOutcome; plan: UpdateTargetPlan }
> = {
  '0a': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, manifestUnreadable: true } },
  '0b': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, recoveryRecordUnreadable: true } },
  '2': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, dirName: 'foo.backup-1' } },
  '3': { evidence: EVIDENCE, probe: { kind: 'recovery-pending' }, plan: PLAN },
  '4': { evidence: { ...EVIDENCE, disqualifiedBy: 'no-entry' }, probe: PROBE_OK, plan: PLAN },
  '5': {
    evidence: EVIDENCE,
    probe: { ...PROBE_OK, gitAncestor: { kind: 'found', path: '/s/foo/.git' } },
    plan: PLAN,
  },
  '5b': {
    evidence: EVIDENCE,
    probe: { ...PROBE_OK, gitAncestor: { kind: 'undetermined', reason: 'escapes-root' } },
    plan: PLAN,
  },
  '6': {
    evidence: { ...EVIDENCE, provenance: null, source: 'unknown' },
    probe: PROBE_OK,
    plan: PLAN,
  },
  '7': {
    evidence: { ...EVIDENCE, provenance: 'local', source: 'github:o/foo' },
    probe: PROBE_OK,
    plan: PLAN,
  },
  '8': {
    evidence: { ...EVIDENCE, provenance: null, source: 'github:o/foo' },
    probe: PROBE_OK,
    plan: PLAN,
  },
  '9': { evidence: { ...EVIDENCE, pinnedVersion: '1.0.0' }, probe: PROBE_OK, plan: PLAN },
  '10': {
    evidence: EVIDENCE,
    probe: PROBE_OK,
    plan: { ...PLAN, identityMismatch: { ownerManifestKey: 'foo::claude-code' } },
  },
  '11': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, fetchOutcome: 'fetch-failed' } },
  '12': {
    evidence: EVIDENCE,
    probe: { ...PROBE_OK, files: [{ rel: 'SKILL.md', sha256: null, entryType: 'symlink' }] },
    plan: PLAN,
  },
  '13': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, originalContentHash: null } },
  '14': {
    evidence: EVIDENCE,
    probe: { ...PROBE_OK, files: [{ rel: 'SKILL.md', sha256: 'CHANGED' }] },
    plan: PLAN,
  },
  '15': { evidence: EVIDENCE, probe: PROBE_OK, plan: { ...PLAN, writeSet: [] } },
  '16': { evidence: EVIDENCE, probe: PROBE_OK, plan: PLAN },
}

describe('classifyUpdateTarget — T-G3 purity', () => {
  it('makes zero fs calls across every reachable row, given only already-resolved data', async () => {
    const { classifyUpdateTarget } = await import('./update-target-gate.js')
    const { CLASSIFICATION_RULES, ROW_ORDER } = await import('./update-target-gate.rules.js')

    // Exercise one fixture per ROW_ORDER position (not merely per reason —
    // §4.1's I/O-purity property is about EVERY row the table can reach,
    // including the ones the original (corrected) resolver-parameter text
    // would have violated).
    for (const row of ROW_ORDER) {
      const fixture = ROW_FIXTURES[row]
      expect(fixture, `no purity fixture registered for row ${row}`).toBeDefined()
      classifyUpdateTarget(fixture.evidence, fixture.probe, fixture.plan)
    }

    expect(recordedCalls).toEqual([])
    expect(ROW_ORDER.length).toBeGreaterThan(0)
    expect(CLASSIFICATION_RULES.length).toBeGreaterThanOrEqual(ROW_ORDER.length)
  })

  it('does not call fs even when a rule is asked about a backup-dir name that looks path-like', async () => {
    const { classifyUpdateTarget } = await import('./update-target-gate.js')
    const base = ROW_FIXTURES['2']
    classifyUpdateTarget(base.evidence, base.probe, {
      ...base.plan,
      dirName: '../../etc/passwd.backup-1',
    })
    expect(recordedCalls).toEqual([])
  })
})

// ── Known-positive control for the recorder itself ──────────────────────
//
// Every test above asserts `recordedCalls` is EMPTY. That is a known-negative
// only, and an instrument returning the same value for both states measures
// nothing. Measured: replacing `recordingModule`'s body with `return actual`
// — disabling the recorder completely, so a real fs call does real I/O and
// leaves no trace — left every one of those tests GREEN.
//
// WHY THIS IS AN INVARIANT AND NOT A LIST OF ARMS. The first version of this
// control WAS a list: one arm per access path, for the three paths whose
// absence had each caused a real defect. It was itself an instance of this
// mechanism's recurring shape — a subject broader than the thing it names.
// The arms covered `node:fs/promises` (named), its `default`, and
// `node:fs.promises`, and so covered no part of `node:fs`'s own top-level
// surface. `classifyUpdateTarget` is synchronous, so the realistic accidental
// impurity is `existsSync`/`readFileSync` off `node:fs` — exactly what the
// arms missed. Measured: a `wrapNamespace` passthrough confined to `node:fs`
// left all three arms green while the classifier did unrecorded, unthrown I/O.
//
// WHY IT ASSERTS BEHAVIOUR AND NOT MEMBERSHIP. The version after that walked
// the same surface but asserted only `vi.isMockFunction` — membership in "is
// a mock", not in "is THIS factory's spy" — and carried the gap in prose: a
// comment claiming one behavioural arm sufficed because every spy comes from
// one `vi.fn(...)` factory. True of the code, asserted by nothing, and the
// three defects before it were each "a subset treated differently". Measured:
// a second factory giving every key except `existsSync` a record-only,
// NON-THROWING spy passed all seven tests, while `fs.readFileSync(...)`
// returned `undefined` instead of throwing. Detection survived, since
// `recordedCalls` was still non-empty — but containment, which is the throw's
// whole remaining job, was gone for every function but one.
//
// So the walk below CALLS each function and asserts the pair directly. An
// enumerated arm set can only cover the paths someone thought of, and a
// membership check can only cover the property someone named; quantifying the
// behaviour over the whole reachable surface needs neither list. This kills
// every historical defect in this mechanism — the Proxy wrapping nothing, the
// hand-list wrapping two, the unrecursed `default`/`promises`, the `node:fs`
// passthrough, and the two-factory split — without naming any of them.
//
// Calling every function is safe precisely BECAUSE the mechanism holds: each
// spy throws before reaching real I/O. If that stops being true this test is
// how you find out, which is the point.
describe('the fs recorder — known-positive control (T-G3)', () => {
  // Load each specifier through a static literal, never a variable: a fully
  // dynamic `import(spec)` is not statically analysable and is not guaranteed
  // to reach the mock registry.
  //
  // Four entries, two measurements: vitest serves the bare pair from the
  // `node:` registrations (see the file header), so `fs` and `node:fs` hand
  // back the same object. Kept so the day that stops being true, it shows up
  // here rather than as a silently unmocked import.
  // The walk starts from the CANONICAL (`node:`-prefixed) name, not from the
  // specifier, so its labels line up with the ones the mock records — the mock
  // was built under the canonical name whichever specifier reached it.
  const canonicalNameOf = (specifier: string): string =>
    specifier.startsWith('node:') ? specifier : `node:${specifier}`

  const FS_NAMESPACES = ['', '.default', '.default.promises', '.promises']
  const PROMISES_NAMESPACES = ['', '.default']

  // Third element: how many callable-owned callables the module should expose
  // in total, across its namespaces. `node:fs` has `realpath.native` and
  // `realpathSync.native`, present both at the top level and under `default`,
  // so four; the promises modules have none. Pinned so the oracle below cannot
  // quietly become an empty set and agree with an empty subject.
  const MOCKED_MODULES = [
    ['node:fs', () => import('node:fs'), FS_NAMESPACES, 4],
    ['node:fs/promises', () => import('node:fs/promises'), PROMISES_NAMESPACES, 0],
    ['fs', () => import('fs'), FS_NAMESPACES, 4],
    ['fs/promises', () => import('fs/promises'), PROMISES_NAMESPACES, 0],
  ] as const

  // Every real call the code under test can make carries arguments; the walk
  // used to make none. A spy guarded on `args.length > 0` therefore passed
  // every assertion while returning `undefined` for every genuine fs call —
  // measured, 7 passed. So each spy is exercised across ARITY CLASSES, not
  // just once.
  //
  // Named residual, because this cannot be exhaustive: a defect keyed on
  // argument CONTENT rather than arity (say, a guard on a specific path
  // string) would still survive. That is not covered here and is not claimed
  // to be. The null-prototype case is included because `String()` throws on
  // it, which previously took the recorder down before it could record.
  const ARGUMENT_SHAPES: readonly (readonly unknown[])[] = [
    [],
    ['/probe-path'],
    ['/probe-path', 2, { nested: true }],
    [Object.create(null) as unknown],
  ]

  it.each(MOCKED_MODULES)(
    'every function reachable in the %s mock -- including those a function owns -- records AND throws, at every arity and when constructed',
    async (specifier, load, expectedSuffixes, expectedMemberCount) => {
      const canonical = canonicalNameOf(specifier)
      const failures: string[] = []
      const visitedPaths: string[] = []
      // Which function names were actually exercised, per namespace path. The
      // expectation for this is computed below from `vi.importActual`, NOT
      // from anything the walk produced.
      const examined = new Map<string, string[]>()
      let calls = 0
      let constructions = 0
      const visited = new WeakSet<object>()

      // Exercise ONE spy fully: every arity, plus construction, checking that
      // each call both throws and records under its own label. Extracted so a
      // callable-owned callable gets exactly the same treatment as a
      // namespace-level one rather than a reduced version of it.
      const exercise = (fn: unknown, label: string): void => {
        // Never CALL something that is not a spy — that would be real I/O
        // against the real module.
        if (!vi.isMockFunction(fn)) {
          failures.push(`${label}: not a mock`)
          return
        }
        for (const args of ARGUMENT_SHAPES) {
          calls += 1
          const before = recordedCalls.length
          let threw = false
          try {
            ;(fn as unknown as (...a: readonly unknown[]) => unknown)(...args)
          } catch {
            threw = true
          }
          const added = recordedCalls.slice(before)
          if (!threw) failures.push(`${label}[${args.length} args]: did not throw`)
          if (added.length !== 1) {
            failures.push(`${label}[${args.length} args]: recorded ${added.length} entries`)
            continue
          }
          // Check WHAT was recorded, not merely that the count moved. A spy
          // recording under someone else's label still grows the array, and a
          // length check alone reads that as success.
          if (!added[0].startsWith(`${label}(`)) {
            failures.push(`${label}[${args.length} args]: recorded as ${added[0]}`)
          }
        }

        // Construction is a SEPARATE call path, not another arity. With an
        // arrow implementation `new` threw V8's `is not a constructor` before
        // the body ran, recording nothing — detection lost behind any
        // catch-and-continue, even though containment held.
        constructions += 1
        const beforeNew = recordedCalls.length
        let threwOnNew = false
        try {
          new (fn as unknown as new (...a: unknown[]) => unknown)('/probe-path')
        } catch {
          threwOnNew = true
        }
        const addedByNew = recordedCalls.slice(beforeNew)
        if (!threwOnNew) failures.push(`${label}[new]: did not throw`)
        if (addedByNew.length !== 1) {
          failures.push(`${label}[new]: recorded ${addedByNew.length} entries`)
        } else if (!addedByNew[0].startsWith(`${label}(`)) {
          failures.push(`${label}[new]: recorded as ${addedByNew[0]}`)
        }
      }

      const walk = (obj: Record<string, unknown>, path: string, depth: number): void => {
        // Record only namespaces that actually carry functions. `constants` is
        // walked too but holds none, so including it would make the expected
        // set track Node's data exports rather than the mock's shape.
        if (Object.values(obj).some((v) => typeof v === 'function')) visitedPaths.push(path)
        for (const [key, value] of Object.entries(obj)) {
          const label = `${path}.${key}`
          if (typeof value === 'function') {
            examined.set(path, [...(examined.get(path) ?? []), key])
            exercise(value, label)
            // Callable-owned callables (`fs.realpath.native`) are handled
            // AFTER the walk, driven by the real module. They cannot be
            // enumerated from the spy here: `Object.entries` on a `vi.fn()`
            // returns vitest's own API (`mockClear`, `mockReset`, …), which
            // are functions but not part of the module surface. Measured —
            // doing it that way produced 4,644 spurious failures.
            continue
          }
          // Recurse into nested namespaces. Function-owned properties are
          // handled above rather than here, so this branch only ever sees
          // ordinary namespace objects.
          if (value !== null && typeof value === 'object') {
            if (visited.has(value)) continue
            visited.add(value)
            walk(value as Record<string, unknown>, label, depth + 1)
          }
        }
      }
      const mockRoot = (await load()) as unknown as Record<string, unknown>
      walk(mockRoot, canonical, 0)

      expect(failures).toEqual([])

      // Denominators, because an empty failure list is otherwise both
      // "everything passed" and "nothing was examined". FIVE dimensions --
      // this control has been caught short on three of them, so the count is
      // listed rather than summarised:
      //
      // 1. WHICH NAMESPACES. An exact set, not a count. A single `continue`
      //    in the walk silently dropped the whole `promises` namespace with
      //    every other assertion green (measured) — a count could not see it,
      //    because `default` alone kept the totals large.
      // 2. WHICH FUNCTIONS, per namespace — an exact set from the real
      //    module, since a floor counted off the mock shrank whenever the mock
      //    did (measured: one function removed from the mock, all green).
      // 3. WHICH CALLABLE-OWNED CALLABLES, likewise from the real module:
      //    `vi.fn()` does not carry `realpath.native` across, and both the
      //    walk and a one-level oracle omitted the same edge.
      // 4. HOW MANY calls, pinning each function was exercised at every arity.
      // 5. HOW MANY constructions, pinning `new` was exercised once each.
      expect([...visitedPaths].sort()).toEqual(
        expectedSuffixes.map((s) => `${canonical}${s}`).sort()
      )

      // THE DENOMINATOR COMES FROM AN INDEPENDENT SOURCE. The previous version
      // was `rootFunctions > 25`, counted from the mock — the very thing under
      // test — so anything that made the mock smaller made the denominator
      // smaller with it, and the literal `25` was the only real constraint.
      // Measured, all three green at the time: a walk skipping every `*Sync`
      // name dropped 42 of 98 top-level functions; a walk stopping at 26
      // examined 27%; and — the strong form, in the MECHANISM rather than the
      // control — `if (name === 'readFileSync') continue` in `wrapNamespace`
      // left that function out of the mock altogether. A real call then hit
      // vitest's own `No "readFileSync" export is defined` with
      // `recordedCalls` EMPTY: the round-1 Proxy defect reinstated for one
      // function, and invisible for the same reason it was the first time.
      //
      // So the expected set is derived from `vi.importActual` — the real
      // module — and compared per namespace. It is computed FLATLY at each
      // known path (`Object.entries`, one level, no recursion), never by
      // re-walking, because a walk sharing the traversal bug would shrink both
      // sides equally and agree with itself.
      const actual = (await vi.importActual(canonical)) as Record<string, unknown>
      const resolve = (suffix: string): Record<string, unknown> =>
        suffix
          .split('.')
          .filter(Boolean)
          .reduce((o, k) => o[k] as Record<string, unknown>, actual)
      const resolveMock = (suffix: string): Record<string, unknown> =>
        suffix
          .split('.')
          .filter(Boolean)
          .reduce((o, k) => o[k] as Record<string, unknown>, mockRoot)

      let expectedTotal = 0
      for (const suffix of expectedSuffixes) {
        const path = `${canonical}${suffix}`
        const expectedNames = Object.entries(resolve(suffix))
          .filter(([, v]) => typeof v === 'function')
          .map(([k]) => k)
          .sort()
        expectedTotal += expectedNames.length
        expect({ path, names: [...(examined.get(path) ?? [])].sort() }).toEqual({
          path,
          names: expectedNames,
        })
      }

      // THE SAME ORACLE, ONE LEVEL DEEPER. `vi.fn()` does not carry across a
      // property that a function owns, so the mock can lose `realpath.native`
      // while every namespace-level set still matches. Derived from the real
      // module, never from the mock, for the reason round 8 established: an
      // expectation computed from the subject shrinks with it.
      const expectedMemberPaths: string[] = []
      const memberFailures: string[] = []
      for (const suffix of expectedSuffixes) {
        const nsActual = resolve(suffix)
        const nsMock = resolveMock(suffix)
        for (const [fnName, fnValue] of Object.entries(nsActual)) {
          if (typeof fnValue !== 'function') continue
          for (const [member, memberValue] of Object.entries(fnValue)) {
            if (typeof memberValue !== 'function') continue
            const label = `${canonical}${suffix}.${fnName}.${member}`
            expectedMemberPaths.push(label)
            // Look the member up ON THE MOCK. Absent means `vi.fn()` dropped
            // it and a real call would hit a bare TypeError that any
            // catch-and-continue swallows, recording nothing.
            const mockOwner = nsMock[fnName] as Record<string, unknown> | undefined
            const mockMember = mockOwner?.[member]
            if (mockMember === undefined) {
              memberFailures.push(`${label}: missing from the mock`)
              continue
            }
            exercise(mockMember, label)
          }
        }
      }
      expect(memberFailures).toEqual([])
      expect(failures).toEqual([])
      // Pins the oracle itself: an empty expected set would otherwise agree
      // with an empty subject. Measured in-container -- `node:fs` owns
      // `realpath.native` and `realpathSync.native`, at the top level and
      // again under `default`; the promises modules own none.
      expect(expectedMemberPaths.length).toBe(expectedMemberCount)

      // The hand-measured non-enumerable / Symbol-keyed counts that stood here
      // are gone, and so is the prose around them, which had gone FALSE rather
      // than merely stale: it said `fs.promises.opendir`'s promisify symbol was
      // "genuinely outside the mock" and that containment survived only because
      // `util.promisify` falls back to wrapping the spy. Both stopped being true
      // when `wrapNamespace` started wrapping symbol-keyed members — the symbol
      // IS on the spy now, so `util.promisify` finds it and gets a recording spy,
      // which records and throws directly instead of by fallback. The zero-gap
      // differential below subsumes what those counts were pinning, and asserts
      // it over the whole reflective surface rather than two hand-picked
      // categories.
      // A DIFFERENTIAL THAT NOW ASSERTS ZERO, BECAUSE THE HOLE IS CLOSED RATHER
      // THAN CHARACTERISED. Twelve rounds enumerated what `Object.entries`
      // misses — non-enumerable, then Symbol, then inherited, then accessors —
      // and every list was incomplete. Round 5 replaced the list with a
      // differential, which was directionally right and wrong the same way: it
      // SELECTED what to compare using `Object.entries(realNs)`. Rounds 6 and 7
      // then made the gap set ever more precise — a count, an owner set,
      // per-owner members, an injectively-encoded key — four consecutive repairs
      // to one claim.
      //
      // All four described the 143 unwrapped stream statics. None closed them,
      // and a real `fs.ReadStream.from(...)` call would have done silent I/O
      // throughout, because the mock did not carry it. `wrapNamespace` now wraps
      // the real module reflectively as this differential does — not the
      // IDENTICAL surface: the wrapper reads namespace accessors the differential
      // skips, and stays string-keyed at the namespace level while walking
      // symbols at the member level. They agree on data-property callables, which
      // is what drives the gap count to ZERO, and the precision question
      // disappears with the gaps: there is no set left whose identity could be
      // asserted too loosely.
      //
      // That is also why `String(key)` is safe as the diagnostic label below. A
      // rendering collision could only merge two entries in a set asserted
      // EMPTY, and a non-empty set fails whatever its entries are named. The
      // injective-encoding machinery this replaced existed solely to key a set
      // that should not exist.
      //
      //   SHARED   the same function object resolves on both sides. That is all
      //            it proves — not shared provenance. It is how ~1,500 entries
      //            per namespace (`apply`, `bind`, `hasOwnProperty`) drop out
      //            without being carved out by hand, and `wrapNamespace` skips
      //            exactly these, so it never replaces working machinery like
      //            `bind` with a throwing spy.
      //   WRAPPED  the mock resolves SOME function. Measured, not proven: that
      //            a spy records AND throws is established by the `exercise`
      //            loop above, over the reachable surface only. This branch
      //            does not re-establish it for hidden or inherited members and
      //            does not claim to.
      //   GAP      the mock resolves nothing. Asserted absent, per path.
      //   UNSAFE   the mock lookup threw — "present but unresolvable", not
      //            "absent". Kept separate, and proven reachable by a
      //            known-positive control, because a branch asserted `=== 0`
      //            everywhere is indistinguishable from one that cannot fire.
      //   ACCESSOR the real side is a getter OR a setter-only property. NOT
      //            invoked by this walk — invoking an unknown accessor is a side
      //            effect — so counted and left unresolved. `wrapNamespace` DOES
      //            read them at the namespace level, which is where `default`'s
      //            lazily-defined stream constructors come from.
      type Surface = {
        /** Owner -> missing member names. A diagnostic; asserted empty. */
        gapsByOwner: Record<string, string[]>
        gaps: number
        unsafe: number
        accessors: number
      }
      // Round 8's finding, turned into a guard rather than only a fix. Wrapping
      // more of the real surface risks a mock that BEHAVES right and LOOKS wrong:
      // a hidden or inherited member copied on as an own enumerable property is
      // visible to `Object.keys`, spread, `Object.assign` and
      // `propertyIsEnumerable`, so code inspecting a constructor for reasons
      // unrelated to I/O could branch differently under the mock. Scoped to keys
      // derived from the real function, so vitest's own `vi.fn()` properties are
      // not dragged into the comparison.
      const shapeMismatches: string[] = []
      const surfaceByPath: Record<string, Surface> = {}
      for (const suffix of expectedSuffixes) {
        const realNs = resolve(suffix)
        const mockNs = resolveMock(suffix)
        const gapsByOwner = new Map<string, Set<string>>()
        let gaps = 0
        let unsafe = 0
        let accessors = 0

        const readMock = (
          holder: unknown,
          key: string | symbol
        ): { ok: boolean; value: unknown } => {
          try {
            return {
              ok: true,
              value: holder == null ? undefined : (holder as Record<string | symbol, unknown>)[key],
            }
          } catch {
            return { ok: false, value: undefined }
          }
        }

        // Reflective seed: every callable the real namespace exposes by any key
        // kind, at any enumerability, own or inherited — not `Object.entries`.
        const namespaceCallables: Array<[string | symbol, unknown]> = []
        {
          let cur: object | null = realNs as object
          const seen = new Set<string | symbol>()
          while (cur !== null) {
            for (const key of Reflect.ownKeys(cur)) {
              if (seen.has(key)) continue
              seen.add(key)
              const desc = Object.getOwnPropertyDescriptor(cur, key)
              if (!desc) continue
              // Setter-only counts too: `desc.get === undefined` with a setter
              // present is still an accessor, and testing only `get` dropped it
              // out of all five outcomes instead of into one.
              if (desc.get !== undefined || desc.set !== undefined) {
                accessors += 1
                continue
              }
              if (typeof desc.value === 'function') namespaceCallables.push([key, desc.value])
            }
            cur = Object.getPrototypeOf(cur)
          }
        }

        const classify = (
          realValue: unknown,
          holder: unknown,
          key: string | symbol,
          owner: string
        ): void => {
          const read = readMock(holder, key)
          if (!read.ok) {
            unsafe += 1
            return
          }
          if (read.value === realValue) return // SHARED
          if (typeof read.value === 'function') return // WRAPPED
          gaps += 1
          let members = gapsByOwner.get(owner)
          if (members === undefined) {
            members = new Set<string>()
            gapsByOwner.set(owner, members)
          }
          members.add(String(key))
        }

        for (const [nsKey, realFn] of namespaceCallables) {
          classify(realFn, mockNs, nsKey, '<namespace>')
          const mockFn = readMock(mockNs, nsKey).value
          let cur: object | null = realFn as object
          const seen = new Set<string | symbol>()
          while (cur !== null) {
            for (const key of Reflect.ownKeys(cur)) {
              if (seen.has(key)) continue
              seen.add(key)
              const desc = Object.getOwnPropertyDescriptor(cur, key)
              if (!desc) continue
              if (desc.get !== undefined || desc.set !== undefined) {
                accessors += 1
                continue
              }
              if (typeof desc.value !== 'function') continue
              // The OWNER is encoded too: a namespace's own key can be a symbol,
              // so `String(nsKey)` would collide two distinct owners exactly as
              // it collided two distinct members.
              classify(desc.value, mockFn, key, String(nsKey))
              // SHAPE, NOT BEHAVIOUR, and two properties of it rather than one.
              // Round 8 pinned enumerability; round 9 found that insufficient,
              // because an inherited member installed as a non-enumerable OWN
              // property is still visible to `Object.hasOwn` where production has
              // nothing. OWN-NESS is compared first — it decides whether
              // static-discovery code sees a member at all — then `enumerable`
              // and `writable` for the own ones.
              const where = `${canonical}${suffix}.${String(nsKey)}.${String(key)}`
              const realOwnDesc = Object.getOwnPropertyDescriptor(realFn as object, key)
              const mockDesc =
                mockFn == null ? undefined : Object.getOwnPropertyDescriptor(mockFn as object, key)
              if ((realOwnDesc !== undefined) !== (mockDesc !== undefined)) {
                shapeMismatches.push(
                  `${where}: own on mock=${mockDesc !== undefined}, own on real=${realOwnDesc !== undefined}`
                )
              } else if (mockDesc !== undefined && realOwnDesc !== undefined) {
                if (mockDesc.enumerable !== realOwnDesc.enumerable) {
                  shapeMismatches.push(
                    `${where}: mock enumerable=${mockDesc.enumerable}, real enumerable=${realOwnDesc.enumerable}`
                  )
                }
                if (mockDesc.writable !== realOwnDesc.writable) {
                  shapeMismatches.push(
                    `${where}: mock writable=${mockDesc.writable}, real writable=${realOwnDesc.writable}`
                  )
                }
              }
            }
            cur = Object.getPrototypeOf(cur)
          }
        }

        surfaceByPath[`${canonical}${suffix}`] = {
          gapsByOwner: Object.fromEntries(
            [...gapsByOwner.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([owner, members]) => [owner, [...members].sort()])
          ),
          gaps,
          unsafe,
          accessors,
        }

        // KNOWN-POSITIVE for UNSAFE, run after the snapshot so it cannot move
        // the recorded numbers. Every real path asserts `unsafe: 0`, and a
        // branch that can never fire produces that same zero — so the zero is
        // only evidence once the branch is shown reachable. This drives the
        // SAME `classify` closure the walk used, not a copy of its logic: a
        // holder whose lookup throws must land in UNSAFE, and must not be
        // miscounted as a gap.
        const throwingHolder = {} as Record<string, unknown>
        Object.defineProperty(throwingHolder, 'poisoned', {
          get() {
            throw new Error('control: this lookup must classify as UNSAFE, not as a gap')
          },
        })
        const unsafeBefore = unsafe
        const gapsBefore = gaps
        classify(() => undefined, throwingHolder, 'poisoned', '<control>')
        expect(unsafe, `${suffix}: the UNSAFE branch never fired for a throwing lookup`).toBe(
          unsafeBefore + 1
        )
        expect(gaps, `${suffix}: a throwing lookup was miscounted as a gap`).toBe(gapsBefore)
        expect(gapsByOwner.has('<control>')).toBe(false)
      }
      // Expected per path, measured in-container on Node 22. Gaps are ZERO on
      // every path: `wrapNamespace` wraps reflectively as this differential
      // walks, so the two agree on data-property callables by construction rather
      // than by a hand-maintained list of what the mock happens to miss.
      //
      // Deleted along with the gaps: a 71-line literal of the four stream
      // constructors' inherited statics, an injective key encoder with its
      // collision ledger and known-positive, and a per-owner sum check. All of it
      // existed to describe 143 functions the mock did not carry. One predicate
      // in `wrapNamespace` — wrap unless the target already resolves the
      // identical function — removed the need for every line of it.
      //
      // The accessor counts stay, but NOT as the reason `gaps: 0` is non-vacuous —
      // that argument was wrong and the docblock's correction had been applied
      // while this copy of it survived, which is two surfaces disagreeing with the
      // wrong one read first. Accessors are a DIFFERENT population, counted and
      // skipped, so a large accessor surface is compatible with an empty callable
      // one. `expectedTotal > 25` and the exact call and construction totals are
      // what require a substantial callable domain to have been walked.
      //
      // What the counts are FOR is a Node-shape canary: this package supports
      // `>=22.22.0` while CI tracks the moving Node 22 line, so a legitimate
      // update can change them, and that failure is the intended signal.
      const NO_GAPS = { gaps: 0, unsafe: 0, gapsByOwner: {} } as const
      const SURFACE_BY_SUFFIX: Record<string, Surface> = {
        'node:fs': { ...NO_GAPS, accessors: 310 },
        'node:fs.default': { ...NO_GAPS, accessors: 321 },
        'node:fs.promises': { ...NO_GAPS, accessors: 127 },
        'node:fs.default.promises': { ...NO_GAPS, accessors: 127 },
        'node:fs/promises': { ...NO_GAPS, accessors: 93 },
        'node:fs/promises.default': { ...NO_GAPS, accessors: 127 },
      }
      const expectedSurface: Record<string, Surface> = {}
      for (const suffix of expectedSuffixes) {
        const path = `${canonical}${suffix}`
        const expected = SURFACE_BY_SUFFIX[path]
        expect(expected, `no expected surface recorded for ${path}`).toBeDefined()
        expectedSurface[path] = expected
      }
      // Every path compared whole. No path trades member identity for a count.
      expect(surfaceByPath).toEqual(expectedSurface)

      // Scoped exactly: for every key the REAL function exposes, the mock must
      // agree on own-ness, and for own keys also on `enumerable` and `writable`.
      // What it does NOT check, stated because the previous comment claimed the
      // whole shape: a key the mock installs that the real function does not
      // expose at all is never visited by this walk. The wrapper cannot currently
      // invent one — every installation is driven by the real walk — but that is a
      // property of the wrapper, not something this assertion establishes.
      expect(
        shapeMismatches,
        'the mock is observably shaped differently from the real function'
      ).toEqual([])

      // The sum check that stood here is gone. It compared `gaps` against the
      // per-owner sets to catch a dedup collision — a fault that required gaps to
      // exist. With every path asserted at zero gaps it can only ever compare 0
      // to 0, which makes it dead by exactly the standard used to delete the
      // depth-0 property skip. Round 7's reviewer was right that it was an
      // independent check while there were gaps to count; closing the gaps is
      // what retired it, not a reversal of that.

      // Guards the guard: if `vi.importActual` ever handed back an empty or
      // stub module, every set comparison above would pass vacuously by
      // matching [] against [].
      expect(expectedTotal).toBeGreaterThan(25)
      expect(calls).toBe((expectedTotal + expectedMemberCount) * ARGUMENT_SHAPES.length)
      expect(constructions).toBe(expectedTotal + expectedMemberCount)
    }
  )

  it('the recorded label names the registration that served a bare specifier', async () => {
    // This is the ONLY exact-string assertion in the file, and it earns that
    // because the string is the measurement: the label's prefix is the only
    // observable telling you WHICH registration served a bare import. Vitest
    // normalises a bare builtin specifier onto the `node:`-prefixed registry
    // key, so `vi.mock('node:fs', ...)` overrides `vi.mock('fs', ...)` and a
    // bare import records as `node:fs.…`.
    //
    // Do not relax this to `toContain('existsSync')` — that passes under both
    // states and measures neither. Record+throw for this and every other
    // function is covered by the invariant above, so this test is not carrying
    // that; if the label FORMAT changes, fix the expectation here rather than
    // weakening the matcher.
    const fs = await import('fs')
    expect(() => fs.existsSync('/control-sync')).toThrow(/must be pure/)
    expect(recordedCalls).toEqual(['node:fs.existsSync(/control-sync)'])
  })
})

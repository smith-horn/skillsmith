/**
 * @fileoverview The rendered text of the shared corruption refusal (ADR-175).
 * @see SMI-6961 review findings F1 and F2.
 *
 * **Why this file exists separately.** `corruptDatabaseError` is shared by both
 * drivers, so a test for it in either driver's suite would be the wrong
 * subject — and `betterSqlite3Driver.corruption.test.ts` is native-gated, so an
 * arm placed there reports "skipped" whenever the binding breaks (SMI-6516
 * recurs on this host). These are pure string assertions over a pure function;
 * they must run on every platform, every time.
 *
 * **What the two findings were.** Both were in text a user reads while deciding
 * what to do with a database they cannot open:
 *
 * - **F2**: the `reindex` branch ended "move the files aside **as below**" and
 *   there was nothing below it — the `mv` block lived in the mutually exclusive
 *   `replace` arm of the same ternary. The fallback the message directed users
 *   to was unactionable, and no test rendered that branch. The existing
 *   `REMEDY_KINDS` assertion only checked membership, and both native fixtures
 *   yield `replace`, so `reindex` had never been rendered by anything.
 * - **F1**: the message claimed the database "holds no data that cannot be
 *   rebuilt from the registry". False. `import-local` tags its rows
 *   `source='local'` precisely so registry sync will not overwrite them, so
 *   sync cannot recreate them; quarantine review decisions have no registry
 *   source either. It was the sentence telling the user there was nothing to
 *   lose, which is why it mattered more than its length suggests.
 *
 * The arms below are per-remedy-kind rather than over one example, because the
 * defect was precisely that one branch differed from the other.
 */
import { describe, it, expect } from 'vitest'
import { corruptDatabaseError } from '../../src/db/corrupt-refusal.js'
import {
  sqlJsCorruptionCode,
  refuseIfCorrupt,
} from '../../src/db/drivers/sqljsDriver.corruption.js'

/** A line that is an actual `mv` command, not prose mentioning one. */
const MV_COMMAND = /^ {2}mv /m

/** The retired false claim, in case it is ever reintroduced. */
const RETIRED_FALSE_CLAIM = /holds no data that cannot be rebuilt|rebuilt from the registry/

const PATH = '/tmp/smi6961/skills.db'

/** `remedyKind` for a code, read off the shared builder's own output. */
function remedyKindOf(sqliteCode?: string): string {
  return render(sqliteCode).remedyKind
}

function render(sqliteCode?: string): { message: string; remedyKind: string } {
  const error = corruptDatabaseError(PATH, 'damaged', sqliteCode) as unknown as {
    message: string
    remedyKind: string
  }
  return { message: error.message, remedyKind: error.remedyKind }
}

describe('SMI-6961 F2: every remedy branch renders an actionable command', () => {
  // The four inputs that reach the two branches. `SQLITE_CORRUPT_INDEX` is the
  // only one producing `reindex`, and it was the unrendered one.
  const cases: Array<{ code: string | undefined; expectedKind: string }> = [
    { code: undefined, expectedKind: 'replace' },
    { code: 'SQLITE_NOTADB', expectedKind: 'replace' },
    { code: 'SQLITE_CORRUPT', expectedKind: 'replace' },
    { code: 'SQLITE_CORRUPT_INDEX', expectedKind: 'reindex' },
  ]

  it.each(cases)('$code renders a real mv command and no dangling reference', ({ code }) => {
    const { message } = render(code)

    // The property that makes the message useful: a command the user can run.
    expect(message).toMatch(MV_COMMAND)

    // And it must not point at text that is not there. This is the exact
    // defect: "as below" was rendered in the branch that had nothing below.
    expect(message).not.toMatch(/as below/)
  })

  it.each(cases)('$code produces remedyKind $expectedKind', ({ code, expectedKind }) => {
    // Pins which branch each code reaches, so a later change that silently
    // routed `SQLITE_CORRUPT_INDEX` to `replace` would surface here rather than
    // quietly making the arm above pass for the wrong reason.
    expect(render(code).remedyKind).toBe(expectedKind)
  })

  it('the reindex branch names both the recheck AND the fallback commands', () => {
    // The specific branch that was broken, asserted in full rather than by the
    // shared loop: it must still offer the conditional REINDEX path, and the
    // fallback must now be executable.
    const { message, remedyKind } = render('SQLITE_CORRUPT_INDEX')
    expect(remedyKind).toBe('reindex')
    expect(message).toContain("'REINDEX;'")
    expect(message).toContain("'PRAGMA quick_check;'")
    expect(message).toMatch(MV_COMMAND)
    // All three WAL members, since moving only the main file is what ADR-175
    // § 1 forbids — the orphaned `-wal` is the original defect.
    expect(message).toContain(`${PATH}-wal`)
    expect(message).toContain(`${PATH}-shm`)
  })

  it('the matchers discriminate — known-positive and known-negative', () => {
    // Without this the arms above could be measuring nothing: a regex that
    // never matches would make `not.toMatch` pass for every input, and the
    // `toMatch` arms would then be the only thing holding it up.
    expect('  mv a b').toMatch(MV_COMMAND)
    expect('see the mv command below').not.toMatch(MV_COMMAND)
    expect('move the files aside as below').toMatch(/as below/)
    expect('').not.toMatch(MV_COMMAND)
  })
})

describe('SMI-6961 F1: the message does not claim the data is all rebuildable', () => {
  const cases = [undefined, 'SQLITE_NOTADB', 'SQLITE_CORRUPT', 'SQLITE_CORRUPT_INDEX']

  it.each(cases)('%s omits the retired false claim', (code) => {
    expect(render(code).message).not.toMatch(RETIRED_FALSE_CLAIM)
  })

  it.each(cases)('%s says what a sync does NOT restore', (code) => {
    // The paired PRESENCE assertion. An absence assertion alone would pass if
    // the paragraph were deleted outright rather than corrected — and deleting
    // it is the likelier accident, since it is the longest block in the
    // message. So assert the honest replacement is actually there.
    const { message } = render(code)
    expect(message).toMatch(/does NOT rebuild locally-created rows/)
    expect(message).toContain('import-local')
    expect(message).toContain('quarantine')
  })

  it('the retired-claim matcher discriminates', () => {
    // Known-positive: the exact sentence that shipped, which must be detected
    // if anyone restores it.
    expect(
      'Skillsmith does not repair it automatically — it holds no data that cannot be ' +
        'rebuilt from the registry, and repairing a database another process may have open ' +
        "risks losing that process's writes."
    ).toMatch(RETIRED_FALSE_CLAIM)
    expect('a sync rebuilds the registry mirror').not.toMatch(RETIRED_FALSE_CLAIM)
  })
})

/**
 * SMI-6991: `remedyKind` is NOT driver-independent, unlike `code`.
 *
 * The accurate statement, narrower than an earlier draft of this docblock:
 * **`'reindex'` is reachable only from the native driver's THROWN path.** It
 * needs the extended code `SQLITE_CORRUPT_INDEX`, and only a thrown
 * better-sqlite3 error carries one. Both drivers' `quick_check` paths report a
 * verdict with no code at all, so a database whose index damage `quick_check`
 * finds gets `'replace'` on native too — the divergence is per-path, not
 * simply native-versus-WASM.
 *
 * **Where the tripwire has to live, and why an earlier version of this block
 * was not one.** It asserted only `corruptDatabaseError`'s `code → remedyKind`
 * mapping and `sqlJsCorruptionCode`'s two messages. A fix for SMI-6991 lands in
 * `refuseIfCorrupt`, which neither touches — and after that fix,
 * `corruptDatabaseError(path, 'damaged', undefined)` must *still* yield
 * `'replace'`, because `undefined` still means replace. So the whole block
 * stayed green through the fix while claiming it would go red.
 *
 * The arms below therefore drive `refuseIfCorrupt` itself, through the stub
 * interface it already accepts. When that function learns to classify an
 * index-only verdict, **the index arm** goes red, which is the point. An
 * earlier version of this sentence said "the first two go red" — false, and
 * contradicted by the very measurement recorded in the commit that added it:
 * the second arm is the page-damage CONTROL, which a correct fix must leave at
 * `replace`, and the simulation reported exactly one failure.
 *
 * **What this still does not cover**, stated rather than left implied:
 *
 * - The index arm is parameterised over several real `quick_check` wordings,
 *   but SQLite's verdict text is not a closed set. A classifier keyed on a
 *   phrasing absent from the table below would leave these green.
 * - It drives the **WASM** reported-verdict path. A fix applied only to the
 *   native driver's own `quick_check` path — which also builds a refusal with
 *   no code — would not trip it. A mirror arm belongs in
 *   `betterSqlite3Driver.corruption.test.ts`, which is native-gated, so a
 *   broken binding there renders as a skip rather than a failure (SMI-6792).
 *   Both gaps are recorded in SMI-6991 rather than papered over here.
 */
describe('SMI-6991: the reported-verdict path cannot reach reindex, and that is pinned', () => {
  /** Drives the real `refuseIfCorrupt` and returns the refusal it throws. */
  function refusalFor(verdict: string): { remedyKind: string; sqliteCode?: string } {
    let closed = 0
    const db = {
      prepare: () => ({
        step: () => true,
        get: () => [verdict],
        free: () => {},
      }),
      close: () => {
        closed += 1
      },
    }
    try {
      refuseIfCorrupt(db, '/tmp/smi6991/skills.db')
    } catch (error) {
      // The handle must be closed before the throw — it is never published, so
      // nothing else would free its WASM heap.
      expect(closed).toBe(1)
      return error as { remedyKind: string; sqliteCode?: string }
    }
    throw new Error('refuseIfCorrupt did not throw for a non-ok verdict')
  }

  // THE TRIPWIRE, over several of SQLite's own wordings for index-only damage
  // rather than one. A single wording was the first version's weakness: a
  // classifier keyed on any other legitimate phrasing would have left it green.
  // These are the shapes `integrity_check`/`quick_check` actually emit for an
  // index whose contents disagree with its table.
  it.each([
    ['wrong # of entries in index sqlite_autoindex_skills_1'],
    ['row 42 missing from index idx_skills_author'],
    ['non-unique entry in index sqlite_autoindex_skills_1'],
    ['rowid 7 missing from index idx_skills_name'],
  ])('an INDEX-ONLY verdict still yields replace, not reindex: %s', (verdict) => {
    const refusal = refusalFor(verdict)
    expect(refusal.remedyKind).toBe('replace')
    expect(refusal.sqliteCode).toBeUndefined()
  })

  it('a PAGE-damage verdict yields replace too — the control', () => {
    // Without this, the arm above could be read as "verdicts never classify",
    // when what it pins is specifically that the index case is not singled out.
    // A correct fix must leave THIS one at `replace`.
    const refusal = refusalFor('*** in database main *** Page 4 is never used')
    expect(refusal.remedyKind).toBe('replace')
    expect(refusal.sqliteCode).toBeUndefined()
  })

  it('reindex IS reachable when a code is supplied — so the above is not a dead constant', () => {
    // The paired presence assertion. `'reindex'` is a live value of the shared
    // builder; it is only unreachable from a reported verdict.
    expect(remedyKindOf('SQLITE_CORRUPT_INDEX')).toBe('reindex')
  })

  it('the WASM message adapter resolves no code that could reach reindex', () => {
    // The second half of the mechanism: on the THROWN path, this function is the
    // WASM driver's only source of a code. Asserted as a mapping rather than as
    // a closed world — a third mapping added later would not falsify this, and
    // claiming otherwise would be a quantifier the test cannot establish.
    expect(sqlJsCorruptionCode(new Error('file is not a database'))).toBe('SQLITE_NOTADB')
    expect(sqlJsCorruptionCode(new Error('database disk image is malformed'))).toBe(
      'SQLITE_CORRUPT'
    )
    expect(remedyKindOf('SQLITE_NOTADB')).toBe('replace')
    expect(remedyKindOf('SQLITE_CORRUPT')).toBe('replace')
  })

  it('the two remedies differ in what they cost the user', () => {
    // Why the divergence matters rather than being a cosmetic label: one
    // suggests a non-destructive repair, the other moves the database aside.
    const reindex = render('SQLITE_CORRUPT_INDEX').message
    const replace = render(undefined).message
    expect(reindex).toContain("'REINDEX;'")
    expect(replace).not.toContain("'REINDEX;'")
    // Both still end in an actionable move — the SMI-6961 F2 fix — so the
    // difference is the repair ATTEMPT, not whether advice exists at all.
    expect(reindex).toMatch(MV_COMMAND)
    expect(replace).toMatch(MV_COMMAND)
  })
})

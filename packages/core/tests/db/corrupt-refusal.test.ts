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
import { sqlJsCorruptionCode } from '../../src/db/drivers/sqljsDriver.corruption.js'

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
 * Found in the post-merge retro of PR #3008. The core CHANGELOG claimed a
 * consumer "gets identical behaviour from either driver". The `code` half is
 * true — it is a single constant. `remedyKind` is not, and the difference is
 * what the user is told to do with their database.
 *
 * These arms pin the divergence so the documented claim is machine-checked
 * rather than prose. When SMI-6991 closes the gap, this block goes red and
 * must be updated deliberately — which is the point.
 */
describe('SMI-6991: remedyKind diverges by driver, and that is pinned', () => {
  it('only SQLITE_CORRUPT_INDEX yields reindex — the native-only path', () => {
    expect(remedyKindOf('SQLITE_CORRUPT_INDEX')).toBe('reindex')
  })

  // Objects rather than tuples: a mixed `[string, string] | [undefined, string]`
  // tuple union does not narrow to a one-parameter callback, which typecheck
  // caught even though every arm passed at runtime.
  const wasmReachable: Array<{ code: string | undefined; why: string }> = [
    { code: 'SQLITE_NOTADB', why: 'the WASM throw path' },
    { code: 'SQLITE_CORRUPT', why: 'the WASM throw path' },
    { code: undefined, why: 'the WASM quick_check path, which carries no code at all' },
  ]

  it.each(wasmReachable)('$code yields replace via $why', ({ code }) => {
    expect(remedyKindOf(code)).toBe('replace')
  })

  it('the WASM message adapter can never produce the index code', () => {
    // The mechanism behind the divergence, asserted directly: this function is
    // the WASM driver's ONLY source of a sqliteCode, and it resolves exactly
    // two messages. So no sql.js failure can reach the reindex remedy.
    const everyResolvableMessage = ['file is not a database', 'database disk image is malformed']
    const codes = everyResolvableMessage.map((m) => sqlJsCorruptionCode(new Error(m)))
    expect(codes).toEqual(['SQLITE_NOTADB', 'SQLITE_CORRUPT'])
    expect(codes).not.toContain('SQLITE_CORRUPT_INDEX')
    // And the paired presence assertion, so this is not vacuous: the index code
    // IS a value the shared builder understands — it is only unreachable from
    // this driver, which is the divergence rather than a dead constant.
    expect(remedyKindOf('SQLITE_CORRUPT_INDEX')).toBe('reindex')
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

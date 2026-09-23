/**
 * @fileoverview Tests for checkForConflicts' manifest keying (SMI-6358).
 * @module @skillsmith/mcp-server/tools/install.conflict.test
 *
 * Why this file exists, when `install.test.ts` already names `checkForConflicts`:
 * that file mocks the whole module (`vi.mock('./install.conflict.js')`), so it
 * asserts what install.ts PASSES and never executes the function. The
 * post-merge retro on PR #2920 measured the consequence — reverting both
 * `manifestKeyFor(skillName, client)` calls to a bare `skillName` left all 24
 * unit tests and all 11 e2e tests green. The mcp-server third of SMI-6358's
 * fix shipped pinned by nothing.
 *
 * The e2e file could not have caught it either: every one of its call sites
 * passes `CANONICAL_CLIENT`, and `manifestKeyFor(name, CANONICAL_CLIENT)` is
 * the identity function. A test that only ever exercises the canonical client
 * cannot distinguish keyed-by-client from keyed-by-name, however many
 * assertions it makes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// `detectModifications` is the first thing reached once an entry with an
// `originalContentHash` is found, and it touches the filesystem. Stub it so a
// found entry deterministically reports "modified" — that turns "did we find
// the entry?" into an observable difference in the return value, which is the
// only thing these tests are about.
const {
  mockDetectModifications,
  mockLoadOriginal,
  mockStoreOriginal,
  mockUpdateManifestSafely,
  mockThreeWayMerge,
} = vi.hoisted(() => ({
  mockDetectModifications: vi.fn(),
  mockLoadOriginal: vi.fn(),
  mockStoreOriginal: vi.fn(),
  mockUpdateManifestSafely: vi.fn(),
  mockThreeWayMerge: vi.fn(),
}))

// install.helpers.ts RE-EXPORTS detectModifications from install.conflict-helpers.ts,
// so mocking the source module intercepts the re-export. Verified rather than
// assumed: inverting the "was called" assertion below makes that test fail, which
// it could not do if the mock were unwired.
vi.mock('./install.conflict-helpers.js', async (importActual) => {
  const actual = await importActual<typeof import('./install.conflict-helpers.js')>()
  return {
    ...actual,
    detectModifications: mockDetectModifications,
    loadOriginal: mockLoadOriginal,
    storeOriginal: mockStoreOriginal,
    createSkillBackup: vi.fn(async () => '/tmp/backup'),
    cleanupOldBackups: vi.fn(async () => undefined),
    hashContent: vi.fn(() => 'upstream-hash'),
  }
})

vi.mock('./install.helpers.manifest.js', async (importActual) => {
  const actual = await importActual<typeof import('./install.helpers.manifest.js')>()
  return { ...actual, updateManifestSafely: mockUpdateManifestSafely }
})

vi.mock('./merge.js', async (importActual) => {
  const actual = await importActual<typeof import('./merge.js')>()
  return { ...actual, threeWayMerge: mockThreeWayMerge }
})

// NOT mocked: `manifestKeyFor` from @skillsmith/core. It is the subject.

import { CLIENT_IDS, CANONICAL_CLIENT } from '@skillsmith/core/install'
import { checkForConflicts, handleMergeAction } from './install.conflict.js'
import type { SkillManifest } from './install.types.js'

const CANONICAL = CANONICAL_CLIENT
const OTHER = 'cursor' as const

/**
 * Every client the union admits except the canonical one. `ClientId` is a
 * closed union of nine values and `CLIENT_IDS` is its frozen runtime twin, so
 * this is the WHOLE domain rather than a sample of it — and it grows by itself
 * when a tenth client is added.
 */
const NON_CANONICAL = CLIENT_IDS.filter((c) => c !== CANONICAL_CLIENT)

// A parameterized suite reports a PASS when its table is empty -- it generates
// no cases and the file goes green with the coverage silently gone. Measured
// rather than assumed: forcing NON_CANONICAL to [] takes this file from 31
// tests to 7 passed, with nothing failing and nothing saying so.
//
// That is the same invisible-success shape the rest of this file exists to
// prevent, so the table is pinned before it is used. This describe block is
// NOT redundant with the cases below: those cannot fail if they do not exist,
// and this one can.
describe('the client table this file parameterizes over', () => {
  it('is the whole non-canonical domain, and is not empty', () => {
    // Deliberately NOT compared against `CLIENT_IDS.filter(...)` — that is the
    // expression NON_CANONICAL is defined by, so asserting it against itself
    // could never fail. An earlier draft of this guard did exactly that.
    //
    // These four are chosen to FORCE the contents without that tautology.
    // Length alone does not: a table of eight duplicate 'cursor' entries has
    // the right length, excludes the canonical client, and passed all of an
    // earlier version of this guard while generating 24 cases that exercised
    // ONE client. Measured — 32 passed, silently. Adding distinctness closes
    // it: 8 distinct values, every one drawn from a 9-value union, none of
    // them the canonical one, admits exactly the non-canonical set and
    // nothing else.
    expect(NON_CANONICAL.length).toBe(CLIENT_IDS.length - 1)
    expect(NON_CANONICAL.length).toBeGreaterThan(0)
    expect(new Set(NON_CANONICAL).size).toBe(NON_CANONICAL.length)
    expect(NON_CANONICAL.every((c) => CLIENT_IDS.includes(c))).toBe(true)
    expect(NON_CANONICAL).not.toContain(CANONICAL_CLIENT)
    expect(CLIENT_IDS).toContain(CANONICAL_CLIENT)
  })
})

/** A manifest holding exactly one entry, under `key`, that would conflict. */
function manifestWithEntry(key: string, version = '1.0.0'): SkillManifest {
  return {
    version: '1',
    installedSkills: {
      [key]: {
        id: 'owner/repo/my-skill',
        name: 'my-skill',
        version,
        source: 'registry',
        installPath: '/installed/my-skill',
        installedAt: '2026-01-01T00:00:00Z',
        lastUpdated: '2026-01-01T00:00:00Z',
        originalContentHash: 'hash-abc',
      },
    },
  } as unknown as SkillManifest
}

beforeEach(() => {
  vi.clearAllMocks()
  // Any entry we actually find is locally modified, so finding one is visible.
  mockDetectModifications.mockResolvedValue({
    modified: true,
    currentHash: 'hash-local',
    originalHash: 'hash-abc',
  })
  // handleMergeAction reaches its manifestKey use only through the CONFLICTING
  // merge branch, so drive it there: an original exists, and the merge fails.
  mockLoadOriginal.mockResolvedValue('original content')
  mockThreeWayMerge.mockReturnValue({ success: false, merged: '<<<<<<< conflict' })
  mockUpdateManifestSafely.mockResolvedValue(undefined)
})

describe('checkForConflicts keys by client, not by bare name (SMI-6358)', () => {
  it('does not consult the canonical entry when asked about another client', async () => {
    // The manifest holds ONLY the canonical `my-skill` entry. A non-canonical
    // client must look under `my-skill::cursor`, find nothing, and proceed.
    const result = await checkForConflicts(
      'my-skill',
      '/installed/my-skill',
      manifestWithEntry('my-skill'),
      undefined,
      'owner/repo/my-skill',
      OTHER
    )

    // The decisive assertion: a bare-name lookup would have found the entry
    // and gone on to compare hashes. Never reaching that call is what proves
    // the key was client-scoped.
    //
    // Written as ONE assertion over `result` plus the call count, rather than
    // a bare `expect(mock).not.toHaveBeenCalled()`, because round 3's gate
    // found that the bare form is true both BEFORE and AFTER the call: moved
    // above it, the assertion passes vacuously and all ten tests stay green.
    // Its whole meaning lived in its position and nothing enforced that.
    // Referencing `result` makes the position load-bearing to the compiler --
    // hoisting this above the call is a use-before-declaration error, not a
    // silent pass.
    expect({
      proceeded: result.shouldProceed,
      consulted: mockDetectModifications.mock.calls.length,
    }).toEqual({ proceeded: true, consulted: 0 })
  })

  it('does consult the client-scoped entry when one exists', async () => {
    const result = await checkForConflicts(
      'my-skill',
      '/installed/my-skill',
      manifestWithEntry(`my-skill::${OTHER}`),
      undefined,
      'owner/repo/my-skill',
      OTHER
    )

    // Found, modified, and no conflictAction supplied — so it must stop and
    // report rather than proceed.
    expect(mockDetectModifications).toHaveBeenCalledOnce()
    expect(result.shouldProceed).toBe(false)
  })

  it('still reads the bare name for the canonical client', async () => {
    // manifestKeyFor(name, CANONICAL) is the identity function, so this is the
    // behaviour every pre-existing test already depended on. Pinned here so a
    // future change to the keying scheme cannot silently move it.
    const result = await checkForConflicts(
      'my-skill',
      '/installed/my-skill',
      manifestWithEntry('my-skill'),
      undefined,
      'owner/repo/my-skill',
      CANONICAL
    )

    expect(mockDetectModifications).toHaveBeenCalledOnce()
    expect(result.shouldProceed).toBe(false)
  })

  it('does not consult a foreign client-scoped entry for the canonical client', async () => {
    // The mirror of case 1, and the arm that a "keys by client" fix could still
    // get wrong in one direction only.
    const result = await checkForConflicts(
      'my-skill',
      '/installed/my-skill',
      manifestWithEntry(`my-skill::${OTHER}`),
      undefined,
      'owner/repo/my-skill',
      CANONICAL
    )

    // Same order-bound form as the first case, for the same reason.
    expect({
      proceeded: result.shouldProceed,
      consulted: mockDetectModifications.mock.calls.length,
    }).toEqual({ proceeded: true, consulted: 0 })
  })
})

describe('handleMergeAction keys by client too (SMI-6358 retro)', () => {
  // The twin. install.conflict.ts has TWO manifestKeyFor call sites and the
  // first version of this file covered only checkForConflicts. The gate caught
  // it, and the reason it survived MY red-test is worth stating: that mutation
  // was a global substitution reverting both sites at once, so "2 of 4 failed"
  // proved the union was covered and said nothing about either member. A
  // mutation applied to every instance of a pattern cannot measure per-instance
  // coverage — and it fails reassuringly, because a global revert is MORE
  // likely to go red than a targeted one.
  //
  // Each site below is therefore mutated on its own, not together.

  it('reads the client-scoped entry, not the canonical one', async () => {
    // Only the CANONICAL entry exists, and it carries a distinctive version.
    // handleMergeAction feeds `existingEntry?.version || '1.0.0'` to
    // storeOriginal, so a bare-name lookup would surface '9.9.9' there.
    await handleMergeAction(
      'my-skill',
      '/installed/my-skill',
      'upstream content',
      manifestWithEntry('my-skill', '9.9.9'),
      'owner',
      'repo',
      'owner/repo/my-skill',
      OTHER
    )

    expect(mockStoreOriginal).toHaveBeenCalledOnce()
    const meta = mockStoreOriginal.mock.calls[0]![2] as { version: string }
    expect(meta.version).toBe('1.0.0')
  })

  it('finds the client-scoped entry when it exists', async () => {
    await handleMergeAction(
      'my-skill',
      '/installed/my-skill',
      'upstream content',
      manifestWithEntry(`my-skill::${OTHER}`, '9.9.9'),
      'owner',
      'repo',
      'owner/repo/my-skill',
      OTHER
    )

    const meta = mockStoreOriginal.mock.calls[0]![2] as { version: string }
    expect(meta.version).toBe('9.9.9')
  })

  it('writes the manifest back under the client-scoped key', async () => {
    await handleMergeAction(
      'my-skill',
      '/installed/my-skill',
      'upstream content',
      manifestWithEntry(`my-skill::${OTHER}`, '9.9.9'),
      'owner',
      'repo',
      'owner/repo/my-skill',
      OTHER
    )

    // The write is expressed as an updater function; run it against a known
    // manifest and inspect which key it touched.
    expect(mockUpdateManifestSafely).toHaveBeenCalledOnce()
    const updater = mockUpdateManifestSafely.mock.calls[0]![0] as (m: unknown) => {
      installedSkills: Record<string, unknown>
    }
    const written = updater({ version: '1', installedSkills: {} })
    expect(Object.keys(written.installedSkills)).toEqual([`my-skill::${OTHER}`])
  })
})

// EVERY non-canonical client, at BOTH call sites (SMI-6358 retro, round 3).
//
// An earlier version of this block sampled one extra client ('windsurf') to rule
// out a predicate special-cased to 'cursor'. The round-3 gate showed what a
// two-client sample still cannot distinguish: a lookup table admitting exactly
// {claude-code, cursor, windsurf}, or `client === 'cursor' || client ===
// 'windsurf'`, passes every one of those tests while being wrong for the six
// remaining clients the union admits.
//
// A third sampled client would have killed that particular table and pinned the
// same sampled property again. `ClientId` is a CLOSED union and `CLIENT_IDS` is
// its frozen runtime twin, so the domain can be enumerated instead of sampled --
// and a tenth client added later is covered without anyone remembering to.
describe.each(NON_CANONICAL)('non-canonical client %s', (client) => {
  it('checkForConflicts does not consult the canonical entry', async () => {
    const result = await checkForConflicts(
      'my-skill',
      '/installed/my-skill',
      manifestWithEntry('my-skill'),
      undefined,
      'owner/repo/my-skill',
      client
    )
    expect({
      proceeded: result.shouldProceed,
      consulted: mockDetectModifications.mock.calls.length,
    }).toEqual({ proceeded: true, consulted: 0 })
  })

  it('checkForConflicts finds this client own entry', async () => {
    const result = await checkForConflicts(
      'my-skill',
      '/installed/my-skill',
      manifestWithEntry(`my-skill::${client}`),
      undefined,
      'owner/repo/my-skill',
      client
    )
    expect({
      proceeded: result.shouldProceed,
      consulted: mockDetectModifications.mock.calls.length,
    }).toEqual({ proceeded: false, consulted: 1 })
  })

  it('handleMergeAction reads and writes under this client key', async () => {
    // Both halves matter and they fail independently: `version` proves the READ
    // resolved to the client-scoped entry, the written key proves the WRITE did.
    // A site-local special-case at one of install.conflict.ts's two
    // manifestKeyFor calls satisfied the checkForConflicts cases alone -- that
    // was the round-2 finding, and this is the arm that reaches the other site.
    await handleMergeAction(
      'my-skill',
      '/installed/my-skill',
      'upstream content',
      manifestWithEntry(`my-skill::${client}`, '7.7.7'),
      'owner',
      'repo',
      'owner/repo/my-skill',
      client
    )

    const meta = mockStoreOriginal.mock.calls[0]![2] as { version: string }
    expect(meta.version).toBe('7.7.7')

    const updater = mockUpdateManifestSafely.mock.calls[0]![0] as (m: unknown) => {
      installedSkills: Record<string, unknown>
    }
    const written = updater({ version: '1', installedSkills: {} })
    expect(Object.keys(written.installedSkills)).toEqual([`my-skill::${client}`])
  })
})

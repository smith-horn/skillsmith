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

import { checkForConflicts, handleMergeAction } from './install.conflict.js'
import type { SkillManifest } from './install.types.js'

const CANONICAL = 'claude-code' as const
const OTHER = 'cursor' as const

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

    expect(result.shouldProceed).toBe(true)
    // The decisive assertion: a bare-name lookup would have found the entry
    // and gone on to compare hashes. Never reaching that call is what proves
    // the key was client-scoped.
    expect(mockDetectModifications).not.toHaveBeenCalled()
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

    expect(result.shouldProceed).toBe(true)
    expect(mockDetectModifications).not.toHaveBeenCalled()
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

describe('a second non-canonical client (SMI-6358 retro)', () => {
  // Closes the third-implementation gap the gate named: a predicate special-cased
  // to one client — `client === 'cursor' ? `${name}::cursor` : name` — passes every
  // test that only ever uses 'cursor'. Exercising a DIFFERENT non-canonical client
  // is what rules that out.
  const THIRD = 'windsurf' as const

  it('checkForConflicts scopes a third client too', async () => {
    const result = await checkForConflicts(
      'my-skill',
      '/installed/my-skill',
      manifestWithEntry('my-skill'),
      undefined,
      'owner/repo/my-skill',
      THIRD
    )
    expect(result.shouldProceed).toBe(true)
    expect(mockDetectModifications).not.toHaveBeenCalled()
  })

  it('handleMergeAction scopes a third client too', async () => {
    // The gate caught this as a fourth instance of the same twin: the windsurf
    // cases above reach checkForConflicts only, so a site-local special-case at
    // handleMergeAction -- `client === 'cursor' ? manifestKeyFor(...) : name` --
    // satisfied all three of its tests. Second-client coverage has to reach
    // BOTH sites, not the one the previous finding was about.
    await handleMergeAction(
      'my-skill',
      '/installed/my-skill',
      'upstream content',
      manifestWithEntry(`my-skill::${THIRD}`, '7.7.7'),
      'owner',
      'repo',
      'owner/repo/my-skill',
      THIRD
    )

    const meta = mockStoreOriginal.mock.calls[0]![2] as { version: string }
    expect(meta.version).toBe('7.7.7')

    const updater = mockUpdateManifestSafely.mock.calls[0]![0] as (m: unknown) => {
      installedSkills: Record<string, unknown>
    }
    const written = updater({ version: '1', installedSkills: {} })
    expect(Object.keys(written.installedSkills)).toEqual([`my-skill::${THIRD}`])
  })

  it('checkForConflicts finds that third client own entry', async () => {
    const result = await checkForConflicts(
      'my-skill',
      '/installed/my-skill',
      manifestWithEntry(`my-skill::${THIRD}`),
      undefined,
      'owner/repo/my-skill',
      THIRD
    )
    expect(mockDetectModifications).toHaveBeenCalledOnce()
    expect(result.shouldProceed).toBe(false)
  })
})

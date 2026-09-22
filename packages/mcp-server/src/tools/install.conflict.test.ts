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
const { mockDetectModifications } = vi.hoisted(() => ({
  mockDetectModifications: vi.fn(),
}))

vi.mock('./install.conflict-helpers.js', async (importActual) => {
  const actual = await importActual<typeof import('./install.conflict-helpers.js')>()
  return { ...actual, detectModifications: mockDetectModifications }
})

import { checkForConflicts } from './install.conflict.js'
import type { SkillManifest } from './install.types.js'

const CANONICAL = 'claude-code' as const
const OTHER = 'cursor' as const

/** A manifest holding exactly one entry, under `key`, that would conflict. */
function manifestWithEntry(key: string): SkillManifest {
  return {
    version: '1',
    installedSkills: {
      [key]: {
        id: 'owner/repo/my-skill',
        name: 'my-skill',
        version: '1.0.0',
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

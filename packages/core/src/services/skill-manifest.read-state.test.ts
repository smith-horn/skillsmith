/**
 * @fileoverview Tests for ADR-171's manifest read-state classifier and its
 * two named policy wrappers.
 * @module @skillsmith/core/services/skill-manifest.read-state.test
 * @see docs/internal/adr/171-manifest-read-state-contract.md
 * @see SMI-6733
 *
 * Every state is exercised against a REAL file on disk in a temp dir, not a
 * mocked `fs` — the one exception is `unreadable`, which needs a
 * permission-denied error `fs.readFile` itself won't reliably produce
 * cross-platform, so that state alone injects the error the same way
 * `skill-manifest.test.ts`'s own EACCES test does (a `vi.fn(actual.readFile)`
 * wrapper that forwards to the real implementation by default).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

// Same pattern as skill-manifest.test.ts: the Node ESM module namespace
// object is not configurable, so `vi.spyOn(fs, 'readFile')` throws. Wrap
// `readFile` in `vi.fn(actual.readFile)` so it forwards to the real
// implementation by default, and individual tests can layer a
// `mockRejectedValueOnce` on top.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
  }
})

import * as fs from 'fs/promises'
import {
  readManifestState,
  loadManifestForWrite,
  loadManifestLenient,
  ManifestUnwritableError,
} from './skill-manifest.read-state.js'
import type { SkillManifest, SkillManifestEntry } from './skill-installation.types.js'

// ============================================================================
// Helpers
// ============================================================================

function makeEntry(overrides: Partial<SkillManifestEntry> = {}): SkillManifestEntry {
  const now = new Date().toISOString()
  return {
    id: overrides.id ?? 'author/skill',
    name: overrides.name ?? 'skill',
    version: overrides.version ?? '1.0.0',
    source: overrides.source ?? 'github:author/skill',
    installPath: overrides.installPath ?? '/tmp/skill',
    installedAt: overrides.installedAt ?? now,
    lastUpdated: overrides.lastUpdated ?? now,
    ...overrides,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('ADR-171 manifest read-state classifier (SMI-6733)', () => {
  let tmpDir: string
  let manifestPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-read-state-test-'))
    manifestPath = path.join(tmpDir, 'manifest.json')
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeManifestFile(content: string): Promise<void> {
    await fs.writeFile(manifestPath, content)
  }

  // --------------------------------------------------------------------------
  // The five states, each from a real file on disk
  // --------------------------------------------------------------------------

  describe('readManifestState', () => {
    it('POSITIVE CONTROL: a genuinely absent manifest classifies `missing`, with an empty writable document', async () => {
      const result = await readManifestState(manifestPath)
      expect(result.state).toBe('missing')
      if (result.state !== 'missing') return
      expect(result.manifest).toEqual({ version: '1.0.0', installedSkills: {} })
      expect(result.raw).toBeNull()
    })

    it('classifies a well-formed manifest `ok`', async () => {
      const doc: SkillManifest = {
        version: '1.0.0',
        installedSkills: { 'author/skill': makeEntry() },
      }
      await writeManifestFile(JSON.stringify(doc))
      const result = await readManifestState(manifestPath)
      expect(result.state).toBe('ok')
      if (result.state !== 'ok') return
      expect(result.manifest).toEqual(doc)
    })

    it('classifies unparseable JSON `corrupt`, carrying the byte position when JSON.parse supplies one', async () => {
      await writeManifestFile('{"a":1,}') // trailing comma — V8 reports a position for this shape
      const result = await readManifestState(manifestPath)
      expect(result.state).toBe('corrupt')
      if (result.state !== 'corrupt') return
      expect(result.reason.length).toBeGreaterThan(0)
      expect(result.position).not.toBeNull()
    })

    it('classifies a shape-invalid but parseable manifest `corrupt`: installedSkills as an ARRAY (the array trap)', async () => {
      await writeManifestFile(JSON.stringify({ version: '1.0.0', installedSkills: [] }))
      const result = await readManifestState(manifestPath)
      expect(result.state).toBe('corrupt')
    })

    it('classifies a shape-invalid but parseable manifest `corrupt`: installedSkills as a plain string', async () => {
      await writeManifestFile(JSON.stringify({ version: '1.0.0', installedSkills: 'hello' }))
      const result = await readManifestState(manifestPath)
      expect(result.state).toBe('corrupt')
    })

    // SMI-6733 Phase 1 fix: `installedSkills: null` is byte-identical to an
    // absent key for every consumer — `{...null}` spreads to `{}` and
    // `Object.entries(null ?? {})`-style guards already treat it as empty,
    // exactly like every ad-hoc tolerance guard elsewhere in this repo
    // (`manifest.installedSkills && typeof …` short-circuits on null). The
    // hazard set SMI-6752 actually measured harm from is non-empty strings
    // and non-empty arrays, not nullish values, so null/undefined classify
    // `ok` while string/number/array — including the array shapes above —
    // stay `corrupt`. Case table lifted verbatim from the SMI-6733 Phase 1
    // task brief.
    describe('nullish vs hazardous installedSkills (case table)', () => {
      it.each([
        ['an absent key (undefined)', undefined],
        ['explicit null', null],
      ])(
        'installedSkills: %s classifies `ok`, degrading to an empty skill set',
        async (_label, value) => {
          const doc: Record<string, unknown> = { version: '1.0.0' }
          if (value !== undefined) doc.installedSkills = value
          await writeManifestFile(JSON.stringify(doc))
          const result = await readManifestState(manifestPath)
          expect(result.state).toBe('ok')
        }
      )

      it.each([
        ['a plain string', 'hello'],
        ['a number', 0],
        ['an empty array', []],
        ['an array of entries', [{ installPath: '/tmp/x' }]],
      ])(
        'installedSkills: %s still classifies `corrupt` — the hazard set, not the nullish set',
        async (_label, value) => {
          await writeManifestFile(JSON.stringify({ version: '1.0.0', installedSkills: value }))
          const result = await readManifestState(manifestPath)
          expect(result.state).toBe('corrupt')
        }
      )
    })

    it('classifies `ok` (NOT `corrupt`) when the container is valid but an entry is malformed — SMI-6732: uninstall() has its own deliberate, tested tolerance for a malformed installedSkills entry (skill-installation.uninstall.guard.test.ts), and per-entry validation here would override it before that tolerance ever runs', async () => {
      const doc = {
        version: '1.0.0',
        installedSkills: { 'author/skill': { ...makeEntry(), installPath: undefined } },
      }
      await writeManifestFile(JSON.stringify(doc))
      const result = await readManifestState(manifestPath)
      expect(result.state).toBe('ok')
    })

    it('classifies a non-ENOENT read error `unreadable`, carrying the errno', async () => {
      const permissionError = Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      })
      vi.mocked(fs.readFile).mockRejectedValueOnce(permissionError)
      const result = await readManifestState(manifestPath)
      expect(result.state).toBe('unreadable')
      if (result.state !== 'unreadable') return
      expect(result.code).toBe('EACCES')
    })

    describe('version handling (ADR-171 § 6 — three cases, major-component comparison)', () => {
      it('a malformed version string classifies `corrupt`, never `version_unsupported`', async () => {
        await writeManifestFile(JSON.stringify({ version: 'not-a-version', installedSkills: {} }))
        const result = await readManifestState(manifestPath)
        expect(result.state).toBe('corrupt')
      })

      it('a newer MAJOR version classifies `version_unsupported`', async () => {
        await writeManifestFile(JSON.stringify({ version: '2.0.0', installedSkills: {} }))
        const result = await readManifestState(manifestPath)
        expect(result.state).toBe('version_unsupported')
        if (result.state !== 'version_unsupported') return
        expect(result.found).toBe('2.0.0')
        expect(result.expected).toBe('1.0.0')
      })

      it('a newer MINOR version classifies `ok` — the comparison is on the major component only', async () => {
        await writeManifestFile(JSON.stringify({ version: '1.9.0', installedSkills: {} }))
        const result = await readManifestState(manifestPath)
        expect(result.state).toBe('ok')
      })
    })

    describe('CAS round-trip (ADR-171 § 3): the object handed onward is the raw JSON.parse value', () => {
      it('an unknown NESTED field survives untouched, and `raw` deep-equals JSON.parse(text)', async () => {
        const rawText = JSON.stringify({
          version: '1.0.0',
          installedSkills: {
            'author/skill': {
              ...makeEntry(),
              // An unknown field, nested two levels deep — future-version
              // forward compatibility (ADR-171 § 3/§ 5).
              futureField: { deeplyNested: { untouched: true } },
            },
          },
          futureTopLevelField: 'preserved',
        })
        await writeManifestFile(rawText)

        const result = await readManifestState(manifestPath)
        expect(result.state).toBe('ok')
        if (result.state !== 'ok') return

        const expected = JSON.parse(rawText) as unknown
        expect(result.raw).toEqual(expected)
        expect(result.manifest).toEqual(expected)
        // SMI-6733 MAJOR 4: `toEqual` alone does not pin the guarantee this
        // test exists for. ADR-171 § 3 forbids the classifier constructing a
        // new object — the CAS compares canonical form taken from the raw
        // `JSON.parse` value, and a copy is a different object with the same
        // contents, which is exactly what a spread produces. Instrument
        // validated with controls: a spread copy deep-equals its original and
        // a modified copy does not, so `toEqual` distinguishes CONTENT; only
        // reference identity distinguishes the COPY. So `manifest: {...parsed}`
        // — the single mutation the rule exists to forbid — passes the two
        // assertions above unchanged and fails this one.
        expect(result.raw).toBe(result.manifest)
      })
    })
  })

  // --------------------------------------------------------------------------
  // loadManifestForWrite: throws on every refusing state, returns the
  // document on ok/missing
  // --------------------------------------------------------------------------

  describe('loadManifestForWrite', () => {
    it('returns the document on `ok`', async () => {
      const doc: SkillManifest = {
        version: '1.0.0',
        installedSkills: { 'author/skill': makeEntry() },
      }
      await writeManifestFile(JSON.stringify(doc))
      await expect(loadManifestForWrite(manifestPath)).resolves.toEqual(doc)
    })

    it('returns an empty writable document on `missing`', async () => {
      await expect(loadManifestForWrite(manifestPath)).resolves.toEqual({
        version: '1.0.0',
        installedSkills: {},
      })
    })

    it('throws ManifestUnwritableError(state: "corrupt") on unparseable JSON', async () => {
      await writeManifestFile('{ not valid json')
      await expect(loadManifestForWrite(manifestPath)).rejects.toBeInstanceOf(
        ManifestUnwritableError
      )
      await expect(loadManifestForWrite(manifestPath)).rejects.toMatchObject({ state: 'corrupt' })
    })

    it('throws ManifestUnwritableError(state: "unreadable") on a non-ENOENT read error', async () => {
      const permissionError = Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      })
      vi.mocked(fs.readFile).mockRejectedValueOnce(permissionError)
      await expect(loadManifestForWrite(manifestPath)).rejects.toMatchObject({
        state: 'unreadable',
      })
    })

    it('throws ManifestUnwritableError(state: "version_unsupported") on a newer major version', async () => {
      await writeManifestFile(JSON.stringify({ version: '2.0.0', installedSkills: {} }))
      await expect(loadManifestForWrite(manifestPath)).rejects.toMatchObject({
        state: 'version_unsupported',
      })
    })

    it('the thrown error carries `path` and the ADR-171 § 8 four-property message', async () => {
      await writeManifestFile('{ not valid json')
      try {
        await loadManifestForWrite(manifestPath)
        expect.unreachable('loadManifestForWrite should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(ManifestUnwritableError)
        const err = error as ManifestUnwritableError
        expect(err.path).toBe(manifestPath)
        // Names the file.
        expect(err.message).toContain(manifestPath)
        // States the file was not modified.
        expect(err.message).toMatch(/has NOT been modified/)
        // Gives one concrete next action, and names the tracking issue.
        expect(err.message).toContain('SMI-6862')
      }
    })
  })

  // --------------------------------------------------------------------------
  // loadManifestLenient: warning mapping per ADR-171 § 4b
  // --------------------------------------------------------------------------

  describe('loadManifestLenient', () => {
    it('warning: null on `missing` — an absent manifest is not a degradation', async () => {
      const result = await loadManifestLenient(manifestPath)
      expect(result.warning).toBeNull()
      expect(result.manifest).toEqual({ version: '1.0.0', installedSkills: {} })
    })

    it('warning: null on `ok`', async () => {
      const doc: SkillManifest = { version: '1.0.0', installedSkills: {} }
      await writeManifestFile(JSON.stringify(doc))
      const result = await loadManifestLenient(manifestPath)
      expect(result.warning).toBeNull()
      expect(result.manifest).toEqual(doc)
    })

    it('warning: non-null + empty manifest on `corrupt`', async () => {
      await writeManifestFile('{ not valid json')
      const result = await loadManifestLenient(manifestPath)
      expect(result.warning).not.toBeNull()
      expect(result.manifest).toEqual({ version: '1.0.0', installedSkills: {} })
    })

    it('warning: non-null + empty manifest on `unreadable`', async () => {
      const permissionError = Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      })
      vi.mocked(fs.readFile).mockRejectedValueOnce(permissionError)
      const result = await loadManifestLenient(manifestPath)
      expect(result.warning).not.toBeNull()
      expect(result.manifest).toEqual({ version: '1.0.0', installedSkills: {} })
    })

    it('warning: non-null + empty manifest on `version_unsupported`', async () => {
      await writeManifestFile(JSON.stringify({ version: '2.0.0', installedSkills: {} }))
      const result = await loadManifestLenient(manifestPath)
      expect(result.warning).not.toBeNull()
      expect(result.manifest).toEqual({ version: '1.0.0', installedSkills: {} })
    })
  })

  // ==========================================================================
  // SMI-6733 Phase 2 Wave 2: the warning is bounded
  // ==========================================================================

  describe('the warning is bounded, because `version` is file-controlled', () => {
    // Wave 2 gave these messages a new egress: `loadManifestLenient`'s warning
    // now rides `skill_outdated` and `skill_updates` to the response root, and
    // therefore into an LLM context window. Measured before `capDiagnostic`, in
    // a temp dir: a 200 KB `version` produced a 200,641-character warning.
    // `install.ts` (SMI-6588) already states the rule — "an unbounded message
    // from an arbitrary throw site is not something to pass back to a caller."
    const HUGE = 'X'.repeat(200_000)

    it('caps a malformed `version`, and still says what is wrong', async () => {
      await writeManifestFile(JSON.stringify({ version: HUGE, installedSkills: {} }))
      const { warning } = await loadManifestLenient(manifestPath)

      expect({
        bounded: (warning ?? '').length < 2_000,
        namesTheProblem: (warning ?? '').includes('major.minor.patch'),
        reportsTheRealSize: (warning ?? '').includes('200000 chars total'),
      }).toEqual({ bounded: true, namesTheProblem: true, reportsTheRealSize: true })
    })

    it('caps an unsupported `version` carrying a junk suffix', async () => {
      // `parseMajorVersion` is deliberately not end-anchored so a prerelease
      // suffix stays supported, which means a junk suffix parses too and this
      // lands in `version_unsupported` rather than `corrupt`. Either way the
      // string must not reach the caller at full length.
      await writeManifestFile(JSON.stringify({ version: `2.0.0${HUGE}`, installedSkills: {} }))
      const { warning } = await loadManifestLenient(manifestPath)

      expect({
        bounded: (warning ?? '').length < 2_000,
        namesTheProblem: (warning ?? '').includes('a newer Skillsmith wrote it'),
      }).toEqual({ bounded: true, namesTheProblem: true })
    })

    it('leaves an ordinary corrupt manifest its FULL diagnostic', async () => {
      // The known-positive control. Without it, a cap that truncated every
      // warning to nothing would pass both tests above — and the whole premise
      // of this change is that a warning has to be actionable, so a cap that
      // ate the remedy would be a regression dressed as a fix.
      await writeManifestFile('{ not valid json')
      const { warning } = await loadManifestLenient(manifestPath)

      expect({
        stillDetailed: (warning ?? '').length > 300,
        namesTheFile: (warning ?? '').includes(manifestPath),
        keepsTheRemedy: (warning ?? '').includes('JSON validator'),
      }).toEqual({ stillDetailed: true, namesTheFile: true, keepsTheRemedy: true })
    })
  })
})

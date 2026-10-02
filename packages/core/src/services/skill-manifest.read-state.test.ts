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
// SMI-6915 split the § 8 message builders out. Gate round 3's point: now that
// they are a separate module with an exported surface, the two `reason` caps can
// be tested against SYNTHETIC refusal states — a test of OUR contract, rather
// than of whatever V8 happens to put in a parse error. That is exactly the
// distinction that made the deleted characterization test wrong and makes these
// two right.
import { buildLenientWarning } from './skill-manifest.read-state.messages.js'

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

    // SMI-6733 Phase 1 fix: `installedSkills: null` is indistinguishable from an
    // absent key to every consumer — `{...null}` spreads to `{}` and
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

      // The surviving mutation a cross-family gate named on PR #2976. Loosening
      // `parseMajorVersion`'s `/^(\d+)\.\d+\.\d+/` to `/^(\d+)/` left every test
      // above green: `not-a-version` still corrupt, `2.0.0` still unsupported,
      // `1.9.0` still ok. What it changes is the shape nobody asserted — a bare
      // `"1"` would classify **ok**, so a manifest the contract calls malformed
      // would silently produce confident tool output.
      //
      // The `'2'` row is the sharpest: under the loosened regex it becomes
      // `version_unsupported`, which ASSERTS a newer writer exists on the
      // evidence of a string that records no minor or patch at all. § 6's first
      // rider exists to forbid exactly that inference.
      //
      // The two junk-suffix rows are not oversights — they pin the stated COST
      // of leaving the regex un-anchored, which is what keeps `1.0.0-beta`
      // supported. Anchoring it would make this table's last two rows corrupt
      // and break prerelease manifests, so the table records the trade rather
      // than leaving a reader to guess which half was intended.
      it.each([
        ['1', 'corrupt'],
        ['1.0', 'corrupt'],
        ['2', 'corrupt'],
        ['1.0.0-beta', 'ok'],
        ['1.0.0+build', 'ok'],
        ['1.0.0garbage', 'ok'],
        // Round 2: the suffix rows pin the deliberate absence of an END anchor
        // and say nothing about the START one. Dropping `^` turns this row from
        // corrupt into version_unsupported — asserting a newer writer exists on
        // a string that does not begin with a version at all.
        ['junk2.0.0', 'corrupt'],
      ])('version %j classifies %s', async (version, expected) => {
        await writeManifestFile(JSON.stringify({ version, installedSkills: {} }))
        const result = await readManifestState(manifestPath)
        expect(result.state).toBe(expected)
      })

      // Post-merge retro on cfc96eccd. Every row in the table above holds
      // `installedSkills: {}`, so none of them combines a newer major version
      // with an INVALID shape — and that combination is the only thing that
      // observes which of the two checks runs first.
      //
      // The surviving mutation: `isPlainObject(parsed)` -> `isValidManifestShape(parsed)`
      // at the `versionValue` read inverts the precedence and passes 42 of 42.
      // Measured, not argued. What it changes is the answer for a manifest a
      // NEWER Skillsmith wrote whose shape this version does not recognise:
      // `version_unsupported` becomes `corrupt`, and the user is told "Open the
      // file and correct that field" about a file that is not theirs to correct.
      // ADR-171 § 6 names discarding a newer version's records as the harm this
      // state exists to prevent, so the precedence is load-bearing, not stylistic.
      //
      // `installedSkills: []` is the sharpest fixture available because it is
      // separately pinned as `corrupt` in the shape table above. That makes this
      // row a genuine discriminator between the two orderings rather than a
      // second sample of the same one.
      // The cross-family gate on PR #2980 named what the first three rows
      // still left room for, and it is worth stating because it is subtler
      // than the mutation they were written against: an implementation that
      // checks version first ONLY for array/string values and falls back to
      // shape-first for every other invalid type passes all three. That is not
      // a contrived mutation — a hand-written predicate enumerating the shapes
      // it has seen in fixtures arrives at exactly it.
      //
      // So the row set has to span the invalid-type SPACE, not a sample of it:
      // the two container types a reader would think of, plus the three
      // primitive classes nobody writes a fixture for.
      it.each([
        ['an array', [] as unknown],
        ['a string', 'hello' as unknown],
        ['an array of entries', [{ installPath: '/tmp/x' }] as unknown],
        ['a number', 42 as unknown],
        ['a boolean', true as unknown],
        ['the literal false', false as unknown],
      ])(
        'a NEWER major version wins over an invalid shape (%s) — § 6 precedence',
        async (_label, installedSkills) => {
          await writeManifestFile(JSON.stringify({ version: '2.0.0', installedSkills }))
          const result = await readManifestState(manifestPath)
          expect(result.state).toBe('version_unsupported')
        }
      )
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

    // Round 2 re-derivation. A truncating path cap was the WRONG mechanism, not a
    // mis-sized one: a 400-char ceiling sits below `PATH_MAX` (1024 on macOS,
    // 4096 on Linux), so two valid paths sharing a 400-char prefix rendered
    // identically and the message no longer said which file failed — § 8's whole
    // point. Truncation also emits a string that LOOKS like a path and is not.
    //
    // The rule is now all-or-nothing, and these two tests are a pair: one proves
    // a long-but-real path survives INTACT, the other proves a path that cannot
    // name a file is not echoed at all. Neither alone distinguishes the fix from
    // the cap it replaced.
    it('echoes a long but VALID path intact — no prefix, no ambiguity', async () => {
      // 900 characters: longer than the deleted 400 cap, shorter than PATH_MAX.
      // The old mechanism truncated this; § 8 requires it to survive whole.
      const deep = `${tmpDir}/${'d'.repeat(60)}`.padEnd(900, 'x')
      const { warning } = await loadManifestLenient(deep)

      expect({
        namesTheWholePath: (warning ?? '').includes(deep),
        notTruncated: !(warning ?? '').includes('…'),
      }).toEqual({ namesTheWholePath: true, notTruncated: true })
    })

    it('refuses to echo a path too long to name a file, and says why', async () => {
      // The other half. 200 KB cannot be a path on any filesystem, so echoing a
      // prefix of it would be worse than useless. Report the length instead, so
      // the user learns the PATH is the fault rather than a file's contents.
      const absurd = 'x'.repeat(200_000)
      const { warning } = await loadManifestLenient(absurd)

      expect({
        bounded: (warning ?? '').length < 2_000,
        carriesNoPrefixOfIt: !(warning ?? '').includes('x'.repeat(200)),
        reportsItsLength: (warning ?? '').includes('200000 characters'),
        stillSaysTheReadFailed: (warning ?? '').includes('could not be read'),
      }).toEqual({
        bounded: true,
        carriesNoPrefixOfIt: true,
        reportsItsLength: true,
        stillSaysTheReadFailed: true,
      })
    })

    it('names the path exactly ONCE, however long it is', async () => {
      // Gate round 3 regression guard. The `unreadable` remedy used to repeat the
      // path inside an `ls -l` suggestion, so every unreadable manifest paid for
      // two copies: measured 8,407 characters for a 4096-char path and 49,369
      // once JSON-serialized with NUL bytes, because `String.length` is not
      // serialized size. Halved by removing the second interpolation.
      //
      // Asserting the COUNT rather than a length ceiling is deliberate: a ceiling
      // would pass again the moment someone re-added the copy with a smaller
      // path, and the defect is the duplication, not the size.
      const longPath = `${tmpDir}/${'p'.repeat(600)}`
      const { warning } = await loadManifestLenient(longPath)
      const w = warning ?? ''

      expect({
        occurrences: w.split(longPath).length - 1,
        noShellCommandCarryingIt: !w.includes('ls -l'),
      }).toEqual({ occurrences: 1, noShellCommandCarryingIt: true })
    })

    it('bounds an oversized `reason` on both branches that carry one', async () => {
      // The caps gate round 1 asked for and gate round 3 asked to test directly.
      // Driven through synthetic states, because neither is reachable from a real
      // file on this engine — V8 self-truncates its parse message, and the
      // `unreadable` branch prefers `result.code` whenever the error carries one.
      // So this pins the CONTRACT (an oversized reason is bounded) without
      // depending on an engine detail to produce it.
      const huge = 'z'.repeat(200_000)

      const unparseable = buildLenientWarning('/tmp/m.json', {
        state: 'corrupt',
        kind: 'unparseable',
        reason: huge,
        position: null,
      })
      const unreadable = buildLenientWarning('/tmp/m.json', {
        state: 'unreadable',
        reason: huge,
        code: null, // the only path on which `reason` is consulted at all
      })

      expect({
        unparseableBounded: unparseable.length < 2_000,
        unreadableBounded: unreadable.length < 2_000,
        // Still diagnostic, not merely short — and reporting the real size is
        // what tells a reader the value was large rather than absent.
        unparseableSaysSize: unparseable.includes('200000 chars total'),
        unreadableSaysSize: unreadable.includes('200000 chars total'),
      }).toEqual({
        unparseableBounded: true,
        unreadableBounded: true,
        unparseableSaysSize: true,
        unreadableSaysSize: true,
      })
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

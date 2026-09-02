/**
 * Check 65 negative test (SMI-6343 Wave 1).
 *
 * The check exists because two mcp-server integration tests wrote fixture rows
 * into a REAL user's ~/.skillsmith/manifest.json: they mocked their install
 * paths but not their manifest path, and every manifest-writing symbol
 * defaults that path to `os.homedir()/.skillsmith/manifest.json`.
 *
 * These assertions drive `evaluateManifestHygiene` with synthetic file
 * contents (no disk I/O), so they prove the three behaviours the plan asks
 * for: a file missing the override IS flagged, an allowlisted one is NOT, and
 * a stale allowlist entry is reported. The last one is the Check 62 lesson —
 * an allowlist that never drains eventually masks a real regression at the
 * same path.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import {
  evaluateManifestHygiene,
  hasManifestPathOverride,
  referencesManifestWriter,
  listManifestHygieneTestFiles,
} from '../audit-manifest-hygiene-helpers.mjs'

type HygieneResult = {
  findings: string[]
  staleAllowlistEntries: string[]
  scanned: number
  matched: number
}

const evaluate = (
  files: Array<{ path: string; content: string }>,
  allowlist: string[] = []
): HygieneResult =>
  (evaluateManifestHygiene as (input: unknown) => HygieneResult)({ files, allowlist })

const EXPOSED = `
  import { SkillInstallationService } from '@skillsmith/core'
  it('installs', async () => {
    const service = new SkillInstallationService({ skillsDir: '/tmp/x' })
    await service.install('owner/name')
  })
`

describe('SMI-6343 Check 65: manifest-hygiene detection', () => {
  it('flags a test that constructs a manifest writer with no explicit manifest path', () => {
    const result = evaluate([{ path: 'packages/core/tests/leaky.test.ts', content: EXPOSED }])
    expect(result.findings).toEqual(['packages/core/tests/leaky.test.ts'])
    expect(result.staleAllowlistEntries).toEqual([])
  })

  it('does NOT flag the same file once it is allowlisted', () => {
    const result = evaluate(
      [{ path: 'packages/core/tests/leaky.test.ts', content: EXPOSED }],
      ['packages/core/tests/leaky.test.ts']
    )
    expect(result.findings).toEqual([])
    expect(result.staleAllowlistEntries).toEqual([])
  })

  it('reports an allowlist entry whose file no longer matches (fixed in place)', () => {
    const fixed = EXPOSED.replace(
      "skillsDir: '/tmp/x'",
      "skillsDir: '/tmp/x', manifestPath: '/tmp/x/manifest.json'"
    )
    const result = evaluate(
      [{ path: 'packages/core/tests/leaky.test.ts', content: fixed }],
      ['packages/core/tests/leaky.test.ts']
    )
    expect(result.findings).toEqual([])
    expect(result.staleAllowlistEntries).toEqual(['packages/core/tests/leaky.test.ts'])
  })

  it('reports an allowlist entry whose file no longer exists (renamed/deleted)', () => {
    const result = evaluate([], ['packages/core/tests/gone.test.ts'])
    expect(result.staleAllowlistEntries).toEqual(['packages/core/tests/gone.test.ts'])
  })

  it('does not flag a file that never references a manifest writer', () => {
    const result = evaluate([
      { path: 'packages/core/tests/unrelated.test.ts', content: 'expect(1).toBe(1)\n' },
    ])
    expect(result.findings).toEqual([])
    expect(result.matched).toBe(0)
  })

  describe('override forms that count as naming your own manifest path', () => {
    // Bracket notation is the dominant form in this repo
    // (`process.env['HOME'] = homeDir`). A dot-only pattern under-matched by
    // four files when this check was first measured, so each accepted form
    // gets its own assertion rather than being assumed.
    const cases: Array<[string, string]> = [
      ['explicit manifestPath option', "manifestPath: path.join(tmp, 'manifest.json')"],
      ['dot-notation HOME override', 'process.env.HOME = tmpHome'],
      ['bracket-notation HOME override', "process.env['HOME'] = tmpHome"],
      ['double-quoted bracket HOME override', 'process.env["HOME"] = tmpHome'],
      ['USERPROFILE override (Windows)', "process.env['USERPROFILE'] = tmpHome"],
      ['SKILLSMITH_HOME override', 'process.env.SKILLSMITH_HOME = tmpHome'],
      ['vi.stubEnv', "vi.stubEnv('HOME', tmpHome)"],
      ['sanctioned helper', 'const p = await createIsolatedManifestPath()'],
    ]
    for (const [name, snippet] of cases) {
      it(`accepts ${name}`, () => {
        const result = evaluate([
          { path: 'packages/core/tests/ok.test.ts', content: `${EXPOSED}\n${snippet}\n` },
        ])
        expect(result.matched).toBe(1)
        expect(result.findings).toEqual([])
      })
    }
  })

  describe('writer-symbol matching', () => {
    it('matches every symbol the check claims to cover', () => {
      for (const snippet of [
        'new SkillInstallationService({})',
        'await installSkill(input, ctx)',
        'await backfillManifest({ apply: true })',
        'const m = new ManifestManager(p)',
      ]) {
        expect(referencesManifestWriter(snippet), snippet).toBe(true)
      }
    })

    it('does not match a bare ManifestManager type reference (a type import is not a write)', () => {
      expect(referencesManifestWriter("import type { ManifestManager } from 'x'")).toBe(false)
    })

    it('does not treat createTestFilesystem alone as an override', () => {
      // It hands back an isolated manifestPath, but a file that calls it and
      // never wires that path into the writer is still exposed — exempting on
      // the call alone would grant the whole integration suite a free pass.
      expect(hasManifestPathOverride('const ctx = await createTestFilesystem()')).toBe(false)
    })
  })

  it('scans the canonical test locations, not just packages/*/tests', () => {
    // Guards against the original scope draft, which missed two of CLAUDE.md's
    // seven canonical test locations (tests/** and scripts/tests/**).
    const files = (listManifestHygieneTestFiles as (cwd?: string) => string[])()
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((f) => f.includes('scripts/tests/'))).toBe(true)
    expect(files.some((f) => f.includes('packages/core/src/'))).toBe(true)
    expect(files.some((f) => f.includes('packages/mcp-server/tests/'))).toBe(true)
  })
})

/**
 * Check 65 negative test (SMI-6343 Wave 1).
 *
 * The check exists because SMI-6343's investigation found fixture rows
 * (`test-skill`, `shutdown-persistence-fixture`) in a REAL user's
 * ~/.skillsmith/manifest.json, traced to two mcp-server integration tests
 * whose manifest path — before ADR-139 (SMI-6274 Wave 4, #2634, merged
 * 2026-08-30, two days before this fix) added the `manifestPath` override
 * those tests now use — defaulted to `os.homedir()/.skillsmith/manifest.json`
 * like every manifest-writing symbol. The rows are residual evidence of that
 * historical leak; by the time this fix landed, #2634 had already isolated
 * those two specific files as an unrelated side effect of its own workspace-
 * scoping work. Check 65 exists as defense-in-depth for the wider,
 * still-live class: four separate homedir-defaulting manifest writers exist
 * across the repo (`ManifestManager`, and three siblings in mcp-server, cli,
 * and fan-out.ts — an adversarial-review finding fixed in the same commit as
 * this check), and nothing but the global $HOME test sandbox protected the
 * three siblings until that fix.
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
  MANIFEST_WRITER_PATTERNS,
  MANIFEST_WRITER_SYMBOLS,
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

    // Adversarial-review follow-up (SMI-6343): SKILLSMITH_HOME is no longer
    // accepted — no production writer reads it (grep-confirmed), so crediting
    // it as isolation evidence was false. A file that sets only this env var
    // is still exposed and must be flagged.
    it('does NOT accept SKILLSMITH_HOME (no writer honors it)', () => {
      const result = evaluate([
        {
          path: 'packages/core/tests/leaky.test.ts',
          content: `${EXPOSED}\nprocess.env.SKILLSMITH_HOME = tmpHome\n`,
        },
      ])
      expect(result.matched).toBe(1)
      expect(result.findings).toEqual(['packages/core/tests/leaky.test.ts'])
    })

    // Adversarial-review follow-up (SMI-6343): a bare `manifestPath` token
    // anywhere in the file — a comment, a TODO, an unrelated string — used to
    // count as isolation evidence. It no longer does; the pattern now
    // requires real-code context (assignment, property key, property access,
    // or bare call argument).
    it('does NOT accept a bare manifestPath token with no assignment/property context', () => {
      const result = evaluate([
        {
          path: 'packages/core/tests/leaky.test.ts',
          content: `${EXPOSED}\n// TODO: pass a manifestPath here\n`,
        },
      ])
      expect(result.matched).toBe(1)
      expect(result.findings).toEqual(['packages/core/tests/leaky.test.ts'])
    })

    // Regression pin for the first tightening's own bug: `.manifestPath`
    // (property access) and a bare `manifestPath)` call-argument reference
    // are both genuine explicit-path constructions and must be accepted —
    // `new ManifestManager(target.manifestPath)` is exactly the shape
    // packages/core/src/install/workspace-scope.test.ts uses.
    it('accepts manifestPath as a property access (target.manifestPath)', () => {
      const result = evaluate([
        {
          path: 'packages/core/tests/ok.test.ts',
          content: `${EXPOSED}\nnew ManifestManager(target.manifestPath)\n`,
        },
      ])
      expect(result.matched).toBe(1)
      expect(result.findings).toEqual([])
    })

    it('accepts manifestPath as a bare call-argument identifier', () => {
      const result = evaluate([
        {
          path: 'packages/core/tests/ok.test.ts',
          content: `${EXPOSED}\nnew ManifestManager(manifestPath)\n`,
        },
      ])
      expect(result.matched).toBe(1)
      expect(result.findings).toEqual([])
    })
  })

  describe('writer-symbol matching', () => {
    it('matches every symbol the check claims to cover', () => {
      for (const snippet of [
        'new SkillInstallationService({})',
        'await installSkill(input, ctx)',
        'await backfillManifest({ apply: true })',
        'const m = new ManifestManager(p)',
        // Adversarial-review follow-up (SMI-6343): the three sibling
        // homedir-defaulting writers found alongside ManifestManager.
        'await updateManifestSafely((m) => m)',
        'await saveManifest(manifest)',
        'await acquireManifestLock()',
        'await updateManifestEntry((m) => m)',
        'await addLink({ skillId, fromClient, toClient })',
        'await removeLinks(skillId)',
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

  describe('finding-message symbol labels stay in sync with the patterns', () => {
    // pr-reviewer PR-12 (SMI-6343): the adversarial-review follow-up grew
    // MANIFEST_WRITER_PATTERNS from 4 entries to 10 but left Check 65's
    // finding message naming only the original 4 — so a test tripped by
    // `saveManifest` was told to look for four symbols none of which appear in
    // its file. The message now renders MANIFEST_WRITER_SYMBOLS; this asserts
    // the two arrays cannot drift apart again.
    const patterns = MANIFEST_WRITER_PATTERNS as RegExp[]
    const symbols = MANIFEST_WRITER_SYMBOLS as string[]

    it('has one label per pattern', () => {
      expect(symbols).toHaveLength(patterns.length)
    })

    it('every label is matched by its own positionally-paired pattern', () => {
      symbols.forEach((symbol, i) => {
        expect(patterns[i].test(symbol), `${symbol} vs ${patterns[i]}`).toBe(true)
      })
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

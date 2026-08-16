/**
 * SMI-6033 Wave 1 (Gap 7, cross-model review follow-up): integrity assertions on
 * the CHECKED-IN typosquat reference snapshot shipped inside the published
 * `@skillsmith/mcp-server` tarball.
 *
 * Why this file exists: the asset originally shipped as
 * `{"generatedAt": null, "source": "...", "names": []}`. With an empty `names`
 * array `scanTyposquatName()` / `detectTyposquatInName()` return `[]`
 * unconditionally, so BOTH offline typosquat checks (`skill_validate` and, since
 * this same follow-up, `skill_rescan`) were permanent no-ops — and nothing in
 * the build, the test suite, or the release flow noticed. These assertions make
 * that failure mode loud.
 *
 * Deliberate scope: NO staleness/age assertion here. An age check in the unit
 * suite would turn every branch's CI red on a date, unrelated to the change
 * under test. Staleness is a release-cadence concern and is gated where it
 * belongs — `scripts/lib/release-typosquat-snapshot.ts`'s
 * `MAX_SNAPSHOT_AGE_DAYS` check, which runs inside `prepare-release.ts`.
 *
 * Regenerate with: `varlock run -- npx tsx scripts/generate-typosquat-snapshot.ts`
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SNAPSHOT_PATH = join(__dirname, '..', 'src', 'assets', 'typosquat-reference-snapshot.json')

interface Snapshot {
  generatedAt: unknown
  source: unknown
  names: unknown
}

function loadSnapshot(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8')) as Snapshot
}

describe('bundled typosquat reference snapshot (SMI-6033 Wave 1, Gap 7)', () => {
  it('is present and parseable JSON', () => {
    expect(() => loadSnapshot()).not.toThrow()
  })

  it('is NOT empty — an empty names array silently disables skill_validate + skill_rescan typosquat checks', () => {
    const { names } = loadSnapshot()
    expect(Array.isArray(names), '`names` must be an array').toBe(true)
    expect(
      (names as unknown[]).length,
      'Snapshot shipped with zero reference names — regenerate with ' +
        '`varlock run -- npx tsx scripts/generate-typosquat-snapshot.ts`'
    ).toBeGreaterThan(0)
  })

  it('carries a non-null, parseable, non-future `generatedAt`', () => {
    const { generatedAt } = loadSnapshot()
    expect(typeof generatedAt, '`generatedAt` must be an ISO string, not null').toBe('string')
    const parsedMs = Date.parse(generatedAt as string)
    expect(Number.isNaN(parsedMs), `\`generatedAt\` is unparseable: ${String(generatedAt)}`).toBe(
      false
    )
    // A future timestamp means a hand-edited asset or a badly skewed clock —
    // either way the release-time staleness gate would be defeated by it.
    expect(parsedMs, '`generatedAt` is in the future').toBeLessThanOrEqual(Date.now() + 60_000)
  })

  it('records the reference-list source', () => {
    expect(loadSnapshot().source).toBe('skills.stars+high-trust')
  })

  it('contains only non-blank, lowercase, de-duplicated names', () => {
    const names = loadSnapshot().names as string[]
    const blank = names.filter((n) => typeof n !== 'string' || n.trim() === '')
    expect(blank, 'blank/non-string entries would silently widen the detector').toEqual([])

    // The loader lowercases on read and `detectTyposquat` compares lowercased,
    // so a mixed-case entry is dead weight that never matches on its own.
    const notLower = names.filter((n) => n !== n.toLowerCase())
    expect(notLower.slice(0, 5), 'non-lowercase entries found').toEqual([])

    expect(new Set(names).size, 'duplicate entries in the snapshot').toBe(names.length)
  })
})

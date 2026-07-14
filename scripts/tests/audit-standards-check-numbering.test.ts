/**
 * Companion to audit-standards.test.ts (SMI-5682 check-number uniqueness
 * guard). Sibling file per the SMI-5141 convention (keeps
 * audit-standards.test.ts under the 500-line CI gate).
 *
 * scripts/audit-standards.mjs prints check headers in two conventions:
 *   - main sequence:  console.log(`\n${BOLD}12. Some Title${RESET}`)
 *   - family style:   console.log(`\n${BOLD}Check 55: Some Title${RESET}`)
 *
 * The SMI-4829 cutover added family-style checks numbered 21/23/24, which the
 * growing main sequence later collided with — two different checks printing
 * the same number (SMI-5682; the SMI-5681 plan needed an explicit "do not
 * confuse the two Check 23s" warning). This test reads the audit script as
 * raw text and asserts every check number is unique across BOTH conventions,
 * so the collision class cannot recur silently. It also would have caught the
 * mid-flight SMI-5680 collision (a concurrent PR claimed 54 while SMI-5682
 * was being planned against 54/55/56).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AUDIT_SCRIPT = join(__dirname, '..', 'audit-standards.mjs')

describe('audit-standards check-number uniqueness (SMI-5682)', () => {
  const source = readFileSync(AUDIT_SCRIPT, 'utf-8')

  // Both patterns are unanchored: some headers lack the leading \n (e.g. the
  // very first check), and one family header sits on a template-literal
  // continuation line. `${BOLD}` in the source is matched literally.
  const MAIN_HEADER = /\$\{BOLD\}(\d+)\./g
  const FAMILY_HEADER = /\$\{BOLD\}Check (\d+):/g

  const collect = (pattern: RegExp): number[] =>
    Array.from(source.matchAll(pattern), (m) => Number(m[1]))

  it('finds headers in both conventions (regexes are not silently dead)', () => {
    expect(collect(MAIN_HEADER).length).toBeGreaterThan(0)
    expect(collect(FAMILY_HEADER).length).toBeGreaterThan(0)
  })

  it('has no duplicate check number across both header conventions', () => {
    const numbers = [...collect(MAIN_HEADER), ...collect(FAMILY_HEADER)]
    const seen = new Set<number>()
    const duplicates = new Set<number>()
    for (const n of numbers) {
      if (seen.has(n)) duplicates.add(n)
      seen.add(n)
    }
    const sortedDuplicates = [...duplicates].sort((a, b) => a - b)
    expect(
      sortedDuplicates,
      `Duplicate check number(s) in scripts/audit-standards.mjs: ` +
        `${sortedDuplicates.join(', ')} — two checks print the same number. ` +
        `Renumber the newer check to the next free number (see ` +
        `docs/internal/implementation/audit-standards-check-numbering-family.md)`
    ).toEqual([])
  })
})

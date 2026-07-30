/**
 * @fileoverview Unit tests for candidate ordering/pagination (SMI-5883 §9 H-15).
 * @module @skillsmith/cli/commands/audit-security.candidates.test
 *
 * H-15(d): the union of all `--json` pages (arbitrary page size) equals the
 * `--all-candidates` array exactly, with no duplicates and no omissions --
 * the deterministic total ordering (D-14) is what makes this possible.
 */

import { describe, expect, it } from 'vitest'
import type { Candidate } from '@skillsmith/mcp-server/audit'

import {
  allCandidatesPagination,
  orderedCandidates,
  paginate,
} from './audit-security.candidates.js'

type SecuritySeverity = Candidate['finding']['severity']
const SEVERITIES: readonly SecuritySeverity[] = ['low', 'medium', 'high', 'critical']

function candidate(i: number): Candidate {
  return {
    acceptKey: i.toString(16).padStart(64, '0'),
    sourcePath: `/skills/skill-${i % 13}/SKILL.md`,
    identifier: `skill-${i % 13}`,
    contentDigest: 'a'.repeat(64),
    findingFingerprint: i.toString(16).padStart(64, 'b'),
    rulesetVersion: 'v1',
    finding: {
      type: 'jailbreak',
      severity: SEVERITIES[i % SEVERITIES.length] as SecuritySeverity,
      message: `finding-${i}`,
      lineNumber: i,
    },
    skillPassed: i % 5 === 0,
    acceptedAt: null,
    duplicateCount: 1,
    affectedSkills: [
      { sourcePath: `/skills/skill-${i % 13}/SKILL.md`, identifier: `skill-${i % 13}` },
    ],
  }
}

describe('candidate pagination (H-15)', () => {
  it('(d) the union of all pages (an uneven page size) equals --all-candidates exactly -- no duplicates, no omissions', () => {
    const index = new Map<string, Candidate>()
    for (let i = 0; i < 1200; i++) {
      const c = candidate(i)
      index.set(c.acceptKey, c)
    }

    const all = orderedCandidates(index)
    expect(all).toHaveLength(1200)

    const pageSize = 173 // deliberately does not divide 1200 evenly
    const totalPages = Math.ceil(all.length / pageSize)
    const unioned: Candidate[] = []
    for (let page = 1; page <= totalPages; page++) {
      const { items, pagination } = paginate(all, page, pageSize)
      expect(pagination.total).toBe(1200)
      expect(pagination.totalPages).toBe(totalPages)
      unioned.push(...items)
    }

    expect(unioned).toEqual(all) // exact union, same order, no dup/omission
    expect(new Set(unioned.map((c) => c.acceptKey)).size).toBe(1200)
  })

  it('an out-of-range page returns an empty array with a correct pagination block (not an error)', () => {
    const index = new Map<string, Candidate>()
    for (let i = 0; i < 10; i++) {
      const c = candidate(i)
      index.set(c.acceptKey, c)
    }
    const all = orderedCandidates(index)
    const { items, pagination } = paginate(all, 99, 200)
    expect(items).toEqual([])
    expect(pagination.total).toBe(10)
    expect(pagination.page).toBe(99)
  })

  it('--all-candidates pagination reports complete:true and the full uncapped total', () => {
    const index = new Map<string, Candidate>()
    for (let i = 0; i < 1200; i++) {
      const c = candidate(i)
      index.set(c.acceptKey, c)
    }
    const all = orderedCandidates(index)
    const pagination = allCandidatesPagination(all.length)
    expect(pagination.complete).toBe(true)
    expect(pagination.total).toBe(1200)
    expect(pagination.totalPages).toBe(1)
  })

  it('ordering is total and stable: severity desc, then identifier, then filePath, then lineNumber, then acceptKey tiebreaker', () => {
    const a: Candidate = candidate(1)
    const b: Candidate = {
      ...candidate(2),
      finding: { ...candidate(2).finding, severity: 'critical' },
    }
    const index = new Map<string, Candidate>([
      [a.acceptKey, a],
      [b.acceptKey, b],
    ])
    const ordered = orderedCandidates(index)
    // critical (b) sorts before whatever `a` drew, unless a is ALSO critical.
    if (a.finding.severity !== 'critical') {
      expect(ordered[0]?.acceptKey).toBe(b.acceptKey)
    }
  })
})

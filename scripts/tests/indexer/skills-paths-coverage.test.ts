// skillsPaths coverage test (SMI-4860)
//
// Pins that the Phase 5 publishers with nested SKILL.md trees have
// skillsPaths values that actually match their layout. Regression context:
//
// 2026-05-11 18:23 UTC validation cron 25689025998 showed quarantined=20
// because three Phase 5 publishers had skillsPaths one level too shallow.
// expandGlobSkillsPaths walked parent directories without SKILL.md and
// quarantined all candidates.
//
// Corrected via `gh api repos/<owner>/<repo>/contents/<path>` tree probes:
//
// shadcn-ui/ui    — skills/shadcn/SKILL.md                              — ['skills']  (no change)
// expo/skills     — plugins/expo/skills/<name>/SKILL.md                 — ['plugins/expo/skills']
// wshobson/agents — plugins/<plugin>/skills/<name>/SKILL.md (153 skills)— ['plugins/<star>/skills'] (note: angle-bracketed star to avoid JSDoc close)
//
// The wildcard regex from globToSkillMdRegex adds /[^/]+/SKILL\\.md$ —
// so the wshobson wildcard pattern compiles to
// ^plugins/[^/]+/skills/[^/]+/SKILL\\.md$ which matches the four-segment
// actual layout. The previous skinny value compiled to a three-segment
// regex — too shallow for wshobson and a no-op for expo.

import { describe, it, expect } from 'vitest'
import { globToSkillMdRegex } from '../../indexer/trees-search.ts'
import { HIGH_TRUST_AUTHORS } from '../../indexer/high-trust-authors.ts'

function findAuthor(owner: string, repo: string) {
  const entry = HIGH_TRUST_AUTHORS.find((a) => a.owner === owner && a.repo === repo)
  expect(entry, `${owner}/${repo} must be in HIGH_TRUST_AUTHORS`).toBeDefined()
  return entry!
}

describe('Phase 5 nested-tree publishers — skillsPaths shape (SMI-4860)', () => {
  it('shadcn-ui/ui uses plain ["skills"] (SKILL.md at skills/shadcn/SKILL.md)', () => {
    const entry = findAuthor('shadcn-ui', 'ui')
    expect(entry.skillsPaths).toEqual(['skills'])
  })

  it('expo/skills uses plain ["plugins/expo/skills"] (SKILL.md at plugins/expo/skills/<name>/SKILL.md)', () => {
    const entry = findAuthor('expo', 'skills')
    expect(entry.skillsPaths).toEqual(['plugins/expo/skills'])
  })

  it('wshobson/agents uses wildcard ["plugins/*/skills"] (SKILL.md at plugins/<plugin>/skills/<name>/SKILL.md)', () => {
    const entry = findAuthor('wshobson', 'agents')
    expect(entry.skillsPaths).toEqual(['plugins/*/skills'])
  })
})

describe('globToSkillMdRegex — wildcard depth matches Phase 5 layouts (SMI-4860)', () => {
  it('plugins/*/skills matches the wshobson/agents four-segment layout', () => {
    const regex = globToSkillMdRegex('plugins/*/skills')
    // Concrete paths from the actual tree probe
    expect(
      regex.test('plugins/accessibility-compliance/skills/screen-reader-testing/SKILL.md')
    ).toBe(true)
    expect(regex.test('plugins/api-design/skills/rest-endpoint-design/SKILL.md')).toBe(true)
    expect(regex.test('plugins/security-audit/skills/owasp-top-ten/SKILL.md')).toBe(true)
  })

  it('plugins/*/skills rejects too-shallow paths (the pre-SMI-4860 bug shape)', () => {
    const regex = globToSkillMdRegex('plugins/*/skills')
    // The old skillsPaths: ['plugins'] would have appended /[^/]+/SKILL.md and
    // matched these three-segment paths, but the real tree has FOUR segments.
    expect(regex.test('plugins/accessibility-compliance/SKILL.md')).toBe(false)
    expect(regex.test('plugins/skills/SKILL.md')).toBe(false)
  })

  it('plugins/*/skills rejects too-deep paths (defense against future depth drift)', () => {
    const regex = globToSkillMdRegex('plugins/*/skills')
    // Anything deeper than the documented four segments must not match —
    // protects against an upstream layout change silently re-quarantining rows.
    expect(
      regex.test('plugins/accessibility-compliance/skills/subdir/screen-reader-testing/SKILL.md')
    ).toBe(false)
  })

  it('plugins/* (the pre-SMI-4860 wrong shape) does NOT match the wshobson layout', () => {
    // Documents WHY 18:23 UTC cron quarantined wshobson rows: the old
    // skinny ['plugins'] entry took the Contents API plain-path branch and
    // looked for plugins/SKILL.md (didn't exist). Even if a wildcard had
    // been used (plugins/*), the regex compiles to a three-segment shape
    // that wshobson's four-segment actual layout never satisfies.
    const wrongRegex = globToSkillMdRegex('plugins/*')
    expect(
      wrongRegex.test('plugins/accessibility-compliance/skills/screen-reader-testing/SKILL.md')
    ).toBe(false)
    // The wrong-shape regex matches plugins/X/Y/SKILL.md — but no such
    // path exists in the wshobson tree (every plugin has a skills/ subdir).
    expect(wrongRegex.test('plugins/foo/SKILL.md')).toBe(false)
    expect(wrongRegex.test('plugins/foo/bar/SKILL.md')).toBe(true)
  })
})

describe('Plain-path entries — no wildcard, handled by Contents API scan (SMI-4860)', () => {
  it('shadcn-ui/ui plain path does not contain wildcard (Contents API path)', () => {
    const entry = findAuthor('shadcn-ui', 'ui')
    for (const p of entry.skillsPaths) expect(p.includes('*')).toBe(false)
  })

  it('expo/skills plain path does not contain wildcard (Contents API path)', () => {
    const entry = findAuthor('expo', 'skills')
    for (const p of entry.skillsPaths) expect(p.includes('*')).toBe(false)
  })

  it('wshobson/agents wildcard path takes the Trees API branch', () => {
    const entry = findAuthor('wshobson', 'agents')
    expect(entry.skillsPaths.some((p) => p.includes('*'))).toBe(true)
  })
})

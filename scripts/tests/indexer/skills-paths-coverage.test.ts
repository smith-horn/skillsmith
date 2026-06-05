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

// SMI-4843 Phase 5b (2026-05-18): the 12 new publishers. Each assertion pins
// that the configured skillsPaths (or its omission, for flat layouts) actually
// surfaces >=1 SKILL.md given the live tree probe — the SMI-4860 quarantine
// failure mode. Tree paths are the concrete results from
// `gh api repos/<owner>/<repo>/git/trees/HEAD?recursive=1` (2026-05-18),
// recorded in docs/internal/research/smi-4843-phase5b-candidates.md.
describe('Phase 5b publishers — skillsPaths surfaces >=1 SKILL.md (SMI-4843 / SMI-4860)', () => {
  // Explicit-skillsPaths entries — each row carries its own configured path.
  it.each([
    ['nextlevelbuilder', 'ui-ux-pro-max-skill', '.claude/skills', '.claude/skills/design/SKILL.md'],
    ['sleekdotdesign', 'agent-skills', 'skills', 'skills/design-mobile-apps/SKILL.md'],
    ['scrapegraphai', 'just-scrape', 'skills', 'skills/just-scrape/SKILL.md'],
    ['juliusbrussee', 'caveman', 'skills', 'skills/caveman/SKILL.md'],
    ['lllllllama', 'ai-paper-reproduction-skill', 'skills', 'skills/ai-research-explore/SKILL.md'],
    ['arvindrk', 'extract-design-system', 'skills', 'skills/extract-design-system/SKILL.md'],
    ['leonxlnx', 'taste-skill', 'skills', 'skills/taste-skill/SKILL.md'],
  ])(
    '%s/%s — configured skillsPaths ["%s"] matches a probed SKILL.md path',
    (owner, repo, expectedPath, sampleSkillMd) => {
      const entry = findAuthor(owner, repo)
      expect(entry.skillsPaths).toEqual([expectedPath])
      const regex = globToSkillMdRegex(expectedPath)
      expect(
        regex.test(sampleSkillMd),
        `${owner}/${repo}: skillsPaths ["${expectedPath}"] must surface ${sampleSkillMd}`
      ).toBe(true)
    }
  )

  // Flat repo-root entries — skillsPaths omitted so the default ['', 'skills']
  // root-scan reaches <skill-name>/SKILL.md. Mirrors the garrytan/gstack
  // convention; an explicit [''] would fail the non-empty-string invariant in
  // high-trust-authors.test.ts.
  it.each([
    ['squirrelscan', 'skills'],
    ['agentspace-so', 'agent-skills'],
    ['agentspace-so', 'runcomfy-agent-skills'],
    ['agentspace-so', 'skills'],
    ['currents-dev', 'playwright-best-practices-skill'],
  ])('%s/%s — flat layout: skillsPaths omitted (default root-scan)', (owner, repo) => {
    const entry = findAuthor(owner, repo)
    expect(
      entry.skillsPaths,
      `${owner}/${repo}: flat repo-root layout must omit skillsPaths so default ['', 'skills'] applies`
    ).toBeUndefined()
  })
})

describe('SMI-4962 round-N cross-ecosystem publishers — skillsPaths surfaces >=1 SKILL.md', () => {
  // skillsPaths probed against the live GitHub Trees API on 2026-05-19. Each
  // configured path is a non-default subdirectory, so the entry must carry an
  // explicit skillsPaths value scoped away from internal/asset directories
  // (openai/codex: codex-rs asset samples; bytedance/deer-flow: .agent/skills
  // smoke test).
  it.each([
    ['openai', 'codex', '.codex/skills', '.codex/skills/babysit-pr/SKILL.md'],
    ['bytedance', 'deer-flow', 'skills/public', 'skills/public/academic-paper-review/SKILL.md'],
  ])(
    '%s/%s — configured skillsPaths ["%s"] matches a probed SKILL.md path',
    (owner, repo, expectedPath, sampleSkillMd) => {
      const entry = findAuthor(owner, repo)
      expect(entry.skillsPaths).toEqual([expectedPath])
      const regex = globToSkillMdRegex(expectedPath)
      expect(
        regex.test(sampleSkillMd),
        `${owner}/${repo}: skillsPaths ["${expectedPath}"] must surface ${sampleSkillMd}`
      ).toBe(true)
    }
  )

  // NousResearch/hermes-agent — two-level layout under BOTH skills/ and
  // optional-skills/ (skills/<category>/<name>/SKILL.md), so each path is a
  // wildcard. plugins/google_meet (flat layout, 1 skill) is intentionally
  // excluded. Samples probed 2026-05-19.
  it('NousResearch/hermes-agent — wildcard skillsPaths surface both roots', () => {
    const entry = findAuthor('NousResearch', 'hermes-agent')
    expect(entry.skillsPaths).toEqual(['skills/*', 'optional-skills/*'])
    const cases: Array<[string, string]> = [
      ['skills/*', 'skills/apple/apple-notes/SKILL.md'],
      ['optional-skills/*', 'optional-skills/autonomous-ai-agents/blackbox/SKILL.md'],
    ]
    for (const [pattern, sampleSkillMd] of cases) {
      expect(
        globToSkillMdRegex(pattern).test(sampleSkillMd),
        `hermes-agent: skillsPaths ["${pattern}"] must surface ${sampleSkillMd}`
      ).toBe(true)
    }
  })
})

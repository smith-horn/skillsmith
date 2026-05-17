/**
 * SMI-4842: Tests for isMetaListRepo() — the conservative predicate that
 * excludes curated `awesome-*` link-list repos (no SKILL.md, README dominated
 * by external links) from being indexed as skills.
 */

import { describe, it, expect } from 'vitest'
import {
  isMetaListRepo,
  readmeLinkRatio,
  META_LIST_LINK_RATIO_THRESHOLD,
} from './meta-list-filter.js'

/**
 * A curated link-list README: 9 of 11 non-blank lines carry a markdown link
 * (ratio ~0.82, strictly above the 0.70 threshold). The heading and the one
 * intro line are the only non-link lines.
 */
const LINK_LIST_README = `# Awesome Claude Skills

A curated list of skills.

- [skill-one](https://github.com/foo/skill-one) does a thing
- [skill-two](https://github.com/foo/skill-two) does another thing
- [skill-three](https://github.com/foo/skill-three) yet another
- [skill-four](https://github.com/foo/skill-four) and one more
- [skill-five](https://github.com/foo/skill-five) five
- [skill-six](https://github.com/foo/skill-six) six
- [skill-seven](https://github.com/foo/skill-seven) seven
- [skill-eight](https://github.com/foo/skill-eight) eight
- [skill-nine](https://github.com/foo/skill-nine) nine
`

/** A README that is mostly prose with only an occasional link. */
const PROSE_README = `# Awesome Foo

This project does something genuinely useful. It is a real skill that
helps you accomplish a task. Here is a paragraph explaining how it works
and why you would want to use it in your own workflow.

Installation is straightforward and the configuration is minimal.

See the [docs](https://example.com/docs) for more detail.

It integrates cleanly with existing tooling and has no external dependencies.
`

describe('readmeLinkRatio', () => {
  it('returns 1.0 when every non-blank line contains a markdown link', () => {
    const readme = `- [a](https://x.com/a)
- [b](https://x.com/b)`
    expect(readmeLinkRatio(readme)).toBe(1)
  })

  it('returns 0 when no line contains a markdown link', () => {
    expect(readmeLinkRatio('just\nsome\nprose')).toBe(0)
  })

  it('ignores blank lines when computing the ratio', () => {
    const readme = `[a](https://x.com/a)

[b](https://x.com/b)`
    // 2 non-blank lines, both links → 1.0
    expect(readmeLinkRatio(readme)).toBe(1)
  })

  it('returns 0 for an empty README', () => {
    expect(readmeLinkRatio('')).toBe(0)
    expect(readmeLinkRatio('   \n  \n')).toBe(0)
  })
})

describe('isMetaListRepo: excluded (meta-list)', () => {
  it('excludes an awesome-* repo with no SKILL.md and a link-dominated README', () => {
    expect(
      isMetaListRepo({
        repoName: 'awesome-claude-skills',
        hasSkillMd: false,
        readme: LINK_LIST_README,
      })
    ).toBe(true)
  })

  it('excludes regardless of awesome-* casing', () => {
    expect(
      isMetaListRepo({
        repoName: 'Awesome-Claude-Code',
        hasSkillMd: false,
        readme: LINK_LIST_README,
      })
    ).toBe(true)
  })
})

describe('isMetaListRepo: NOT excluded (false-positive guards)', () => {
  it('does NOT exclude an awesome-* repo that HAS a SKILL.md', () => {
    expect(
      isMetaListRepo({
        repoName: 'awesome-foo',
        hasSkillMd: true,
        readme: LINK_LIST_README,
      })
    ).toBe(false)
  })

  it('does NOT exclude a normal skill repo (name does not match awesome-*)', () => {
    expect(
      isMetaListRepo({
        repoName: 'my-cool-skill',
        hasSkillMd: false,
        readme: LINK_LIST_README,
      })
    ).toBe(false)
  })

  it('does NOT exclude an awesome-* repo whose README is mostly prose', () => {
    expect(
      isMetaListRepo({
        repoName: 'awesome-foo',
        hasSkillMd: false,
        readme: PROSE_README,
      })
    ).toBe(false)
  })

  it('does NOT exclude a repo merely containing "awesome" mid-name', () => {
    // The name signal anchors `awesome-` as a prefix; "my-awesome-tool" is not a match.
    expect(
      isMetaListRepo({
        repoName: 'my-awesome-tool',
        hasSkillMd: false,
        readme: LINK_LIST_README,
      })
    ).toBe(false)
  })
})

describe('isMetaListRepo: link-ratio boundary at META_LIST_LINK_RATIO_THRESHOLD', () => {
  it('exposes a 0.7 threshold', () => {
    expect(META_LIST_LINK_RATIO_THRESHOLD).toBe(0.7)
  })

  it('does NOT exclude at exactly 70% link lines (threshold is strictly >)', () => {
    // 10 non-blank lines, exactly 7 with links → ratio 0.7, NOT > 0.7.
    const lines: string[] = []
    for (let i = 0; i < 7; i++) lines.push(`- [link${i}](https://x.com/${i})`)
    for (let i = 0; i < 3; i++) lines.push(`plain prose line ${i}`)
    const readme = lines.join('\n')
    expect(readmeLinkRatio(readme)).toBeCloseTo(0.7, 10)
    expect(isMetaListRepo({ repoName: 'awesome-foo', hasSkillMd: false, readme })).toBe(false)
  })

  it('excludes just above the 70% threshold (8 of 10 link lines)', () => {
    const lines: string[] = []
    for (let i = 0; i < 8; i++) lines.push(`- [link${i}](https://x.com/${i})`)
    for (let i = 0; i < 2; i++) lines.push(`plain prose line ${i}`)
    const readme = lines.join('\n')
    expect(readmeLinkRatio(readme)).toBeCloseTo(0.8, 10)
    expect(isMetaListRepo({ repoName: 'awesome-foo', hasSkillMd: false, readme })).toBe(true)
  })
})

describe('isMetaListRepo: empty README guard', () => {
  it('does NOT exclude an awesome-* repo with an empty README (link ratio 0)', () => {
    expect(isMetaListRepo({ repoName: 'awesome-foo', hasSkillMd: false, readme: '' })).toBe(false)
  })
})

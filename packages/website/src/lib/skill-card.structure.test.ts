/**
 * Structural (DOM-parse) assertions for renderSkillCard's card markup (SMI-5368).
 *
 * Split out of skill-card.test.ts to keep that file under the 500-line cap. These
 * use cheerio to prove the invariants a flat-string `.toContain()` cannot: the card
 * root is a <div> (not an <a>), there is exactly one stretched-link anchor (the
 * title), and no interactive element is nested inside that anchor.
 */

import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import type { WireSkill } from '../types/skills'
import { renderSkillCard } from './skill-card'

const FULL_SKILL: WireSkill = {
  id: 'acme/test-runner',
  name: 'Test Runner',
  author: 'acme',
  description: 'Runs your tests automatically',
  trust_tier: 'verified',
  stars: 1234,
  categories: ['testing'],
  version: '1.2.0',
  repo_url: 'https://github.com/x/y',
  compatibility: ['claude-code', 'cursor', 'copilot', 'windsurf', 'codex'],
  license: 'MIT',
  _orgMatch: 'acme',
}
const FULL_HREF = '/skills/acme%2Ftest-runner'

describe('renderSkillCard — card structure (stretched link, SMI-5368)', () => {
  it('renders a <div> card (not an <a>) with exactly one stretched-link anchor and no interactive element nested in it', () => {
    const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
    const $ = cheerio.load(html)
    // Top-level element is a <div>, NOT an <a> — the un-nested stretched-link card.
    const root = $('body').children().first()
    expect(root.is('div')).toBe(true)
    expect(root.is('a')).toBe(false)
    // Exactly one anchor (the title stretched link). A flat .toContain() can't prove
    // structure — only a real DOM parse can.
    expect($('a').length).toBe(1)
    // The +N more button is a SIBLING of the link, never a descendant of the anchor.
    expect($('a button').length).toBe(0)
  })

  it('the single anchor is the title link: wraps the name, carries the ::after overlay class, points at href', () => {
    const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
    const $ = cheerio.load(html)
    const anchor = $('a')
    expect(anchor.attr('href')).toBe(FULL_HREF)
    expect(anchor.text()).toBe('Test Runner')
    expect(anchor.attr('class') ?? '').toContain("after:content-['']")
    // The card div provides the focus-within affordance for keyboard users (Medium-6).
    const root = $('body').children().first()
    expect(root.attr('class') ?? '').toContain('focus-within:border-primary-500/50')
    // `relative` is required on the card to contain the stretched-link overlay.
    expect(root.attr('class') ?? '').toContain('relative')
  })

  it('"View source" stays a <span>, not an <a> (keeps the anchor count at one — Nit-9)', () => {
    const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
    const $ = cheerio.load(html)
    // FULL_SKILL has an https repo_url, so the View source row is present.
    expect($('span:contains("View source")').length).toBeGreaterThan(0)
    expect($('a:contains("View source")').length).toBe(0)
  })
})

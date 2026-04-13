import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  STATIC_FALLBACK_LASTMOD,
  computeFallback,
  getLastmodFor,
  loadBlogDates,
} from './sitemap-lastmod.mjs'

describe('sitemap-lastmod', () => {
  let tmp: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sitemap-lastmod-'))
    mkdirSync(join(tmp, 'blog'), { recursive: true })
    writeFileSync(
      join(tmp, 'blog', 'with-updated.md'),
      '---\ntitle: a\ndate: 2026-01-10\nupdated: 2026-03-01\n---\nbody'
    )
    writeFileSync(
      join(tmp, 'blog', 'with-date-only.md'),
      '---\ntitle: b\ndate: 2026-02-15\n---\nbody'
    )
    writeFileSync(join(tmp, 'blog', 'no-frontmatter.md'), 'no frontmatter here')
    writeFileSync(join(tmp, 'blog', 'bad-date.md'), '---\ndate: not-a-date\n---\nbody')
    writeFileSync(join(tmp, 'blog', 'skip.txt'), 'not markdown')
  })

  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  describe('loadBlogDates', () => {
    it('prefers updated over date', () => {
      const dates = loadBlogDates(join(tmp, 'blog'))
      expect(dates.get('with-updated')).toBe(new Date('2026-03-01').toISOString())
    })

    it('falls back to date when updated is missing', () => {
      const dates = loadBlogDates(join(tmp, 'blog'))
      expect(dates.get('with-date-only')).toBe(new Date('2026-02-15').toISOString())
    })

    it('skips files without frontmatter', () => {
      const dates = loadBlogDates(join(tmp, 'blog'))
      expect(dates.has('no-frontmatter')).toBe(false)
    })

    it('skips unparseable dates', () => {
      const dates = loadBlogDates(join(tmp, 'blog'))
      expect(dates.has('bad-date')).toBe(false)
    })

    it('ignores non-markdown files', () => {
      const dates = loadBlogDates(join(tmp, 'blog'))
      expect(dates.has('skip')).toBe(false)
    })

    it('returns empty Map for non-existent dir', () => {
      const dates = loadBlogDates(join(tmp, 'does-not-exist'))
      expect(dates.size).toBe(0)
    })
  })

  describe('computeFallback', () => {
    it('returns static fallback when Map is empty', () => {
      expect(computeFallback(new Map())).toBe(STATIC_FALLBACK_LASTMOD)
    })

    it('returns most-recent ISO date from non-empty Map', () => {
      const map = new Map([
        ['a', '2026-01-01T00:00:00.000Z'],
        ['b', '2026-03-15T00:00:00.000Z'],
        ['c', '2026-02-01T00:00:00.000Z'],
      ])
      expect(computeFallback(map)).toBe('2026-03-15T00:00:00.000Z')
    })
  })

  describe('getLastmodFor', () => {
    const blogDates = new Map([['post-a', '2026-03-01T00:00:00.000Z']])
    const fallback = '2026-04-01T00:00:00.000Z'

    it('returns blog date for matching /blog/:slug/ URL', () => {
      expect(getLastmodFor('/blog/post-a/', blogDates, fallback)).toBe('2026-03-01T00:00:00.000Z')
    })

    it('matches /blog/:slug without trailing slash', () => {
      expect(getLastmodFor('/blog/post-a', blogDates, fallback)).toBe('2026-03-01T00:00:00.000Z')
    })

    it('returns fallback for non-blog URL', () => {
      expect(getLastmodFor('/docs/cli/', blogDates, fallback)).toBe(fallback)
    })

    it('returns fallback for blog URL with unknown slug', () => {
      expect(getLastmodFor('/blog/unknown/', blogDates, fallback)).toBe(fallback)
    })

    it('returns fallback for blog index', () => {
      expect(getLastmodFor('/blog/', blogDates, fallback)).toBe(fallback)
    })
  })
})

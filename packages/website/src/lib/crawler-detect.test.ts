/**
 * crawler-detect.test.ts
 *
 * SMI-4401 Wave 2 — unit coverage for the crawler UA matcher used by the
 * `/skills` SSR branch (spec §4.1 A-SEO-2, §5.5 Path 1).
 *
 * The matcher must:
 *   - Positively match every UA listed in spec §4.1 A-SEO-2.
 *   - Negatively match representative human browsers (desktop + mobile).
 *   - Treat empty / null / undefined as non-crawler.
 *   - Be case-insensitive.
 */

import { describe, expect, it } from 'vitest'
import { isCrawlerUserAgent } from './crawler-detect'

describe('isCrawlerUserAgent — positive matches (spec §4.1 A-SEO-2)', () => {
  it('matches Googlebot/2.1 canonical desktop string', () => {
    expect(isCrawlerUserAgent('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true)
  })

  it('matches Googlebot-Image/1.0', () => {
    expect(isCrawlerUserAgent('Googlebot-Image/1.0')).toBe(true)
  })

  it('matches Googlebot-News', () => {
    expect(isCrawlerUserAgent('Googlebot-News')).toBe(true)
  })

  it('matches Googlebot-Video', () => {
    expect(isCrawlerUserAgent('Googlebot-Video/1.0')).toBe(true)
  })

  it('matches AdsBot-Google (spec list)', () => {
    expect(isCrawlerUserAgent('AdsBot-Google (+http://www.google.com/adsbot.html)')).toBe(true)
  })

  it('matches Bingbot/2.0', () => {
    expect(
      isCrawlerUserAgent('Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)')
    ).toBe(true)
  })

  it('matches DuckDuckBot/1.0', () => {
    expect(isCrawlerUserAgent('DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)')).toBe(
      true
    )
  })

  it('matches Yahoo Slurp', () => {
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)'
      )
    ).toBe(true)
  })

  it('matches facebookexternalhit/1.1', () => {
    expect(
      isCrawlerUserAgent(
        'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
      )
    ).toBe(true)
  })

  it('matches Twitterbot/1.0', () => {
    expect(isCrawlerUserAgent('Twitterbot/1.0')).toBe(true)
  })

  it('matches LinkedInBot/1.0', () => {
    expect(
      isCrawlerUserAgent(
        'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)'
      )
    ).toBe(true)
  })
})

describe('isCrawlerUserAgent — case insensitivity', () => {
  it('matches lowercase googlebot/2.1', () => {
    // Regex uses `/i` flag — lowercase, uppercase, mixed-case all match.
    expect(isCrawlerUserAgent('googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true)
  })

  it('matches UPPERCASE GOOGLEBOT', () => {
    expect(isCrawlerUserAgent('GOOGLEBOT/2.1')).toBe(true)
  })

  it('matches mixed-case bInGbOt', () => {
    expect(isCrawlerUserAgent('bInGbOt/2.0')).toBe(true)
  })
})

describe('isCrawlerUserAgent — negative matches (human browsers)', () => {
  it('does not match macOS Safari 16.1', () => {
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15'
      )
    ).toBe(false)
  })

  it('does not match desktop Chrome', () => {
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      )
    ).toBe(false)
  })

  it('does not match desktop Firefox', () => {
    expect(
      isCrawlerUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0')
    ).toBe(false)
  })

  it('does not match iPhone Safari', () => {
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
      )
    ).toBe(false)
  })

  it('does not match Android Chrome', () => {
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
      )
    ).toBe(false)
  })

  it('does not match Edge desktop', () => {
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'
      )
    ).toBe(false)
  })
})

describe('isCrawlerUserAgent — empty / missing input (non-crawler per contract)', () => {
  it('does not match an empty string', () => {
    expect(isCrawlerUserAgent('')).toBe(false)
  })

  it('does not match null', () => {
    expect(isCrawlerUserAgent(null)).toBe(false)
  })

  it('does not match undefined', () => {
    expect(isCrawlerUserAgent(undefined)).toBe(false)
  })
})

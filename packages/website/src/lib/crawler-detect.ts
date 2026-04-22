/**
 * crawler-detect.ts
 *
 * SMI-4401 Wave 2 — Search-engine / social-preview user-agent detection.
 *
 * Used by SSR branches that must preserve full HTML + JSON-LD for crawlers while
 * showing a soft sign-in overlay to anonymous humans (spec §4.1, §5.5).
 *
 * Regex list sourced from the canonical Wave 2 spec §4.1 A-SEO-2 and the parent plan's
 * crawler-aware gating block. Matches are case-insensitive.
 *
 * Sub-bot behavior (Googlebot-Image, Googlebot-News, Googlebot-Video, AdsBot-Google) is
 * treated identically to the parent Googlebot for Wave 2. Differentiated handling is
 * tracked in SMI-4413 (post-Wave-2 investigation).
 */

const CRAWLER_REGEX =
  /Googlebot|Googlebot-Image|Googlebot-News|Googlebot-Video|AdsBot-Google|Bingbot|DuckDuckBot|Slurp|facebookexternalhit|Twitterbot|LinkedInBot/i

/**
 * Returns true when the given user-agent string matches a known search-engine or
 * social-media crawler. Empty / null / undefined input is treated as non-crawler.
 */
export function isCrawlerUserAgent(ua: string | null | undefined): boolean {
  if (typeof ua !== 'string' || ua.length === 0) return false
  return CRAWLER_REGEX.test(ua)
}

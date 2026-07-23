/**
 * RSS feed for the Skillsmith public status page (SMI-5755, Wave 5).
 *
 * `export const prerender = false` is a deliberate deviation from the static
 * `blog/rss.xml.ts` precedent — incident data changes continuously and must
 * be served fresh per-request, not baked at build time.
 */
export const prerender = false

import rss from '@astrojs/rss'
import type { APIContext } from 'astro'
import { INCIDENT_STATUS_LABELS, type StatusIncident } from '../lib/status-vocab'
import { validateStatusPayload } from '../lib/status-client'

/** Keeps tab/LF/CR, strips other C0 control characters that are illegal raw in XML 1.0. */
// eslint-disable-next-line no-control-regex -- Intentional: stripping illegal raw XML control bytes
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g

function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS_RE, '')
}

/** XML-escapes text destined for a raw `customData` fragment (the <guid> element below). */
function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface FeedItem {
  title: string
  description: string
  pubDate: Date
  link: string
  customData: string
}

/**
 * FIX (Codex #12, merge-blocking): one item PER INCIDENT UPDATE (matching the
 * master plan's "RSS feed over incident_updates" wording), not one item per
 * incident using only its latest update.
 *
 * FIX (Codex #11, high): a stable, unique `<guid>` per item
 * (`${incident.id}:${update.posted_at}`) via `customData` (the installed
 * @astrojs/rss@4.0.19 has no first-class `guid` field on RSSFeedItem — only
 * `customData`, a raw XML fragment parsed and merged into the <item>,
 * verified empirically against the installed version). Emitted AFTER the
 * library's own auto-guid-from-link assignment in its item-building order,
 * so `Object.assign` overwrites it — confirmed empirically. An
 * invalid/unparseable `posted_at` is skipped rather than emitting
 * `Invalid Date`.
 */
function buildFeedItems(incidents: StatusIncident[]): FeedItem[] {
  const items: FeedItem[] = []
  // FIX (Codex #11, "duplicate-timestamp rule"): `${incident.id}:${posted_at}`
  // is unique across incidents but not guaranteed unique WITHIN one incident
  // if two updates share an identical posted_at string (clock/authoring-tool
  // granularity) — tracked per incident and disambiguated with a `:n` suffix
  // so no two items in the same feed ever share a <guid>.
  const guidSeenCounts = new Map<string, number>()

  for (const incident of incidents) {
    for (const update of incident.updates) {
      const pubDate = new Date(update.posted_at)
      if (Number.isNaN(pubDate.getTime())) continue // invalid posted_at — skip, don't emit "Invalid Date"

      const statusLabel = INCIDENT_STATUS_LABELS[update.status] ?? update.status
      const title = stripControlChars(`${incident.title} — ${statusLabel}`)
      const description = stripControlChars(update.message)
      const baseGuid = stripControlChars(`${incident.id}:${update.posted_at}`)
      const seenCount = guidSeenCounts.get(baseGuid) ?? 0
      guidSeenCounts.set(baseGuid, seenCount + 1)
      const guidValue = escapeXmlText(seenCount === 0 ? baseGuid : `${baseGuid}:${seenCount}`)

      items.push({
        title,
        description,
        pubDate,
        // trailingSlash:false (below) strips the trailing slash the library
        // would otherwise append AFTER the #incident-<id> hash fragment —
        // verified empirically against the installed @astrojs/rss version.
        link: `/status/#incident-${incident.id}`,
        customData: `<guid isPermaLink="false">${guidValue}</guid>`,
      })
    }
  }

  // RSS convention: newest first, across all incidents (not grouped by incident).
  items.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
  return items
}

const FEED_TITLE = 'Skillsmith Status'
const FEED_DESCRIPTION = 'Incident history and status updates for Skillsmith services.'

// FIX (high): resolved up front so `context.site` is never actually
// undefined at either rss() call site below — but this alone is NOT the
// backstop (astro's own `site` config could still be missing, and this is
// belt-and-suspenders, not a guarantee). See STATIC_FALLBACK_RSS_XML below
// for the true backstop that depends on neither `context.site` nor the
// rss() library at all.
const DEFAULT_SITE_URL = 'https://www.skillsmith.app'

/**
 * FIX (high): a hand-built, minimal, well-formed RSS/XML string that depends
 * on NOTHING — not `context.site`, not the `rss()` library, not any upstream
 * data. This is the true backstop: previously, the catch block's own
 * "empty feed" fallback called `rss(...)` completely unprotected — if THAT
 * call also threw (e.g. `context.site` genuinely undefined, or anything
 * inside the `rss()` library itself throwing for a reason unrelated to
 * fetch/parse/shape), the whole `GET` handler rejected uncaught, exactly the
 * outcome this design exists to prevent.
 */
const STATIC_FALLBACK_RSS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<rss version="2.0"><channel>' +
  `<title>${FEED_TITLE}</title>` +
  `<description>${FEED_DESCRIPTION}</description>` +
  `<link>${DEFAULT_SITE_URL}</link>` +
  '</channel></rss>'

function staticFallbackResponse(): Response {
  return new Response(STATIC_FALLBACK_RSS_XML, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function GET(context: APIContext): Promise<Response> {
  const site = context.site ?? new URL(DEFAULT_SITE_URL)

  // FIX (Codex #5, merge-blocking): the ENTIRE handler — fetch, JSON parse,
  // normalization, and the rss() call itself — is wrapped in one try/catch.
  // ANY failure at any stage falls through to the catch block's own fallback
  // feed rather than letting an exception escape as a generic error
  // response.
  try {
    const apiUrl = `${import.meta.env.PUBLIC_API_BASE_URL || 'https://api.skillsmith.app'}/functions/v1/status-public`
    const response = await fetch(apiUrl)
    if (!response.ok) throw new Error(`status-public HTTP ${response.status}`)

    const rawJson: unknown = await response.json()
    const validated = validateStatusPayload(rawJson)
    if (!validated) throw new Error('status-public: invalid payload shape')

    const items = buildFeedItems(validated.data.incidents)

    const rssResponse = await rss({
      title: FEED_TITLE,
      description: FEED_DESCRIPTION,
      site,
      trailingSlash: false,
      items,
    })
    return withNoSniffHeader(rssResponse)
  } catch {
    // FIX (high): the fallback path must be unable to throw, full stop — it
    // is now wrapped in its OWN try/catch. If the fallback rss() call also
    // throws, fall all the way back to the hardcoded static XML string
    // above rather than letting the handler reject uncaught.
    try {
      const emptyFeedResponse = await rss({
        title: FEED_TITLE,
        description: FEED_DESCRIPTION,
        site,
        trailingSlash: false,
        items: [],
      })
      return withNoSniffHeader(emptyFeedResponse)
    } catch {
      return staticFallbackResponse()
    }
  }
}

/**
 * Adds `X-Content-Type-Options: nosniff` (mirroring status-public's own
 * Wave-4 header) without disturbing whatever Content-Type the rss() library
 * itself sets — constructing a fresh Response with merged Headers is the
 * portable way to add a header across Astro/Vercel's Response implementation
 * (a directly-constructed Response's headers ARE mutable in practice, but a
 * fresh Response + merged Headers avoids relying on that across runtimes).
 */
async function withNoSniffHeader(response: Response): Promise<Response> {
  const body = await response.text()
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

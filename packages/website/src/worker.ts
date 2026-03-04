/**
 * Cloudflare Worker — Skillsmith Homepage A/B Traffic Split
 *
 * SMI-3019 / SMI-2695: Stateless edge Worker for 80/10/10 homepage A/B split.
 *
 * Responsibilities:
 *   - Intercepts requests to pathname '/' only; all other paths pass through
 *   - Reads `sk_ab_variant` cookie; assigns variant if absent using AB_HOME_WEIGHTS
 *   - Sets `sk_ab_variant` cookie (7-day, Domain=.skillsmith.app, SameSite=Lax, Secure) on fresh assignment
 *   - Forwards X-AB-Variant header to Vercel (consumed by Astro middleware)
 *   - No external API calls; no PII logged; latency target < 5ms
 *
 * Deployment:
 *   1. npx wrangler login
 *   2. npx wrangler deploy --env preview   (verify X-AB-Variant header in preview)
 *   3. npx wrangler deploy                 (production)
 *   4. Set AB_HOME_WEIGHTS via Cloudflare dashboard → Workers → skillsmith-homepage-ab
 *      → Settings → Variables
 *   5. Set Cloudflare Cache Rule: www.skillsmith.app/og-*.png → Cache Everything, Edge TTL 7 days
 *
 * Verify post-deploy:
 *   curl -v https://www.skillsmith.app/ 2>&1 | grep -i 'x-ab-variant\|sk_ab_variant'
 */

export interface Env {
  AB_HOME_WEIGHTS: string
}

const AB_COOKIE_NAME = 'sk_ab_variant'
const AB_COOKIE_MAX_AGE = 60 * 60 * 24 * 7 // 7 days
const DEFAULT_WEIGHTS: [number, number, number] = [80, 10, 10]
const VARIANTS = ['control', 'variant-a', 'variant-b'] as const
type Variant = (typeof VARIANTS)[number]

/**
 * Parse "80,10,10" into a validated weight triple.
 * Returns DEFAULT_WEIGHTS on any parse failure.
 */
function parseWeights(raw: string): [number, number, number] {
  const parts = raw.split(',').map((s) => Number(s.trim()))
  if (
    parts.length !== 3 ||
    parts.some((n) => isNaN(n) || n < 0) ||
    parts.reduce((a, b) => a + b, 0) !== 100
  ) {
    return [...DEFAULT_WEIGHTS]
  }
  return parts as [number, number, number]
}

/**
 * Assign a variant using cumulative threshold roll.
 */
function assignVariant(weights: [number, number, number]): Variant {
  const roll = Math.random() * 100
  let cumulative = 0
  for (let i = 0; i < VARIANTS.length; i++) {
    cumulative += weights[i]
    if (roll < cumulative) {
      return VARIANTS[i]
    }
  }
  return VARIANTS[0]
}

/**
 * Parse sk_ab_variant=[value] from the Cookie header.
 * Returns null if absent or not a valid variant.
 */
function parseCookieVariant(cookieHeader: string | null): Variant | null {
  if (!cookieHeader) return null
  const match = cookieHeader.match(/(?:^|;\s*)sk_ab_variant=([^;]+)/)
  if (!match) return null
  const value = match[1]
  return VARIANTS.includes(value as Variant) ? (value as Variant) : null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Pass non-homepage paths through unchanged
    if (url.pathname !== '/') {
      return fetch(request)
    }

    const cookieHeader = request.headers.get('Cookie')
    const existing = parseCookieVariant(cookieHeader)
    const weights = parseWeights(env.AB_HOME_WEIGHTS)
    const variant: Variant = existing ?? assignVariant(weights)

    // Forward with X-AB-Variant header (consumed by Astro middleware)
    const newHeaders = new Headers(request.headers)
    newHeaders.set('X-AB-Variant', variant)
    const forwardedRequest = new Request(request, { headers: newHeaders })

    const response = await fetch(forwardedRequest)
    const mutableResponse = new Response(response.body, response)

    // Set cookie only on fresh assignment (do not overwrite existing)
    if (!existing) {
      mutableResponse.headers.append(
        'Set-Cookie',
        `${AB_COOKIE_NAME}=${variant}; Max-Age=${AB_COOKIE_MAX_AGE}; Domain=.skillsmith.app; Path=/; SameSite=Lax; Secure`
      )
    }

    return mutableResponse
  },
}

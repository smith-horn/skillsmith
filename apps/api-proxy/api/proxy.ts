import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Dynamic proxy to Supabase
 * Reads SUPABASE_URL from environment to avoid hardcoding project URLs
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  const supabaseUrl = process.env.SUPABASE_URL

  if (!supabaseUrl) {
    return res.status(500).json({
      error: 'SUPABASE_URL environment variable not configured',
    })
  }

  const path = req.query.path as string
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' })
  }

  // SMI-4862 / CodeQL #97: SSRF hardening.
  //
  // The proxy joins user-supplied `path` to a fixed Supabase origin. We
  // resolve via the URL constructor then assert (a) origin equality and
  // (b) an allow-listed pathname prefix. Pre-parse we reject a set of
  // inputs that would otherwise survive (a)+(b) or confuse intermediaries:
  //
  //   - Leading `/` and any `:` prevent protocol-relative and absolute URLs.
  //   - Control chars [\x00-\x1f] prevent CRLF/NUL smuggling. Note: this
  //     regex matches literal bytes only; percent-encoded forms (%0d, %0a,
  //     %00) are caught by the explicit %00 / %0[dD] / %0[aA] check below.
  //   - `..` path segments (both literal `..` and semicolon-variant `..;`)
  //     are rejected. The URL constructor normalises plain `../` away (e.g.
  //     `functions/v1/../x` resolves to `/functions/x`), so post-resolution
  //     the prefix check already catches those. The `..;` variant is NOT
  //     normalised by the URL spec — it survives as a literal path segment —
  //     but some upstream servers (nginx, Java servlets) treat `..;/` as a
  //     traversal hop, so we reject it defensively pre-parse.
  //   - Percent-encoded NUL (%00) and CR/LF (%0d, %0a) bypass the literal
  //     byte check above and must be explicitly rejected.
  // eslint-disable-next-line no-control-regex -- intentional: reject literal control chars (CRLF, NUL, etc.)
  const hasControlChar = /[\x00-\x1f]/.test(path)
  const hasPctEncodedControl = /%0[0dDaA]/i.test(path)
  const hasDotSegment = /(^|\/)\.\.([/;]|$)/.test(path)
  if (
    path.startsWith('/') ||
    path.includes(':') ||
    hasControlChar ||
    hasPctEncodedControl ||
    hasDotSegment
  ) {
    return res.status(400).json({ error: 'Invalid path' })
  }

  let resolved: URL
  let baseOrigin: string
  try {
    resolved = new URL(path, supabaseUrl.replace(/\/$/, '') + '/')
    baseOrigin = new URL(supabaseUrl).origin
  } catch {
    return res.status(400).json({ error: 'Invalid path' })
  }

  const pathOk =
    resolved.pathname.startsWith('/functions/v1/') || resolved.pathname.startsWith('/rest/v1/')

  // origin equality + prefix allow-list are the primary SSRF defences.
  // The pathname cannot contain a literal '/../' after URL normalisation
  // (the constructor resolves dot-segments per RFC 3986), but we verify
  // origin + prefix as belt-and-suspenders after the pre-parse dot-segment
  // rejection above.
  if (resolved.origin !== baseOrigin || !pathOk) {
    return res.status(400).json({ error: 'Invalid path' })
  }

  const targetUrl = resolved.toString()

  try {
    // Forward the request to Supabase
    const headers: Record<string, string> = {}

    // Forward relevant headers
    const forwardHeaders = ['authorization', 'apikey', 'content-type', 'x-request-id']
    for (const header of forwardHeaders) {
      const value = req.headers[header]
      if (value && typeof value === 'string') {
        headers[header] = value
      }
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
    })

    // Forward response headers
    const responseHeaders = ['content-type', 'x-ratelimit-limit', 'x-ratelimit-remaining']
    for (const header of responseHeaders) {
      const value = response.headers.get(header)
      if (value) {
        res.setHeader(header, value)
      }
    }

    // Handle response based on content type
    const contentType = response.headers.get('content-type') || ''

    // Handle empty responses (204 No Content, etc.)
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return res.status(response.status).end()
    }

    // Handle JSON responses
    if (contentType.includes('application/json')) {
      const data = await response.json()
      return res.status(response.status).json(data)
    }

    // Handle non-JSON responses (text, html, etc.)
    const text = await response.text()
    res.setHeader('content-type', contentType || 'text/plain')
    return res.status(response.status).send(text)
  } catch (error) {
    console.error('Proxy error:', error)
    return res.status(502).json({
      error: 'Failed to proxy request to upstream',
    })
  }
}

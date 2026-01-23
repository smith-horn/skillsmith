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

  // Validate path to prevent path traversal attacks
  // Only allow known Supabase API prefixes
  const allowedPrefixes = ['functions/v1/', 'rest/v1/']
  const isValidPath = allowedPrefixes.some((prefix) => path.startsWith(prefix))

  if (!isValidPath || path.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' })
  }

  const targetUrl = `${supabaseUrl}/${path}`

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

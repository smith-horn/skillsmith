import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Dynamic proxy to Supabase
 * Reads SUPABASE_URL from environment to avoid hardcoding project URLs
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
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

    const data = await response.json()
    return res.status(response.status).json(data)
  } catch (error) {
    console.error('Proxy error:', error)
    return res.status(502).json({
      error: 'Failed to proxy request to upstream',
    })
  }
}

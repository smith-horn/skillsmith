/**
 * Skills Search API Route
 *
 * SMI-3016: SSR proxy to Skillsmith search API for index-v2.astro inline search.
 * Returns up to `limit` skills matching query `q`.
 */
export const prerender = false

import type { APIRoute } from 'astro'

export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get('q') ?? ''
  const limit = url.searchParams.get('limit') ?? '12'

  if (!q || q.length < 2) {
    return new Response(JSON.stringify({ skills: [] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const apiUrl = `https://api.skillsmith.app/v1/skills?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`

  try {
    const res = await fetch(apiUrl, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      return new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const data = (await res.json()) as { skills?: unknown[] }
    return new Response(JSON.stringify({ skills: data.skills ?? [] }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  } catch {
    return new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

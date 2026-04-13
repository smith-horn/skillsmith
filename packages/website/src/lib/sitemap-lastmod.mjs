import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Static fallback used when blog dir is missing/empty. Kept deterministic
// across builds so Google doesn't see per-build <lastmod> churn.
export const STATIC_FALLBACK_LASTMOD = '2026-04-13T00:00:00.000Z'

export function loadBlogDates(blogDir) {
  const map = new Map()
  if (!existsSync(blogDir)) return map
  for (const file of readdirSync(blogDir).filter((f) => f.endsWith('.md'))) {
    const src = readFileSync(join(blogDir, file), 'utf8')
    const match = src.match(/^---\n([\s\S]*?)\n---/)
    if (!match) continue
    const updated = match[1].match(/^updated:\s*(\S+)/m)?.[1]
    const date = match[1].match(/^date:\s*(\S+)/m)?.[1]
    const iso = updated || date
    if (iso) {
      const parsed = new Date(iso)
      if (!Number.isNaN(parsed.getTime())) {
        map.set(file.replace(/\.md$/, ''), parsed.toISOString())
      }
    }
  }
  return map
}

export function computeFallback(blogDates) {
  if (blogDates.size === 0) return STATIC_FALLBACK_LASTMOD
  const max = Math.max(...Array.from(blogDates.values()).map((d) => new Date(d).getTime()))
  return new Date(max).toISOString()
}

export function getLastmodFor(pathname, blogDates, fallback) {
  const m = pathname.match(/^\/blog\/([^/]+)\/?$/)
  return (m && blogDates.get(m[1])) || fallback
}

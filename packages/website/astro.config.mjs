import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import vercel from '@astrojs/vercel'
import tailwindcss from '@tailwindcss/vite'

// SMI-4184: sitemap lastmod for GSC Discovered-not-indexed.
// Build a slug → ISO date map from blog frontmatter (sync, at config eval).
// Non-blog pages get a fixed fallback so lastmod stays stable between builds
// (Google penalizes per-build churn).
const BLOG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'src/content/blog')
const BLOG_DATES = new Map()
for (const file of readdirSync(BLOG_DIR).filter((f) => f.endsWith('.md'))) {
  const src = readFileSync(join(BLOG_DIR, file), 'utf8')
  const match = src.match(/^---\n([\s\S]*?)\n---/)
  if (!match) continue
  const updated = match[1].match(/^updated:\s*(\S+)/m)?.[1]
  const date = match[1].match(/^date:\s*(\S+)/m)?.[1]
  const iso = updated || date
  if (iso) BLOG_DATES.set(file.replace(/\.md$/, ''), new Date(iso).toISOString())
}
const FALLBACK_LASTMOD = new Date(
  Math.max(...Array.from(BLOG_DATES.values()).map((d) => new Date(d).getTime()))
).toISOString()

// https://astro.build/config
export default defineConfig({
  site: 'https://www.skillsmith.app',

  integrations: [
    sitemap({
      serialize(item) {
        // Exclude private/auth/account pages and A/B test variants from sitemap.
        // Use pathname.startsWith() not includes() to avoid false positives (SMI-3077).
        // Also check exact match (no trailing slash) for redirect-only pages like /verify.
        const pathname = new URL(item.url).pathname
        const excluded = [
          '/account/',
          '/auth/',
          '/login/',
          '/signup/',
          '/verify/',
          '/index-v2/',
          '/index-v3/',
        ]
        if (excluded.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p))) {
          return undefined
        }

        // High-priority pages
        if (item.url === 'https://www.skillsmith.app/') {
          item.priority = 1.0
          item.changefreq = 'weekly'
        } else if (/\/(pricing|docs\/quickstart)\/?$/.test(item.url)) {
          item.priority = 0.9
          item.changefreq = 'monthly'
        } else if (/\/docs\/?/.test(item.url)) {
          item.priority = 0.8
          item.changefreq = 'monthly'
        } else if (/\/blog\/?$/.test(item.url)) {
          item.priority = 0.8
          item.changefreq = 'weekly'
        } else if (/\/blog\//.test(item.url)) {
          item.priority = 0.7
          item.changefreq = 'monthly'
        } else {
          item.priority = 0.5
          item.changefreq = 'monthly'
        }

        // SMI-4184: emit <lastmod> so GSC prioritizes crawl.
        // Blog posts → frontmatter `updated` or `date`; others → most-recent-post date.
        const blogMatch = pathname.match(/^\/blog\/([^/]+)\/?$/)
        const blogDate = blogMatch && BLOG_DATES.get(blogMatch[1])
        item.lastmod = blogDate || FALLBACK_LASTMOD

        return item
      },
    }),
  ],

  // Markdown configuration with Shiki syntax highlighting
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
      wrap: true,
    },
  },

  // Vercel adapter for hybrid rendering
  adapter: vercel(),

  // Build output configuration - static with SSR adapter for dynamic routes
  output: 'static',

  // TypeScript configuration
  typescript: {
    strict: true,
  },

  // Vite configuration for API proxy in development
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        '/api': {
          target: 'https://api.skillsmith.app',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    define: {
      'import.meta.env.PUBLIC_API_BASE_URL': JSON.stringify(
        process.env.PUBLIC_API_BASE_URL || 'https://api.skillsmith.app'
      ),
    },
  },

  // Image optimization
  // Cloudinary (res.cloudinary.com) intentionally excluded — its CDN handles
  // f_auto format negotiation, q_auto quality, and responsive sizing better
  // than Astro's local image service. Blog images pass through as-is.
  image: {
    domains: ['api.skillsmith.app', 'avatars.githubusercontent.com'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
    ],
  },

  // Prefetch configuration for better navigation
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },
})
